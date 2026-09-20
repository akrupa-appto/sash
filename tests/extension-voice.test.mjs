import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_MODE_ORDER, supportedVoiceModes, resolveVoiceMode, shouldAutoRun, chunkMsFor, CHUNK_MS,
  createPushToTalk, createDictationToggle, DEFAULT_DOUBLE_TAP_MS,
} from '../extension/voice.js';

// --- capability gating: no mode is ever offered on a provider that can't transcribe at all -------
test('no provider configured offers no modes at all', () => {
  assert.deepEqual(supportedVoiceModes({ canTranscribe: false }), []);
  assert.equal(resolveVoiceMode('eager', { canTranscribe: false }), undefined);
});
test('a transcribe-capable provider offers all three modes, in order', () => {
  assert.deepEqual(supportedVoiceModes({ canTranscribe: true, streaming: false }), VOICE_MODE_ORDER);
});
test('resolveVoiceMode falls back to the first supported mode instead of an unsupported one', () => {
  assert.equal(resolveVoiceMode('bogus-mode', { canTranscribe: true }), 'dictate');
  assert.equal(resolveVoiceMode('eager', { canTranscribe: true }), 'eager', 'a supported mode passes through unchanged');
});
test('chunkMsFor: dictate records until stopped (no chunking); prewarm/eager chunk periodically', () => {
  assert.equal(chunkMsFor('dictate'), undefined);
  assert.equal(chunkMsFor('prewarm'), CHUNK_MS);
  assert.equal(chunkMsFor('eager'), CHUNK_MS);
});

// --- each eagerness mode does its own, distinct thing ---------------------------------------------
test('dictate never auto-runs, on a partial or on the final transcript', () => {
  assert.equal(shouldAutoRun({ mode: 'dictate', text: 'buy oat milk', isFinal: false }), false);
  assert.equal(shouldAutoRun({ mode: 'dictate', text: 'buy oat milk', isFinal: true }), false);
});
test('prewarm only auto-runs once speech has ended, never on a partial', () => {
  assert.equal(shouldAutoRun({ mode: 'prewarm', text: 'buy oat milk please', isFinal: false }), false);
  assert.equal(shouldAutoRun({ mode: 'prewarm', text: 'buy oat milk', isFinal: true }), true);
});
test('eager can auto-run on a partial once it has enough words, before speech ends', () => {
  assert.equal(shouldAutoRun({ mode: 'eager', text: 'buy', isFinal: false }), false, 'one word is not enough of a head start yet');
  assert.equal(shouldAutoRun({ mode: 'eager', text: 'buy oat milk', isFinal: false }), true, 'three words crosses the threshold mid-utterance');
  assert.equal(shouldAutoRun({ mode: 'eager', text: 'go', isFinal: true }), true, 'the final transcript is always enough, even under the word threshold');
});
test('an empty or blank transcript never auto-runs in any mode', () => {
  for (const mode of VOICE_MODE_ORDER) {
    assert.equal(shouldAutoRun({ mode, text: '', isFinal: true }), false);
    assert.equal(shouldAutoRun({ mode, text: '   ', isFinal: true }), false);
  }
});
test('voice cannot start a run while a request is pending, or while one is already running', () => {
  assert.equal(shouldAutoRun({ mode: 'prewarm', text: 'go', isFinal: true, blocked: true }), false);
  assert.equal(shouldAutoRun({ mode: 'eager', text: 'buy oat milk', isFinal: false, running: true }), false);
  assert.equal(shouldAutoRun({ mode: 'eager', text: 'buy oat milk', isFinal: false, alreadyTriggered: true }), false, 'eager fires once per utterance, not once per chunk');
});

