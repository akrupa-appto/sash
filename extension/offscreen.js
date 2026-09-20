// Offscreen document that owns the mic for voice dictation. Created on demand by background.js via
// chrome.offscreen.createDocument({reason: 'USER_MEDIA'}); torn down (stream stopped, document
// closed) as soon as a recording session ends so nothing is left listening in the background.
//
// Transcription runs here, not in the service worker, so raw audio never crosses a runtime message:
// only the resulting text (and partials) are sent back to background.js, which broadcasts it into
// `state` the same way every other agent event is broadcast.
import { transcribe } from '../src/transcribe.ts';
import { readSettings } from './settings.js';
import { configure, clearConfig } from './config.js';

let stream;
let recorder;
let chunks = [];
let chunkMs;
// Bumped every time a session ends (teardown). A chunk transcription captures the id it was
// enqueued under; if that no longer matches by the time the request resolves, the session it was
// for has since stopped or restarted, and the result is dropped rather than overwriting whatever
// state a newer session has written.
let sessionId = 0;
// Serializes chunk transcriptions so at most one transcribeBlob() call is ever in flight: each
// tick's work is appended here rather than fired independently, so results can't complete out of
// order or pile up as concurrent requests.
let chunkQueue = Promise.resolve();

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(candidate)) return candidate;
  }
  return 'audio/webm';
}

function teardown() {
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = undefined;
  recorder = undefined;
  chunks = [];
  chunkMs = undefined;
  sessionId++; // invalidate any chunk transcription still in flight (or queued) for this session
}

async function transcribeBlob(blob) {
  const settings = await readSettings();
  configure(settings);
  try {
    return await transcribe({ audio: blob, mimeType: blob.type || 'audio/webm' });
  } finally {
    clearConfig();
  }
}

// Fired on every MediaRecorder timeslice when chunking is on. Transcribes the accumulated buffer
// (whole-chunk re-transcription of everything recorded so far, not a live stream) so a later stage
// can show growing partial text while the user is still speaking. Only the FIRST MediaRecorder
// timeslice carries the WebM/Opus container header (EBML, Segment, Tracks); every later chunk is
// bare Cluster data, which fails to decode (or returns empty/garbage text) sent alone — so this
// re-sends every chunk collected since the session started, same as stop() does for the final
// transcript, not just the newest one. Work is appended to chunkQueue so at most one transcription
// is ever in flight, and a session id captured at enqueue time lets a result that resolves after the
// session already stopped (or restarted) be dropped instead of overwriting a newer partial.
function handleChunk(data, mimeType) {
  if (!data || !data.size) return;
  chunks.push(data);
  if (!chunkMs) return; // record-until-stopped mode: no partials, just accumulate
  const session = sessionId;
  const snapshot = chunks.slice();
  chunkQueue = chunkQueue.then(async () => {
    if (session !== sessionId) return; // the session ended before this chunk's turn came up
    try {
      const { text } = await transcribeBlob(new Blob(snapshot, { type: mimeType }));
      if (session !== sessionId) return; // stopped/restarted while the request was in flight
      if (text) await chrome.runtime.sendMessage({ type: 'dictation:partial', text }).catch(() => {});
    } catch (err) {
      if (session !== sessionId) return;
      await chrome.runtime.sendMessage({ type: 'dictation:error', error: String(err?.message || err) }).catch(() => {});
    }
  });
}

// Starts capture. `chunkMs` set = periodic-chunking mode (incremental partials via handleChunk);
// unset = record-until-stopped, whole utterance transcribed once on stop().
async function start(options = {}) {
  if (recorder) return { ok: true }; // a session is already running; idempotent
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType();
  chunks = [];
  chunkMs = Number.isFinite(options.chunkMs) && options.chunkMs > 0 ? options.chunkMs : undefined;
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.addEventListener('dataavailable', event => { void handleChunk(event.data, mimeType); });
  // A MediaRecorder error is terminal: the recorder stops itself. Release the mic immediately
  // rather than leaving a dead stream held open, and flag it fatal so background closes this
  // document too — unlike a single failed chunk transcription, which is not fatal to the session.
  recorder.addEventListener('error', event => {
    const message = String(event.error?.message || event.error || 'recording error');
    teardown();
    void chrome.runtime.sendMessage({ type: 'dictation:error', error: message, fatal: true }).catch(() => {});
  });
  recorder.start(chunkMs);
  return { ok: true };
}

// Stops capture, transcribes whatever was recorded since the last chunk boundary (or the whole
// clip, in record-until-stopped mode), tears the stream down, and returns the final transcript.
async function stop() {
  if (!recorder) return { text: '' };
  const mimeType = recorder.mimeType;
  const finished = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.stop();
  await finished;
  const finalChunks = chunks;
  teardown();
  if (!finalChunks.length) return { text: '' };
  try {
    const { text } = await transcribeBlob(new Blob(finalChunks, { type: mimeType }));
    return { text };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'offscreen:start') {
    start(message).then(reply, err => reply({ error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === 'offscreen:stop') {
    stop().then(reply, err => reply({ error: String(err?.message || err) }));
    return true;
  }
  return false;
});
