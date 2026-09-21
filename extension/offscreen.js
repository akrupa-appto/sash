// Offscreen document that owns the mic for voice dictation. Created on demand by background.js via
// chrome.offscreen.createDocument({reason: 'USER_MEDIA'}); torn down (stream stopped, document
// closed) as soon as a recording session ends so nothing is left listening in the background.
//
// Transcription runs here, not in the service worker, so raw audio never crosses a runtime message:
// only the resulting text (and partials) are sent back to background.js, which broadcasts it into
// `state` the same way every other agent event is broadcast.
import { defaultTranscriptionSpec, transcribe } from '../src/transcribe.ts';
import { configure, clearConfig } from './config.js';

let stream;
let recorder;
// The in-flight start while getUserMedia is still opening the mic. A start is not "done" until it has
// a recorder, and stop() must not answer (and so must not let the caller close this document) before
// then — see stop() below.
let startPromise;
let chunks = [];
let chunkMs;
let sessionSettings;
// Bumped every time a session ends (teardown). A chunk transcription captures the id it was
// enqueued under; if that no longer matches by the time the request resolves, the session it was
// for has since stopped or restarted, and the result is dropped rather than overwriting whatever
// state a newer session has written.
let sessionId = 0;
// Serializes chunk transcriptions so at most one transcribeBlob() call is ever in flight: each
// tick's work is appended here rather than fired independently, so results can't complete out of
// order or pile up as concurrent requests.
let chunkQueue = Promise.resolve();

function voiceSpec(settings) {
  // The user's own speech-to-text model wins; otherwise the chosen provider's default; otherwise
  // nothing, and transcribe() falls back to the planner's provider and its default model.
  if (settings?.transcriptionModel) return settings.transcriptionModel;
  return settings?.voiceProvider ? defaultTranscriptionSpec(settings.voiceProvider) : undefined;
}

function safeError(error, settings = sessionSettings || {}) {
  let text = String(error?.message || error || 'something went wrong');
  for (const key of [settings.openrouterKey, settings.typesafeKey, settings.openaiKey, settings.geminiKey, settings.customKey]) {
    if (key) text = text.split(key).join('[redacted]');
  }
  return text.slice(0, 12000);
}

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
  sessionSettings = undefined;
  sessionId++; // invalidate any chunk transcription still in flight (or queued) for this session
}

async function transcribeBlob(blob, settings = sessionSettings) {
  configure(settings || {});
  try {
    return await transcribe({ spec: voiceSpec(settings), audio: blob, mimeType: blob.type || 'audio/webm' });
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
      await chrome.runtime.sendMessage({ type: 'dictation:error', error: safeError(err) }).catch(() => {});
    }
  });
}

// Actually opens the mic and starts recording. Split out from start() so that the promise stop() waits
// on is the opening itself, not the (identical) wrapper call a second start would get back.
async function openMic(options = {}) {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickMimeType();
  chunks = [];
  chunkMs = Number.isFinite(options.chunkMs) && options.chunkMs > 0 ? options.chunkMs : undefined;
  sessionSettings = options.settings || {};
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.addEventListener('dataavailable', event => { void handleChunk(event.data, mimeType); });
  // A MediaRecorder error is terminal: the recorder stops itself. Release the mic immediately
  // rather than leaving a dead stream held open, and flag it fatal so background closes this
  // document too — unlike a single failed chunk transcription, which is not fatal to the session.
  recorder.addEventListener('error', event => {
    const settings = sessionSettings;
    const message = safeError(event.error || 'recording error', settings);
    teardown();
    void chrome.runtime.sendMessage({ type: 'dictation:error', error: message, fatal: true }).catch(() => {});
  });
  recorder.start(chunkMs);
  return { ok: true };
}

// Starts capture. `chunkMs` set = periodic-chunking mode (incremental partials via handleChunk);
// unset = record-until-stopped, whole utterance transcribed once on stop().
async function start(options = {}) {
  if (recorder) return { ok: true }; // a session is already running; idempotent
  if (startPromise) return startPromise; // a start is already opening the mic; it is this same session
  startPromise = openMic(options);
  try {
    return await startPromise;
  } finally {
    startPromise = undefined;
  }
}

// Stops capture, transcribes whatever was recorded since the last chunk boundary (or the whole
// clip, in record-until-stopped mode), tears the stream down, and returns the final transcript.
async function stop() {
  // Hold-to-talk has no minimum hold, so a stop can arrive while start() is still awaiting
  // getUserMedia. Answering it now and letting the caller close this document is what threw the
  // start's reply away: Chrome then rejected the caller's pending sendMessage with "A listener
  // indicated an asynchronous response by returning true, but the message channel closed before a
  // response was received". This reply is the caller's signal that the document is safe to close, so
  // wait for the mic to finish opening (or fail to) first.
  if (startPromise) await startPromise.catch(() => {});
  if (!recorder) return { text: '' };
  const mimeType = recorder.mimeType;
  const finished = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.stop();
  await finished;
  const finalChunks = chunks;
  const finalSettings = sessionSettings;
  teardown();
  if (!finalChunks.length) return { text: '' };
  try {
    const { text } = await transcribeBlob(new Blob(finalChunks, { type: mimeType }), finalSettings);
    return { text };
  } catch (err) {
    return { error: safeError(err, finalSettings) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'offscreen:start') {
    start(message).then(reply, err => reply({ error: safeError(err, message.settings) }));
    return true;
  }
  if (message?.type === 'offscreen:stop') {
    const settings = sessionSettings;
    stop().then(reply, err => reply({ error: safeError(err, settings) }));
    return true;
  }
  return false;
});
