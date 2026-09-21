// Voice dictation: the pure, chrome-free logic behind the three eagerness modes and the
// push-to-talk / double-tap-latch keyboard behaviour. Kept dependency-free (no chrome.*, no DOM) so
// it can be unit tested directly; background.js and panel.js are the only things that wire it to
// real chrome APIs and real key/pointer events.

// Catalog of the three eagerness modes the owner asked for, in the order they're offered. Every
// description is the literal truth about what this build does — see the "eager" entry: true
// mid-sentence streaming needs OpenAI Realtime or Gemini Live (see src/transcribe.ts), which this
// build does not implement, so "eager" acts on whole-chunk partials, not on every word. The mode is
// still real and still distinct from "prewarm" (it can act before speech ends at all), it is just
// chunk-grained rather than word-grained, and the UI must say so rather than imply otherwise.
export const VOICE_MODES = {
  dictate: {
    id: 'dictate',
    label: 'dictate',
    description: 'the transcript fills the composer when you stop talking. you press send.',
  },
  prewarm: {
    id: 'prewarm',
    label: 'prewarm (default)',
    description: 'the transcript streams into the composer live while you talk. sash starts as soon as you stop.',
  },
  eager: {
    id: 'eager',
    label: 'eager',
    description: 'sash can start acting before you finish the sentence, on the transcript so far. it acts in chunks every couple of seconds, not word by word — true mid-sentence streaming needs an OpenAI Realtime or Gemini Live connection this build does not have.',
  },
};
export const VOICE_MODE_ORDER = ['dictate', 'prewarm', 'eager'];

// Every mode needs whole-utterance (or periodic-chunk) transcription, which is exactly what
// transcribeCapability().canTranscribe already reports. There is currently no mode this build can
// offer on a provider that can't transcribe at all, so the set is all-or-nothing; kept as a function
// (not a static list) so a future provider-specific gap has one place to add a real distinction
// instead of a second, competing capability check growing somewhere else.
export function supportedVoiceModes(capability) {
  if (!capability?.canTranscribe) return [];
  return [...VOICE_MODE_ORDER];
}

// The mode to actually run with: the configured mode if the provider supports it, otherwise the
// first supported mode, otherwise undefined (voice is not usable at all). Never silently upgrades or
// downgrades a mode the UI didn't also disable — callers that show mode choices must use
// supportedVoiceModes() to decide what's selectable in the first place.
export function resolveVoiceMode(mode, capability) {
  const supported = supportedVoiceModes(capability);
  if (!supported.length) return undefined;
  return supported.includes(mode) ? mode : supported[0];
}

// Periodic re-transcription interval for prewarm/eager partials. "dictate" needs no chunking at
// all — nothing shows until the user stops talking — so it starts the recorder with no chunkMs
// (record-until-stopped mode; see extension/offscreen.js).
export const CHUNK_MS = 2500;
export function chunkMsFor(mode) {
  return mode === 'dictate' ? undefined : CHUNK_MS;
}

// "eager" acts on the first partial with enough words to be worth reacting to, not on every single
// chunk — the mid-sentence action is a one-time head start, not a rerun per chunk (only one task can
// run at a time; see agent.ts/background.js). This is the threshold that head start waits for.
export const EAGER_MIN_WORDS = 3;

// Pure decision for whether a transcript (partial or final) should trigger a run right now.
// `running`/`blocked` are what already gate the composer's own send button (extension/panel.js
// `controls()`) and the `run` message handler (extension/background.js `pickBlocking`) — voice must
// never be a way around either, so this refuses under exactly the same two conditions they do.
// `alreadyTriggered` stops "eager" (or a fallback at speech-end) from firing a second run for the
// same utterance once the first one is already under way.
export function shouldAutoRun({ mode, text, isFinal, running, blocked, alreadyTriggered }) {
  if (running || blocked || alreadyTriggered) return false;
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  if (mode === 'dictate') return false; // never auto-runs; the user always presses send
  if (mode === 'prewarm') return isFinal; // only once speech ends
  if (mode === 'eager') return isFinal || trimmed.split(/\s+/).length >= EAGER_MIN_WORDS;
  return false;
}