// --- push-to-talk (hold) with a double-tap latch ---------------------------------------------------
test('a single hold starts on keydown and stops on keyup, without latching', () => {
  const events = [];
  const ptt = createPushToTalk({ now: () => 1000, onStart: () => events.push('start'), onStop: () => events.push('stop'), onLatchOn: () => events.push('latch-on') });
  ptt.keydown({});
  assert.deepEqual(events, ['start']);
  ptt.keyup();
  assert.deepEqual(events, ['start', 'stop']);
  assert.equal(ptt.latched, false);
});
test('OS key-repeat while held does not restart listening', () => {
  const events = [];
  const ptt = createPushToTalk({ now: () => 1000, onStart: () => events.push('start') });
  ptt.keydown({});
  ptt.keydown({ repeat: true });
  ptt.keydown({ repeat: true });
  assert.deepEqual(events, ['start']);
});
test('two presses within the threshold latch hands-free; two presses far apart do not', () => {
  let t = 0;
  const now = () => t;
  const fast = [];
  const ptt = createPushToTalk({ now, thresholdMs: DEFAULT_DOUBLE_TAP_MS, onStart: () => fast.push('start'), onStop: () => fast.push('stop'), onLatchOn: () => fast.push('latch-on') });
  t = 0; ptt.keydown({}); t = 60; ptt.keyup(); // first tap: a quick press-release
  t = 150; ptt.keydown({}); // second press, 90ms after the first release: inside the 350ms window
  assert.deepEqual(fast, ['start', 'stop', 'start', 'latch-on'], 'a fast double tap latches hands-free');
  assert.equal(ptt.latched, true);
  t = 400; ptt.keyup();
  assert.equal(ptt.latched, true, 'releasing the key while latched does not stop listening');

  t = 1000;
  const slow = [];
  const ptt2 = createPushToTalk({ now, onStart: () => slow.push('start'), onStop: () => slow.push('stop'), onLatchOn: () => slow.push('latch-on') });
  t = 1000; ptt2.keydown({}); t = 1050; ptt2.keyup();
  t = 1050 + DEFAULT_DOUBLE_TAP_MS + 50; ptt2.keydown({}); // arrives after the window closed
  assert.deepEqual(slow, ['start', 'stop', 'start'], 'a slow second press is an ordinary hold, not a latch');
  assert.equal(ptt2.latched, false);
});
test('a tap while latched ends hands-free listening', () => {
  let t = 0; const now = () => t;
  const events = [];
  const ptt = createPushToTalk({ now, onStart: () => events.push('start'), onStop: () => events.push('stop'), onLatchOn: () => events.push('latch-on'), onLatchOff: () => events.push('latch-off') });
  t = 0; ptt.keydown({}); t = 50; ptt.keyup();
  t = 100; ptt.keydown({}); // double tap -> latched
  assert.equal(ptt.latched, true);
  t = 150; ptt.keyup(); // releasing the second tap's key does not stop hands-free listening
  t = 900; ptt.keydown({}); // a later, plain tap while latched: this is what un-latches
  assert.equal(ptt.latched, false);
  assert.deepEqual(events, ['start', 'stop', 'start', 'latch-on', 'latch-off', 'stop']);
});
test('a run starting ends the latch even mid-press, and leaves keyup a no-op afterwards', () => {
  let t = 0; const now = () => t;
  const events = [];
  const ptt = createPushToTalk({ now, onStart: () => events.push('start'), onStop: () => events.push('stop'), onLatchOn: () => events.push('latch-on'), onLatchOff: () => events.push('latch-off') });
  t = 0; ptt.keydown({}); t = 50; ptt.keyup();
  t = 100; ptt.keydown({}); // latched, key still physically down (no keyup for this press yet)
  assert.equal(ptt.latched, true);
  ptt.endLatch();
  assert.equal(ptt.latched, false);
  // No 'stop' yet: the key is still down, so the eventual keyup() is what actually stops it.
  assert.deepEqual(events, ['start', 'stop', 'start', 'latch-on', 'latch-off']);
  t = 200; ptt.keyup();
  assert.deepEqual(events, ['start', 'stop', 'start', 'latch-on', 'latch-off', 'stop']);
});

// --- the global shortcut's toggle+latch (chrome.commands gives no release event to hold on) ------
test('a single command press toggles listening on, then off on the next press', () => {
  let t = 0; const now = () => t;
  const events = [];
  const toggle = createDictationToggle({ now, onStart: () => events.push('start'), onStop: () => events.push('stop') });
  t = 0; toggle.fire();
  assert.equal(toggle.active, true);
  t = 5000; toggle.fire(); // long after the double-tap window
  assert.equal(toggle.active, false);
  assert.deepEqual(events, ['start', 'stop']);
});
test('two quick presses latch hands-free instead of stopping', () => {
  let t = 0; const now = () => t;
  const events = [];
  const toggle = createDictationToggle({ now, onStart: () => events.push('start'), onStop: () => events.push('stop'), onLatchOn: () => events.push('latch-on'), onLatchOff: () => events.push('latch-off') });
  t = 0; toggle.fire();
  t = 200; toggle.fire(); // inside the window: latches, does not stop
  assert.equal(toggle.active, true);
  assert.equal(toggle.latched, true);
  assert.deepEqual(events, ['start', 'latch-on']);
  t = 5000; toggle.fire(); // any later press while latched ends the session
  assert.equal(toggle.active, false);
  assert.deepEqual(events, ['start', 'latch-on', 'latch-off', 'stop']);
});
test('cancelStart puts a refused press back to idle without emitting onStop', () => {
  let t = 0; const now = () => t;
  const events = [];
  const toggle = createDictationToggle({ now, onStart: () => events.push('start'), onStop: () => events.push('stop') });
  t = 0; toggle.fire(); // fire() optimistically marks active=true before an async onStart can refuse
  assert.equal(toggle.active, true);
  toggle.cancelStart(); // the async check inside onStart decided not to actually open the mic
  assert.equal(toggle.active, false);
  assert.equal(toggle.latched, false);
  assert.deepEqual(events, ['start'], 'no onStop: there was never a session for it to end');
  t = 100; toggle.fire(); // a fresh press afterwards behaves normally again
  assert.equal(toggle.active, true);
  assert.deepEqual(events, ['start', 'start']);
});
test('endOnRunStart stops an active session and clears its latch', () => {
  let t = 0; const now = () => t;
  const events = [];
  const toggle = createDictationToggle({ now, onStart: () => events.push('start'), onStop: () => events.push('stop'), onLatchOn: () => events.push('latch-on'), onLatchOff: () => events.push('latch-off') });
  t = 0; toggle.fire(); t = 100; toggle.fire(); // latched
  assert.equal(toggle.latched, true);
  toggle.endOnRunStart();
  assert.equal(toggle.active, false);
  assert.equal(toggle.latched, false);
  assert.deepEqual(events, ['start', 'latch-on', 'latch-off', 'stop']);
  events.length = 0;
  toggle.endOnRunStart(); // idempotent: nothing to end
  assert.deepEqual(events, []);
});
