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
// getUserMedia is the one slow step in start() (a real mic open, or Chrome's first prompt), so the
// tests below can park it: `mediaGate` holds it open, `mediaError` makes it fail.
let mediaGate;
let mediaError;
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    getUserMedia: async () => {
      if (mediaGate) await mediaGate;
      if (mediaError) throw mediaError;
      return { getTracks: () => [{ stop: () => {} }] };
    },
  },
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
  // Stands in for the real table (src/transcribe.ts DEFAULT_MODEL) so the wiring below can be driven
  // deterministically; the real values are asserted against the real module in transcribe.test.mjs.
  defaultTranscriptionSpec: provider => ({
    openrouter: 'openai/gpt-transcribe',
    openai: 'openai:gpt-transcribe',
    gemini: 'gemini:gemini-3.5-transcribe',
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
  assert.deepEqual(specs, ['openai:gpt-transcribe'], 'the explicit voice provider selects its default transcription model');

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

// The quick-tap race: hold-to-talk has no minimum hold, so stop() can arrive while start() is still
// awaiting getUserMedia. Answering that stop there and letting background close this document is what
// threw away the start's own reply — Chrome then rejected the caller's pending sendMessage with "A
// listener indicated an asynchronous response by returning true, but the message channel closed
// before a response was received". The stop has to wait for the start it overlaps.
test('a stop that arrives before start() has a recorder waits for the start instead of dropping its reply', async () => {
  calls = [];
  specs = [];
  resolvers.length = 0;
  sent.length = 0;
  globalThis.__lastRecorder = undefined;
  let release;
  mediaGate = new Promise(resolve => { release = resolve; });
  const startPromise = send({ type: 'offscreen:start', chunkMs: 4000 });
  const stopPromise = send({ type: 'offscreen:stop' });
  let stopAnswered = false;
  void stopPromise.then(() => { stopAnswered = true; });
  try {
    await flush(); await flush();
    // Nothing may answer yet: closing the document now is exactly how the start's promised reply got
    // lost. (Before the fix the stop answered immediately, with { text: '' }.)
    assert.equal(stopAnswered, false, 'stop must not answer while the start it overlaps still owes its reply');
    assert.equal(globalThis.__lastRecorder, undefined, 'no recorder exists yet, so there is nothing to stop');

    release();
    assert.deepEqual(await startPromise, { ok: true }, 'the start still answers, even though a stop followed it');
    assert.deepEqual(await stopPromise, { text: '' }, 'and then the stop answers, with nothing recorded');
  } finally {
    mediaGate = undefined;
    release();
    await Promise.allSettled([startPromise, stopPromise]);
    await send({ type: 'offscreen:stop' }).catch(() => {}); // never leave the next test a recorder this one opened
  }
});

// The same overlap, where the mic never opened at all (getUserMedia rejects). Both messages must still
// get an answer — the start its error, the stop an empty success — so the caller is never left with a
// rejected channel it cannot explain.
test('a stop before a start that never produced a recorder still answers, and the start still answers', async () => {
  calls = [];
  specs = [];
  resolvers.length = 0;
  sent.length = 0;
  globalThis.__lastRecorder = undefined;
  let release;
  mediaGate = new Promise(resolve => { release = resolve; });
  mediaError = new Error('NotAllowedError: Permission dismissed');
  const startPromise = send({ type: 'offscreen:start' });
  const stopPromise = send({ type: 'offscreen:stop' });
  let stopAnswered = false;
  void stopPromise.then(() => { stopAnswered = true; });
  try {
    await flush(); await flush();
    assert.equal(stopAnswered, false,
      'stop waits for the start that is still opening the mic, even if that start will fail');
    release();
    assert.deepEqual(await startPromise, { error: 'NotAllowedError: Permission dismissed' });
    assert.deepEqual(await stopPromise, { text: '' }, 'no recorder ever existed, so stop has nothing to release');
    assert.equal(globalThis.__lastRecorder, undefined);
  } finally {
    mediaGate = undefined;
    mediaError = undefined;
    release();
    await Promise.allSettled([startPromise, stopPromise]);
    await send({ type: 'offscreen:stop' }).catch(() => {});
  }
});