// --- push-to-talk (hold) with a double-tap latch, driven by real keydown/keyup ------------------
// This is the literal hold-to-talk state machine: the panel document's own keydown/keyup on a key
// that Chrome does NOT intercept as a commands-API shortcut (see extension/panel.js), so both edges
// reach it. `now` is injectable so tests can drive exact timings without real waits or Date mocking.
export const DEFAULT_DOUBLE_TAP_MS = 350;
export function createPushToTalk({ thresholdMs = DEFAULT_DOUBLE_TAP_MS, now = () => Date.now(), onStart, onStop, onLatchOn, onLatchOff } = {}) {
  let down = false;
  let latched = false;
  let lastUpAt = -Infinity; // never a "double tap" against a session that hasn't happened yet, even if now() is 0
  function keydown({ repeat } = {}) {
    if (repeat || down) return; // ignore OS key-repeat and a key that's already down
    down = true;
    if (latched) { latched = false; onLatchOff?.(); onStop?.(); return; } // a tap while latched ends hands-free
    const isDoubleTap = (now() - lastUpAt) <= thresholdMs;
    onStart?.();
    if (isDoubleTap) { latched = true; onLatchOn?.(); }
  }
  function keyup() {
    if (!down) return;
    down = false;
    lastUpAt = now();
    if (latched) return; // hands-free: releasing the key does not stop listening
    onStop?.();
  }
  // Called when a run actually starts (voice or otherwise): hands-free listening ends with the run,
  // per the owner's spec ("...until the key is tapped again or the run starts"), even if the key is
  // still physically down when that happens.
  function endLatch() {
    if (!latched) return;
    latched = false;
    onLatchOff?.();
    if (!down) onStop?.(); // if a key is still down, keyup() will stop it normally
  }
  return { keydown, keyup, endLatch, get latched() { return latched; }, get down() { return down; } };
}

// --- the global keyboard shortcut (extension/manifest.json "toggle-dictation") ------------------
// chrome.commands.onCommand only ever fires one "pressed" event per shortcut press — there is no
// matching release event Chrome will give an extension (see MDN / chrome.commands docs), so true
// hold-to-release is not expressible here the way it is for the panel's own keydown/keyup above.
// This is the necessary compromise: a single press toggles listening on, then off; a second press
// arriving quickly right after the first instead latches hands-free, the same way createPushToTalk's
// double-tap does. `fire()` is called once per command event.
export function createDictationToggle({ thresholdMs = DEFAULT_DOUBLE_TAP_MS, now = () => Date.now(), onStart, onStop, onLatchOn, onLatchOff } = {}) {
  let active = false;
  let latched = false;
  let lastFireAt = -Infinity; // never a "double tap" against a press that hasn't happened yet, even if now() is 0
  function stop() {
    active = false;
    const wasLatched = latched;
    latched = false;
    if (wasLatched) onLatchOff?.();
    onStop?.();
  }
  function fire() {
    const t = now();
    const isDoubleTap = (t - lastFireAt) <= thresholdMs;
    lastFireAt = t;
    if (!active) { active = true; onStart?.(); if (isDoubleTap) { latched = true; onLatchOn?.(); } return; }
    if (isDoubleTap && !latched) { latched = true; onLatchOn?.(); return; } // a fast second press latches instead of stopping
    stop(); // a slower press (or a tap while latched) ends the session
  }
  function endOnRunStart() { if (active) stop(); }
  // For a press whose onStart refused to actually open the mic (voice off, or no mode the
  // configured provider supports): fire() already optimistically set active=true before onStart's
  // async check could run, so this puts the toggle back to "nothing is listening" without calling
  // onStop — there was never a session for onStop to end.
  function cancelStart() { active = false; latched = false; }
  return { fire, endOnRunStart, cancelStart, get active() { return active; }, get latched() { return latched; } };
}
