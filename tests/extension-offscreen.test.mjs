import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Stands in for a real MediaRecorder: the test drives it directly (fireData/stop) instead of
// waiting on real microphone timing.
class FakeRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = opts?.mimeType;
    this.listeners = {};
    globalThis.__lastRecorder = this;
  }
  addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
  start(chunkMs) { this.chunkMs = chunkMs; }
  stop() { this._fire('stop'); }
  fireData(data) { this._fire('dataavailable', { data }); }
  _fire(type, evt) { for (const cb of (this.listeners[type] || [])) cb(evt); }
}
FakeRecorder.isTypeSupported = () => true;
globalThis.MediaRecorder = FakeRecorder;
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  configurable: true,
});

const sent = [];
const events = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), fire: (...args) => [...listeners].map(f => f(...args)) };
};
globalThis.chrome = {
  runtime: {
    id: 'test-extension',
    onMessage: events(),
    sendMessage: async message => { sent.push(structuredClone(message)); },
  },
};

// Controllable transcribe(): every call parks a resolver instead of finishing immediately, so tests
// can control exactly when a transcription completes and assert what was in flight at any one time.
// Called both by the chunked-partial path (offscreen.js's handleChunk) and by stop()'s own
// final-transcript call, same as the real transcribe.ts export.
let calls;
let specs;
const resolvers = [];
mock.module('../src/transcribe.ts', { namedExports: {
  defaultTranscriptionSpec: provider => ({
    openrouter: 'openai/whisper-1',
    openai: 'openai:whisper-1',
    gemini: 'gemini:gemini-2.5-flash',
    custom: 'custom:whisper-1',
  })[provider],
  transcribe: async req => {
    const text = await req.audio.text();
    calls.push(text);
    specs.push(req.spec);
    return new Promise((resolve, reject) => resolvers.push({ resolve, reject, text }));
  },
} });
mock.module('../extension/config.js', { namedExports: { configure: () => {}, clearConfig: () => {} } });

await import('../extension/offscreen.js');
const send = message => new Promise(resolve => chrome.runtime.onMessage.fire(message, {}, resolve));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const resolveNext = async result => { await flush(); const r = resolvers.shift(); assert.ok(r, 'expected a pending transcribe() call'); r.resolve(result); await flush(); };
const rejectNext = async error => { await flush(); const r = resolvers.shift(); assert.ok(r, 'expected a pending transcribe() call'); r.reject(error); await flush(); };

test('the chunked path transcribes the accumulated buffer, not a lone headerless chunk', async () => {
  calls = [];
  specs = [];
  resolvers.length = 0;
  sent.length = 0;
  const startReply = await send({ type: 'offscreen:start', chunkMs: 4000, settings: { voiceProvider: 'openai' } });
  assert.equal(startReply.ok, true);
  const recorder = globalThis.__lastRecorder;

  recorder.fireData(new Blob(['A']));
  await resolveNext({ text: 'a' });
  assert.deepEqual(calls, ['A'], 'the first chunk alone is the whole buffer so far');
  assert.deepEqual(specs, ['openai:whisper-1'], 'the explicit voice provider selects its real default transcription model');

  recorder.fireData(new Blob(['B']));
  await resolveNext({ text: 'ab' });
  // The bug sent only the newest slice ("B") alone, which has no WebM/Opus container header past
  // the first chunk. The fix must re-send everything accumulated since the session started.
  assert.deepEqual(calls, ['A', 'AB'], 'the second transcription resends the whole accumulated buffer, not just the new slice');

  const stopPromise = send({ type: 'offscreen:stop' }); // stop() transcribes the final accumulated buffer too
  await resolveNext({ text: 'final' });
  await stopPromise;
});

test('at most one chunk transcription is in flight at a time', async () => {
  calls = [];
  specs = [];
  resolvers.length = 0;
  sent.length = 0;
  await send({ type: 'offscreen:start', chunkMs: 4000 });
  const recorder = globalThis.__lastRecorder;

  recorder.fireData(new Blob(['A']));
  recorder.fireData(new Blob(['B']));
  recorder.fireData(new Blob(['C']));
  await flush();
  // Three chunks landed near-instantly, but only the first transcription may have started: the
  // rest queue behind it instead of firing as concurrent requests.
  assert.equal(calls.length, 1, 'later chunks wait for the in-flight transcription instead of firing concurrently');
  assert.equal(resolvers.length, 1);

  await resolveNext({ text: 'a' });
  assert.equal(calls.length, 2, 'the next queued chunk starts only once the first finishes');
  await resolveNext({ text: 'ab' });
  assert.equal(calls.length, 3);
  await resolveNext({ text: 'abc' });

  const stopPromise = send({ type: 'offscreen:stop' });
  await resolveNext({ text: 'final' });
  await stopPromise;
});

test('a late-arriving partial from a stopped session is ignored', async () => {
  calls = [];
  specs = [];
  resolvers.length = 0;
  sent.length = 0;
  await send({ type: 'offscreen:start', chunkMs: 4000 });
  const recorder = globalThis.__lastRecorder;

  recorder.fireData(new Blob(['A']));
  await flush();
  assert.equal(resolvers.length, 1, 'the chunk transcription for this session is in flight');
  const staleChunkResolver = resolvers.shift();

  // The session ends (offscreen:stop tears everything down, bumping the session id) before that
  // in-flight chunk transcription resolves. stop() makes its own final-transcript request for
  // whatever was accumulated; resolve that separately to let the stop() call complete.
  const stopPromise = send({ type: 'offscreen:stop' });
  await flush();
  assert.equal(resolvers.length, 1, 'stop() started its own final-transcript request');
  resolvers.shift().resolve({ text: 'buy oat milk' });
  const stopReply = await stopPromise;
  assert.equal(stopReply.text, 'buy oat milk');

  sent.length = 0;
  staleChunkResolver.resolve({ text: 'late partial for a session that already ended' });
  await flush();
  assert.equal(sent.filter(m => m.type === 'dictation:partial').length, 0, 'a result for an already-ended session must not be broadcast as a partial');
  assert.equal(sent.filter(m => m.type === 'dictation:error').length, 0, 'nor as an error');
});

test('a final error is redacted with the captured session settings after teardown', async () => {
  calls = [];
  specs = [];
  resolvers.length = 0;
  sent.length = 0;
  await send({ type: 'offscreen:start', settings: { voiceProvider: 'openai', openaiKey: 'session-secret' } });
  globalThis.__lastRecorder.fireData(new Blob(['audio']));

  const stopPromise = send({ type: 'offscreen:stop' });
  await rejectNext(new Error('provider echoed session-secret'));
  const reply = await stopPromise;
  assert.equal(reply.error, 'provider echoed [redacted]');
  assert.doesNotMatch(reply.error, /session-secret/);
});
