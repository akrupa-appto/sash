import { runTask } from '../src/agent.ts';
import { defaultTranscriptionSpec, transcribeCapability } from '../src/transcribe.ts';
import { parseModel, PROVIDERS } from '../src/providers.ts';
import { ChromePage, setCursorSink, supportedUrl } from './browser.js';
import { configure, clearConfig } from './config.js';
import { ALL_SITES, ensureOriginAccess } from './permissions.js';
import { readSettings, validateSettings } from './settings.js';
import { BadgeState, RequestType } from './types.js';
import { ApprovalScope, declineAll, denialKey, grantKey, pickBlocking, RequestOutcome } from './requests.js';
import { chunkMsFor, createDictationToggle, resolveVoiceMode, shouldAutoRun } from './voice.js';
import * as lease from './lease.js';
import { Disposition, endRun, groupTab, markTab, releaseAll, resumeHandoffIfPresent, setFaviconRestorer } from './tabs.js';

// --- in-page feedback: favicon badges and the agent cursor -------------------------------------
// One entry per tab the run has touched. The badge doubles as an unread marker: a finished run's
// badge stays until the user actually looks at that tab, so it is cleared by activation and window
// focus, never by a timer. `observed` is "active tab in a focused window" and only gates painting
// the cursor; the position keeps being tracked for tabs nobody is watching.
const feedbackByTab = new Map();
const CLEARED_ON_VIEW = new Set([BadgeState.DELIVERABLE, BadgeState.HANDOFF]);
const feedback = tabId => feedbackByTab.get(tabId) || { badge: BadgeState.NONE, cursor: undefined, observed: false };
const contentState = tabId => { const { badge, cursor, observed } = feedback(tabId); return { badge, cursor, observed }; };
// feedbackByTab is in-memory only, so an idle-triggered service-worker restart would otherwise
// wipe every tab's badge/cursor/observed state (same failure mode as the run-state seq counter).
// Persist it alongside runState and restore it on startup, before anything reads feedbackByTab.
let savingFeedback = Promise.resolve();
function persistFeedback() {
  const copy = [...feedbackByTab];
  savingFeedback = savingFeedback.catch(() => {}).then(() => chrome.storage.local.set({ feedbackByTab: copy }));
  return savingFeedback;
}
// Never assume a previous injection survived a navigation: ping first. A script that does not
// answer is gone, and the copy Chrome injects next pulls this same state for itself.
async function pushFeedback(tabId) {
  const pong = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' }).catch(() => undefined);
  if (!pong?.ok) return false;
  await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_STATE', state: contentState(tabId) }).catch(() => {});
  return true;
}
// A tab that's already the active one in a focused window never fires onActivated/onFocusChanged
// again just because a run started touching it, so a brand-new entry defaulting to observed:false
// would leave the cursor unpainted on exactly the tab the user is watching. Check once, on creation.
async function isActiveTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return Boolean(win.focused);
  } catch { return false; }
}
async function setFeedback(tabId, patch) {
  if (!Number.isInteger(tabId)) return undefined;
  const existing = feedbackByTab.get(tabId);
  const base = existing || { badge: BadgeState.NONE, cursor: undefined, observed: await isActiveTab(tabId) };
  const next = { ...base, ...patch };
  feedbackByTab.set(tabId, next);
  void persistFeedback();
  await pushFeedback(tabId);
  return next;
}
/** The user looking at a tab is what marks its result read. */
async function viewed(tabId) {
  const held = feedbackByTab.get(tabId);
  if (!held) return;
  await setFeedback(tabId, { observed: true, badge: CLEARED_ON_VIEW.has(held.badge) ? BadgeState.NONE : held.badge });
}
async function unobserveOthers(exceptTabId) {
  for (const [id, held] of feedbackByTab) if (id !== exceptTabId && held.observed) await setFeedback(id, { observed: false });
}
chrome.tabs.onActivated.addListener(({ tabId }) => { void unobserveOthers(tabId).then(() => viewed(tabId)); });
chrome.windows.onFocusChanged.addListener(windowId => {
  void (async () => {
    // -1 is chrome.windows.WINDOW_ID_NONE: every window lost focus, so nothing is being looked at.
    if (windowId === -1) return unobserveOthers(undefined);
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab) return;
    await unobserveOthers(tab.id);
    await viewed(tab.id);
  })();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const held = feedbackByTab.get(tabId);
  if (!held) return;
  // A navigation takes the page out from under the cursor: its coordinates meant the old document,
  // and re-pushing them would paint a pointer over whatever the new page put there. The next
  // action's own `point()` moves it again. On a document load there is no push: the copy of
  // content.js on the leaving page is about to die anyway, and the one Chrome injects next pulls
  // this state itself. A URL change without a load (pushState, a hash route: `change.url` alone)
  // is a single-page app swapping its view under the same content script, so that copy survives
  // and has to be told to take the pointer down.
  if (held.cursor && (change.status === 'loading' || change.url)) {
    feedbackByTab.set(tabId, { ...held, cursor: undefined });
    void persistFeedback();
    if (change.status !== 'loading') void pushFeedback(tabId);
  }
  // A finished navigation means a fresh content script with no badge on it.
  if (change.status === 'complete') void pushFeedback(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => { if (feedbackByTab.delete(tabId)) void persistFeedback(); });
// The tab contract closes a tab it opened; the page's own favicon has to come back before it does,
// which is exactly what clearing this tab's feedback tells the content script to do.
setFaviconRestorer(tabId => setFeedback(tabId, { badge: BadgeState.NONE, cursor: undefined }));
// browser.js's point() drives this once per action with the viewport point the click is about to
// use; the record it gets back says whether the tab is observed, i.e. whether waiting for the
// tween is worth anything. It is the only sender of a cursor position.
setCursorSink((tabId, cursor) => setFeedback(tabId, { cursor }));

// --- voice dictation: offscreen document lifecycle --------------------------------------------
// getUserMedia does not reliably prompt from the side panel (Chrome cannot anchor the permission
// prompt there), so mic capture and transcription run in an offscreen document instead. It is
// created on demand and closed as soon as a session ends — never left running with a hot mic.
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('this build of Chrome does not support offscreen documents, needed for voice dictation');
  const existing = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'capture microphone audio for voice dictation, transcribed with the provider the user already configured',
  });
}
async function closeOffscreen() {
  if (!chrome.offscreen) return;
  await chrome.offscreen.closeDocument().catch(() => {});
}
// Tears an in-flight (or errored) dictation session down the same way an explicit
// 'dictation:stop' does: tell the offscreen document to stop capture, then close the document so
// no getUserMedia stream survives it. Any path that abandons a session — new chat, a stopped task,
// or the explicit stop button — must call this rather than dropping state.dictation on the floor,
// or the mic keeps recording with nothing left to reach it.
async function teardownDictation() {
  if (!state.dictation || state.dictation.status === 'idle') return;
  await chrome.runtime.sendMessage({ type: 'offscreen:stop' }).catch(() => {});
  await closeOffscreen();
  state.dictation = undefined;
}
// A first-run grant commonly needs one full-tab navigation before the offscreen document can reuse
// the permission (see extension/mic-permission.html); anything that looks like that denial opens it.
const NEEDS_PERMISSION_TAB = /permission|notallowed|dismissed/i;

let active;
let state = { running: false, messages: [], steps: [], status: 'ready', requests: [] };
let saving = Promise.resolve();
// Broadcasts can race (a stale in-flight 'run' broadcast landing after a later 'clear'),
// so panel.js uses this to drop any broadcast older than the last one it applied.
let seq = 0;

// --- voice dictation: eagerness modes and the global shortcut's hands-free latch ---------------
// transcribeCapability() reads its provider/key straight out of the shared `env` object that
// configure()/clearConfig() (extension/config.js) also drive the active run's own planner and Jev
// calls through (the esbuild alias in scripts/build-extension.mjs points transcribe.ts's "./env.ts"
// import at this same extension/config.js). clearConfig() wipes every key in that object, so this
// must never run while a run is mid-flight and depending on it staying configured — hence the
// `active` check up front instead of bracketing every caller with its own guard.
function voiceSpecFor(provider) {
  return provider ? defaultTranscriptionSpec(provider) : undefined;
}
// Offscreen documents only expose chrome.runtime, so the settings transcription needs have to
// travel with the command. Send only those: the key of the provider that will actually make the
// request, the custom endpoint when that is the provider, and the planner model that decides the
// provider when no voice provider is chosen. Fanning the whole settings object across leaves every
// other configured key — including the planner's — sitting in a second context for no reason.
function voiceSettingsFor(settings) {
  const chosen = PROVIDERS[settings.voiceProvider] ? settings.voiceProvider : '';
  const provider = chosen || parseModel(settings.model || '').provider;
  const keyField = { openrouter: 'openrouterKey', typesafe: 'typesafeKey', openai: 'openaiKey', gemini: 'geminiKey', custom: 'customKey' }[provider];
  const narrowed = { voiceProvider: chosen, model: settings.model };
  if (provider === 'typesafe') { narrowed.provider = 'typesafe'; narrowed.typesafeKey = settings.typesafeKey; }
  else if (keyField) narrowed[keyField] = settings[keyField];
  if (provider === 'custom') narrowed.customBaseUrl = settings.customBaseUrl;
  return narrowed;
}
// The last real capability this settings shape computed, so getState/the panel can keep showing an
// accurate "what can voice do" while a run is active instead of a blanket "not available right now"
// that would make the settings page look like the provider itself lost the ability to transcribe.
let lastVoiceCapability;
function voiceCapability(settings) {
  if (active) return lastVoiceCapability || { canTranscribe: false, streaming: false, reason: 'a task is already running' };
  configure(settings);
  try { return (lastVoiceCapability = transcribeCapability(voiceSpecFor(settings.voiceProvider))); }
  finally { clearConfig(); }
}
// Set once a session has already triggered a run (eager mid-utterance, or prewarm/eager at speech
// end), so a later partial or the final stop event for the same utterance can't trigger a second one.
// Reset on every dictation:start.
let dictationTriggered = false;
// Decides whether the transcript collected so far (or the final one) should start a run, and does
// it through the exact same 'run' message the composer's own submit uses (see the 'answer' handler
// a bit further down for the same recursive-handle pattern) — so it goes through the identical
// pending-request and already-running guards, and voice can never be a way around either.
async function maybeAutoRunFromDictation({ text, isFinal }) {
  // A settings read that fails cannot say whether voice is on, so it means the same thing as voice
  // being off: leave the transcript as plain dictation. It must not fail the stop that produced it.
  const settings = await readSettings().catch(() => undefined);
  if (!settings?.voiceEnabled) return;
  const capability = voiceCapability(settings);
  const eagerness = resolveVoiceMode(settings.voiceMode, capability);
  if (!shouldAutoRun({ mode: eagerness, text, isFinal, running: !!active, blocked: !!pickBlocking(state.requests || []), alreadyTriggered: dictationTriggered })) return;
  const goal = (text || '').trim();
  if (!goal) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab || !Number.isInteger(tab.id)) return;
  dictationTriggered = true;
  try {
    const reply = await handle({ type: 'run', tabId: tab.id, goal, mode: settings.mode });
    if (!reply?.ok) { dictationTriggered = false; return; }
    // The run starting ends hands-free listening, per the owner's spec, and the mic itself: nothing
    // is left recording while a task is under way. teardownDictation() only stops an actually-live
    // session (the "eager" mid-utterance case); the "prewarm"/"eager"-at-stop case already stopped
    // recording as part of dictation:stop itself, so state.dictation is cleared here either way
    // rather than left showing the transcript that just started this very run.
    dictationToggle.endOnRunStart();
    await teardownDictation();
    state.dictation = undefined;
    await persist();
  } catch { dictationTriggered = false; } // already running, a request pending, or no usable tab: leave the session alone as a plain dictate fallback
}
// The global keyboard shortcut (extension/manifest.json "toggle-dictation"). chrome.commands only
// ever fires one "pressed" event per press — there is no release event an extension can see — so
// true hold-to-release lives in the panel document's own keydown/keyup instead (extension/panel.js).
// This is the necessary compromise for a shortcut that works even when the panel isn't focused: one
// press toggles listening on, a second press toggles it off, and a second press arriving quickly
// right after the first latches hands-free instead (see voice.js createDictationToggle for the
// exact timing rule, shared with the panel's own double-tap).
const dictationToggle = createDictationToggle({
  onStart: () => { void (async () => {
    try {
      const settings = await readSettings();
      // fire() already optimistically marked the toggle active before this async check could run;
      // put it back to "nothing is listening" rather than opening a mic for a configuration that
      // was never asked for (voice off) or that this provider genuinely cannot transcribe with.
      if (!settings.voiceEnabled) { dictationToggle.cancelStart(); return; }
      const eagerness = resolveVoiceMode(settings.voiceMode, voiceCapability(settings));
      if (!eagerness) { dictationToggle.cancelStart(); return; }
      await handle({ type: 'dictation:start', chunkMs: chunkMsFor(eagerness) });
    } catch { /* surfaced to the user as state.dictation.status === 'error' already */ }
  })(); },
  onStop: () => { void handle({ type: 'dictation:stop' }).catch(() => {}); },
  onLatchOn: () => { state.dictation = { ...(state.dictation || {}), handsFree: true }; void persist(); },
  onLatchOff: () => { if (state.dictation) { state.dictation = { ...state.dictation, handsFree: false }; void persist(); } },
});
chrome.commands?.onCommand.addListener(command => { if (command === 'toggle-dictation') dictationToggle.fire(); });
// --- approval grants: the "conversation" and "always" scopes -----------------------------------
// "once" authorizes exactly the single action it was asked about and stores nothing.
// "conversation" lives on `state.grants` (keyed by grantKey), so it rides with runState and is
// wiped by 'clear' the same way the rest of the chat is, and never needs its own persistence path.
// "always" cannot live in runState — 'clear' replaces state wholesale and a fresh chat must not
// erase it — so it is its own top-level entry in chrome.storage.local, loaded into this in-memory
// copy at startup (surviving a service-worker restart the same way seq/feedbackByTab do) and
// written straight through on every change.
let persistentGrants = {};
// A concurrent "always" grant and a revoke can both fire before either's chrome.storage.local.set
// resolves; those writes are not guaranteed to land in the order they were issued, so the later
// logical write could be overwritten in storage by an earlier one finishing last. Chained the same
// way `saving`/`persist()` already serializes runState writes: each write reads persistentGrants only
// once its predecessor has actually completed, so storage always ends up matching the last call.
let savingGrants = Promise.resolve();
function persistGrants() {
  savingGrants = savingGrants.catch(() => {}).then(() => chrome.storage.local.set({ grants: persistentGrants }));
  return savingGrants;
}
const MAX_AUTO_APPROVALS = 20; // caps the grant-covered auto-resume loop in execute(); see its comment
function grantRecord(request, scope) {
  return { scope, type: request.type, action: request.action, origin: request.origin, question: request.question, grantedAt: Date.now() };
}
/** Does an existing grant (either scope) already cover this exact request? */
function isGranted(request) {
  const key = grantKey(request);
  if (!key) return false;
  return Boolean(state.grants?.[key] || persistentGrants[key]);
}
/** For a settings surface: every stored grant, always-scope first, each carrying its own key. */
function listGrants() {
  const always = Object.entries(persistentGrants).map(([key, grant]) => ({ key, ...grant }));
  const conversation = Object.entries(state.grants || {}).map(([key, grant]) => ({ key, ...grant }));
  return [...always, ...conversation];
}
async function revokeGrant(key) {
  if (!key) return false;
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(persistentGrants, key)) {
    const next = { ...persistentGrants };
    delete next[key];
    persistentGrants = next;
    await persistGrants();
    changed = true;
  }
  if (state.grants && Object.prototype.hasOwnProperty.call(state.grants, key)) {
    const next = { ...state.grants };
    delete next[key];
    state.grants = next;
    await persist();
    changed = true;
  }
  return changed;
}
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get(['runState', 'seq', 'feedbackByTab', 'grants']);
  // The service worker gets killed and restarted on idle while the panel stays open, so an
  // in-memory-only seq would reset to 0 and the panel's lastSeq guard would then drop every
  // broadcast (and the next getState reply) as "stale" forever. Restore it across restarts.
  if (typeof saved.seq === 'number') seq = saved.seq;
  // Badges survive a restart (they are unread markers), the cursor does not: it pointed at what a
  // run that died with the old worker was about to press. The content scripts on those tabs did
  // not restart with the worker, so the ones still drawing it are told to take it down.
  const stillPointing = [];
  if (Array.isArray(saved.feedbackByTab)) {
    for (const [tabId, entry] of saved.feedbackByTab) {
      if (entry?.cursor) stillPointing.push(tabId);
      feedbackByTab.set(tabId, { ...entry, cursor: undefined });
    }
  }
  if (stillPointing.length) { void persistFeedback(); for (const tabId of stillPointing) void pushFeedback(tabId); }
  if (saved.grants && typeof saved.grants === 'object') persistentGrants = saved.grants;
  if (saved.runState) state = { ...saved.runState, running: false };
  // Anything the old session was waiting on cannot be answered any more: say so rather than
  // leaving a card on screen that resolves to nothing.
  declinePending(RequestOutcome.EXPIRED);
  if (saved.runState?.running) {
    state.status = 'stopped';
    state.messages.push({ role: 'agent', text: 'the browser restarted, so the task stopped. send a task to continue.' });
    await persist();
  }
})();
function persist() {
  const copy = structuredClone(state);
  seq += 1;
  saving = saving.catch(() => {}).then(() => chrome.storage.local.set({ runState: copy, seq }));
  chrome.runtime.sendMessage({ type: 'state', state: copy, seq }).catch(() => {});
  return saving;
}
function safeError(error, settings = {}) {
  let text = String(error?.message || error || 'something went wrong');
  for (const key of [settings.openrouterKey, settings.typesafeKey, settings.openaiKey, settings.geminiKey, settings.customKey]) if (key) text = text.split(key).join('[redacted]');
  return text.slice(0, 12000);
}
// Chrome ended browser control on its own. Say what happened and what gets the task moving again.
export function detachMessage({ reason, title, url }) {
  const where = title ? `"${title}"` : 'the tab';
  const why = { canceled_by_user: "Chrome's control banner was cancelled", target_closed: 'the tab closed', replaced_with_devtools: 'DevTools opened on it' }[reason] || `Chrome reported "${reason}"`;
  // Sign-in pages only: "account" alone matches ordinary account settings pages.
  const login = /sign[ -]?in|log[ -]?in|login|\bsso\b|accounts\.google\.com|\/oauth|\/auth\b/i.test(`${title} ${url}`);
  const next = login && reason === 'target_closed'
    ? 'i cannot sign in for you. reopen the sign-in page, finish signing in yourself, then say "go on" and i will continue from there.'
    : login
      ? 'i cannot sign in for you. finish signing in on that page yourself, then say "go on" and i will continue from there.'
      : 'open the tab you want me to use and say "go on" to continue.';
  return `browser control of ${where} ended: ${why}. ${next}`;
}
// Unmute a tab only if our own lease says we're the one who muted it, and Chrome still
// agrees it was muted by an extension. Either check failing means someone else — the
// user, or another extension — is responsible for it, so we leave it alone.
async function unmuteIfOurs(tabId) {
  const held = lease.get(tabId);
  if (!held?.mutedByUs) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.mutedInfo?.reason === 'extension') await chrome.tabs.update(tabId, { muted: false }).catch(() => {});
  lease.setMuted(tabId, false);
}
// Mute every attached agent tab the user isn't currently watching, and unmute the one
// that is. Tabs already muted — by the user or another extension — are left untouched.
async function syncTabMute(pages, activeId) {
  for (const page of pages) {
    if (!page.attached) continue;
    if (page.tabId === activeId) { await unmuteIfOurs(page.tabId); continue; }
    const tab = await chrome.tabs.get(page.tabId).catch(() => undefined);
    if (!tab || tab.mutedInfo?.muted) continue;
    await chrome.tabs.update(page.tabId, { muted: true }).catch(() => {});
    lease.setMuted(page.tabId, true);
  }
}
// The service worker has no UI, so the panel shows the question and sends back the answer.
async function askForAccess(prompt) {
  const reply = await chrome.runtime.sendMessage({ type: 'permission', prompt }).catch(() => undefined);
  return reply?.allow === true;
}
// Is the every-site grant Chrome is holding really there? The stored settings say what the user
// chose (see settings.js siteAccessMode), not what Chrome has: revoking it in chrome://extensions
// leaves that stored 'all' behind. So the mode is only worth acting on next to this read, and a read
// that fails answers "no" -- an unreadable grant is never treated as a granted one.
const everySiteGranted = () => chrome.permissions.contains({ origins: ALL_SITES }).catch(() => false);
// The site-access gate the run passes before it touches a page. Mode 'all' with the grant really in
// hand is the one case with nothing to ask: the user already answered the every-site question from
// settings, so a second, narrower card would be a question Chrome has already settled. Everything
// else -- mode 'ask', or 'all' with the grant gone -- keeps the per-site path exactly as it was.
async function ensureSiteAccess(url, settings) {
  if (settings?.siteAccessMode === 'all' && await everySiteGranted()) return true;
  return ensureOriginAccess(url, askForAccess);
}
// A turn that ends "blocked" and one that ends "needs_input" are the same thing to the tab
// contract: the user has to act on that very tab next, so it is handed over rather than closed.
const waitingOnUser = status => status === 'blocked' || status === 'needs_input';
// Nothing may be left silently waiting. Every pending request gets an explicit decline, and each
// one counts towards the denial tally that stops the agent asking the same thing forever.
function declinePending(reason = 'stopped') {
  const pending = state.requests || [];
  if (!pending.length) return [];
  const declined = declineAll(pending, reason);
  // Only a real refusal counts towards the cutoff: a new chat or a restarted worker is not the
  // user saying no.
  if (reason === RequestOutcome.DECLINED || reason === 'stopped') {
    const denials = { ...(state.denials || {}) };
    for (const request of pending) { const key = denialKey(request); denials[key] = (denials[key] ?? 0) + 1; }
    state.denials = denials;
  }
  state.declined = declined;
  state.requests = [];
  // Nothing left to resume: the guards it carried die with the request it was raised for.
  state.resumeState = undefined;
  return declined;
}
// Fill the handed-back form on the real page. The values pass straight through: they are never
// written to state, persisted, logged, or handed to the agent, which verifies from the page after.
async function submitCredentials(request, values) {
  if (!Number.isInteger(state.tabId)) return RequestOutcome.UNAVAILABLE;
  const { snapshot, typeText, click } = await import('./browser.js');
  const tab = await chrome.tabs.get(state.tabId).catch(() => undefined);
  if (!tab || !supportedUrl(tab.url)) return RequestOutcome.UNAVAILABLE;
  if (request.origin && new URL(tab.url).origin !== request.origin) return RequestOutcome.ORIGIN_CHANGED;
  const controller = new AbortController();
  const page = new ChromePage(tab, controller.signal, []);
  await page.attach();
  try {
    const snap = await snapshot(page);
    // Keyed by elementId, not label: two fields can share a label (e.g. password + confirm password),
    // and keying by label would collide, losing one field's value or misapplying it to the other.
    const fields = request.fields.filter(f => values[f.elementId] !== undefined && values[f.elementId] !== '');
    if (!fields.length) return RequestOutcome.CANCELLED;
    for (const field of fields) {
      const element = snap.elements.find(e => e.id === field.elementId);
      // The page was retagged since the form was handed over: the ids no longer mean anything.
      if (!element || element.role !== field.inputType || element.name !== field.label) return RequestOutcome.LOCATOR_INVALID;
    }
    for (const field of fields) await typeText(page, field.elementId, values[field.elementId], false);
    if (request.submit?.elementId) await click(page, request.submit.elementId);
    return RequestOutcome.SUBMITTED;
  } catch {
    return RequestOutcome.SUBMISSION_FAILED;
  } finally {
    await page.detach();
    // No run's end-of-turn sweep follows this, so the cursor the form actions moved is cleared here.
    await setFeedback(page.tabId, { cursor: undefined });
  }
}
async function stop() {
  const run = active;
  if (!run) return;
  run.userStopped = true;
  run.controller.abort(new DOMException('stopped', 'AbortError'));
  await Promise.allSettled(run.pages.map(p => p.detach()));
}
async function execute(run, message) {
  let settings;
  let outcome;
  const { controller, pages } = run;
  const pendingTabs = new Map();
  const selectTab = async id => {
    if (pendingTabs.has(id)) await pendingTabs.get(id);
    controller.signal.throwIfAborted();
    const tab = await chrome.tabs.get(id);
    if (!supportedUrl(tab.url)) throw new Error('Chrome does not allow control of this tab. choose a website tab.');
    // Nothing happens on a site before the user has allowed it, so the gate comes before the claim.
    await ensureSiteAccess(tab.url, settings);
    // The user handed this tab over, so it is never grouped and never closed when the run ends.
    lease.claim(id, { sessionId: run.sessionId, turnId: run.turnId, openedByUs: false });
    let page = pages.find(p => p.tabId === id);
    if (!page) { page = new ChromePage(tab, controller.signal, pages); pages.push(page); }
    if (!page.attached) await page.attach();
    else {
      await chrome.tabs.update(id, { active: true });
      if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    }
    state.tabId = id; state.tabTitle = tab.title || tab.url;
    void setFeedback(id, { badge: BadgeState.WORKING });
    await syncTabMute(pages, id);
    await persist();
    return page;
  };
  const attachments = new Set();
  const candidates = new Map();
  const attachPopup = (tab) => {
    if (!candidates.has(tab.id) || !supportedUrl(tab.url) || pages.some(p => p.tabId === tab.id) || run.attaching.has(tab.id)) return;
    run.attaching.add(tab.id);
    void groupTab(tab.id); // tabs the run opened live together in the "checkto" group, out of the user's way

    const page = new ChromePage(tab, controller.signal, pages);
    pages.push(page);
    const work = ensureSiteAccess(tab.url, settings).then(() => page.attach()).then(async () => {
      controller.signal.throwIfAborted();
      state.tabId = tab.id; state.tabTitle = tab.title || tab.url;
      void setFeedback(tab.id, { badge: BadgeState.WORKING });
      await syncTabMute(pages, tab.id);
      return persist();
    }).catch(err => {
      if (!controller.signal.aborted) { run.popupError = err; controller.abort(); }
    });
    attachments.add(work);
    pendingTabs.set(tab.id, work);
    work.finally(() => { attachments.delete(work); pendingTabs.delete(tab.id); });
  };
  const created = tab => {
    if (!pages.some(p => p.tabId === tab.openerTabId)) return;
    candidates.set(tab.id, true);
    // Opened by a page the run drives, so the run owns it: it gets grouped, and closed at the end unless marked.
    try { lease.claim(tab.id, { sessionId: run.sessionId, turnId: run.turnId, openedByUs: true }); } catch {}
    attachPopup(tab);
  };
  const updated = (_id, _change, tab) => attachPopup(tab);
  const detached = (source, reason) => {
    const page = pages.find(p => p.tabId === source.tabId);
    if (!page || run.cleaning) return;
    page.attached = false; page.initialized = false;
    if (reason === 'canceled_by_user' || source.tabId === state.tabId) {
      // Remember why control ended so the user gets an explanation, not a bare "stopped".
      run.detached ??= { reason, title: page.currentTitle || state.tabTitle || '', url: page.currentUrl || '' };
      controller.abort();
    }
  };
  chrome.tabs.onCreated.addListener(created);
  chrome.tabs.onUpdated.addListener(updated);
  chrome.debugger.onDetach.addListener(detached);
  try {
    settings = await readSettings();
    const mode = message.mode === 'fast' ? 'fast' : 'careful';
    validateSettings(settings, mode);
    configure(settings);
    // Pick the tabs the last turn handed back up where they stand, rather than starting cold.
    await resumeHandoffIfPresent(run.sessionId, run.turnId);
    let page = await selectTab(message.tabId);
    state.status = 'working';
    await persist();
    const previousTasks = state.messages.slice(0, -1).map(m => `${m.role}: ${m.text}`).slice(-12);
    const mentioned = await Promise.all((message.tabIds || []).map(id => chrome.tabs.get(id)));
    const references = mentioned.map(t => `tab ${t.id}: ${t.title || ''} (${t.url})`).join('\n');
    // A turn that pauses on an approval already covered by a stored grant (see "approval grants"
    // above) never shows the card: it is answered the same way a manual "conversation"/"always"
    // click would, and the run carries straight on. Looping here (rather than ending this call and
    // letting the panel re-drive a new 'run') keeps that invisible to the user and to the tab
    // contract below, which only runs once per execute(). Bounded: a resumed "needs_input" carries
    // the paused step count, but a step that only asks and pauses never advances it, so a planner
    // that re-raised the identical grantable approval every step without otherwise progressing would
    // spin forever without MAX_AUTO_APPROVALS -- the same idea as DENIAL_LIMIT, for grants.
    let goal = message.goal + (references ? `\n\nTabs explicitly referenced by the user:\n${references}` : '');
    let resume = message.resume;
    let autoApprovals = 0;
    for (;;) {
      outcome = undefined;
      await runTask(page, {
        goal, resume, supervisor: mode === 'careful', model: settings.model,
        reasoning: settings.reasoning, maxSteps: settings.maxSteps, previousTasks, liveView: true, denials: state.denials,
        browserTabs: {
          list: async () => (await chrome.tabs.query({})).filter(t => supportedUrl(t.url)).map(t => ({ id: t.id, title: t.title || '', url: t.url })),
          // The agent can switch tabs mid-run; `page` has to track that so a grant-covered resume
          // (below) restarts runTask on wherever the run actually left off, not the tab it opened on.
          select: async id => { page = await selectTab(id); return page; },
          currentId: p => p.tabId,
        },
      }, event => {
        // The agent says how it is leaving a tab; the contract below acts on it when the run ends.
        if (event.type === 'mark') { markTab(event.tabId, event.disposition); return; }
        if (event.type === 'step') {
          state.steps.push({ step: event.step, action: event.action, log: event.log, plan: event.plan, note: event.note, cost: event.costUsd, title: event.title });
          state.cost = (state.cost || 0) + event.costUsd;
        }
        if (event.type === 'end') { outcome = event; return; }
        void persist().catch(() => {});
      }, controller.signal);
      if (run.popupError) throw run.popupError;
      const blocking = outcome?.status === 'needs_input' ? pickBlocking(outcome.requests || []) : undefined;
      const isApproval = blocking && (blocking.type === RequestType.APPROVAL || blocking.type === RequestType.PERMISSION_REQUEST);
      // Two kinds of approval never reach the panel: one a stored grant already covers, and any at
      // all when the user chose "never ask" (approvalMode 'none'). Nothing is stored for the second
      // case -- the setting is the permission, so there is nothing per-action to remember.
      const autoAnswer = !!blocking && (isGranted(blocking) || settings.approvalMode === 'none');
      if (!isApproval || !autoAnswer || ++autoApprovals > MAX_AUTO_APPROVALS) break;
      const denials = { ...(state.denials || {}) };
      delete denials[denialKey(blocking)];
      state.denials = denials;
      goal = 'go on';
      resume = outcome.resumeState;
    }
  } catch (err) {
    outcome = { status: controller.signal.aborted && !run.popupError ? 'stopped' : 'error', message: controller.signal.aborted && !run.popupError ? 'stopped' : safeError(err, settings) };
  } finally {
    run.cleaning = true;
    chrome.tabs.onCreated.removeListener(created);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.debugger.onDetach.removeListener(detached);
    // Any attach that was already in flight must finish before the final detach.
    await Promise.allSettled([...attachments]);
    await Promise.allSettled(pages.map(p => p.detach()));
    // Unmuting reads the lease, so it has to happen before the contract below releases them.
    await Promise.allSettled(pages.map(p => unmuteIfOurs(p.tabId)));
    if (run.popupError) outcome = { ...outcome, status: 'error', answer: undefined, message: safeError(run.popupError, settings) };
    // The agent reports an aborted run as "stopped" whether the user or Chrome ended it; only the user's stop is a plain stop.
    else if (outcome?.status === 'stopped' && run.detached && !run.userStopped) outcome = { ...outcome, status: 'blocked', answer: undefined, message: detachMessage(run.detached) };
    // A run waiting on the user is waiting on that very tab, so it is handed over, never closed under them.
    if (waitingOnUser(outcome?.status) && Number.isInteger(state.tabId)) markTab(state.tabId, Disposition.HANDOFF);
    const ending = await endRun(run.sessionId).catch(() => undefined);
    state.status = outcome?.status || 'error';
    state.cost = outcome?.totalCostUsd ?? state.cost;
    // The run is over: every tab it left standing says what it is now. A green dot holds a result,
    // a yellow one is waiting on the user, and anything else gets its own favicon back. Tabs the
    // contract just closed are skipped — it restored their favicons on the way out. Where the
    // contract marked a tab, that mark wins: the favicon has to say what the toolbar badge says,
    // so one handed-off tab in a run that otherwise finished still reads as waiting on the user.
    const closed = new Set(ending?.closed || []);
    const marked = new Map([
      ...(ending?.deliverable || []).map(tabId => [tabId, BadgeState.DELIVERABLE]),
      ...(ending?.handoff || []).map(tabId => [tabId, BadgeState.HANDOFF]),
    ]);
    const finalBadge = outcome?.status === 'done' ? BadgeState.DELIVERABLE : waitingOnUser(outcome?.status) ? BadgeState.HANDOFF : BadgeState.NONE;
    for (const tabId of new Set(pages.map(p => p.tabId))) if (!closed.has(tabId)) await setFeedback(tabId, { badge: marked.get(tabId) ?? finalBadge, cursor: undefined });
    // What the turn is waiting on, and why the page stopped it. The panel shows one card and the
    // reason in plain words; a stop leaves nothing pending because the agent declined it already.
    state.blockedReason = outcome?.blockedReason;
    state.requests = outcome?.requests ?? [];
    // A run that paused on a request carries the coverage/failure guards here; answering that request
    // resumes with this, so a pause never resets them regardless of what kind of request it raised.
    state.resumeState = outcome?.resumeState;
    if (outcome?.declined?.length) state.declined = outcome.declined;
    state.endedAt = Date.now();
    // Keep the run's actions with the reply they produced so earlier runs still show their steps,
    // and the run's own duration/stop-state so the duration divider reads right after it moves off screen.
    // All of them: a grant-covered resume (the loop above) keeps appending to state.steps, so a run
    // can outgrow one runTask's maxSteps, and the panel's trace header reports the count and marks
    // where an action failed — a tail slice would under-count the run and drop an early failure.
    // Storage is not the constraint: a step is a few hundred bytes and messages are capped at 20.
    state.messages.push({
      role: 'agent', text: safeError(outcome?.answer || outcome?.message || 'the task ended unexpectedly', settings),
      steps: state.steps, startedAt: state.startedAt, endedAt: state.endedAt, stopped: state.status === 'stopped',
      // Carried onto the reply so its trace header (the panel's one place a run reports on itself)
      // can still show what the run cost after it moves out of the live status strip.
      cost: state.cost,
    });
    state.messages = state.messages.slice(-20);
    clearConfig();
    state.running = false;
    active = undefined;
    await persist().catch(() => {});
  }
}
async function handle(message) {
  await ready;
  if (message.type === 'getState') {
    const settings = await readSettings();
    let configured = true;
    try { validateSettings(settings); } catch { configured = false; }
    const capability = voiceCapability(settings);
    const voice = { enabled: settings.voiceEnabled, mode: resolveVoiceMode(settings.voiceMode, capability), configuredMode: settings.voiceMode, provider: settings.voiceProvider, capability };
    return { state, configured, mode: settings.mode, model: settings.model, reasoning: settings.reasoning, seq, voice };
  }
  if (message.type === 'stop') {
    await stop();
    const hadDictation = !!(state.dictation && state.dictation.status !== 'idle');
    await teardownDictation();
    // A stop from a turn that ended waiting: decline what is still on screen rather than dropping it.
    if (declinePending('stopped').length || hadDictation) await persist();
    return { ok: true };
  }
  // A settings surface's read/write API onto stored approval grants (not built here, see AGENTS.md
  // for this PR's scope): 'grants:list' returns every stored grant (always-scope first, then
  // conversation-scope), each carrying the `key` 'grants:revoke' takes back to remove it.
  if (message.type === 'grants:list') return { ok: true, grants: listGrants() };
  if (message.type === 'grants:revoke') return { ok: await revokeGrant(message.key) };
  if (message.type === 'getBadge') return { badge: feedback(message.tabId).badge };
  if (message.type === 'setBadge') { await setFeedback(message.tabId, { badge: message.badge }); return { ok: true }; }
  if (message.type === 'clear') {
    if (active) throw new Error('stop the current task before starting a new chat');
    declinePending('cancelled');
    if (state.sessionId) await releaseAll(state.sessionId);
    // releaseAll clears the toolbar badges; the favicon and cursor drawn into the pages themselves
    // have to go too, or a new chat starts with the last one's dots still on the user's tabs.
    for (const tabId of [...feedbackByTab.keys()]) { await setFeedback(tabId, { badge: BadgeState.NONE, cursor: undefined }); feedbackByTab.delete(tabId); }
    void persistFeedback();
    // A live dictation session (offscreen document + hot mic) must not survive a wholesale state
    // replacement below, or it keeps capturing with no state.dictation left to reach it.
    await teardownDictation();
    state = { running: false, messages: [], steps: [], status: 'ready', requests: [] };
    await persist(); return { ok: true, state, seq };
  }
  // The panel answering the one card it showed.
  if (message.type === 'answer') {
    if (active) throw new Error('a task is already running');
    const request = (state.requests || []).find(r => r.id === message.id);
    if (!request) throw new Error('that question is no longer waiting for an answer');
    if (message.outcome === RequestOutcome.DECLINED) {
      declinePending(RequestOutcome.DECLINED);
      state.status = 'ready';
      state.messages.push({ role: 'agent', text: 'okay, i left that alone. tell me what to do instead.' });
      await persist();
      return { ok: true };
    }
    let resume = 'go on';
    if (request.kind === 'credential' && message.outcome === RequestOutcome.USER_TOOK_OVER) {
      state.requests = [];
      resume = 'check whether the sign-in worked and carry on with the task';
    } else if (request.kind === 'credential') {
      // `values` is used here and nowhere else: it is not stored, persisted, or passed to the agent.
      const outcome = await submitCredentials(request, message.values || {});
      state.messages.push({ role: 'agent', text: {
        [RequestOutcome.SUBMITTED]: 'signed in with what you gave me. checking the page.',
        [RequestOutcome.ORIGIN_CHANGED]: 'that tab is on a different site now, so i did not fill anything in.',
        [RequestOutcome.LOCATOR_INVALID]: 'the sign-in form changed since i handed it over, so i did not fill anything in.',
        [RequestOutcome.UNAVAILABLE]: 'that tab is gone, so there was nothing to fill in.',
        [RequestOutcome.CANCELLED]: 'nothing was filled in.',
      }[outcome] ?? 'the sign-in form would not accept that, so nothing was submitted.' });
      state.requests = [];
      if (outcome !== RequestOutcome.SUBMITTED) { state.status = 'ready'; await persist(); return { ok: true, outcome }; }
      resume = 'check whether the sign-in worked and carry on with the task';
    } else if (request.type === RequestType.APPROVAL || request.type === RequestType.PERMISSION_REQUEST) {
      // "once" authorizes only this single click and stores nothing; a repeat asks again. The other
      // two scopes are stored under grantKey (never denialKey: see requests.js) so the auto-skip
      // loop in execute() can find them for a materially identical future request, and nothing
      // broader than that.
      const scope = message.scope === ApprovalScope.ALWAYS || message.scope === ApprovalScope.CONVERSATION ? message.scope : ApprovalScope.ONCE;
      if (scope === ApprovalScope.CONVERSATION) {
        state.grants = { ...(state.grants || {}), [grantKey(request)]: grantRecord(request, scope) };
      } else if (scope === ApprovalScope.ALWAYS) {
        persistentGrants = { ...persistentGrants, [grantKey(request)]: grantRecord(request, scope) };
        await persistGrants();
      }
      state.requests = [];
    } else {
      resume = String(message.text || message.choice || '').trim() || 'go on';
      state.requests = [];
    }
    const denials = { ...(state.denials || {}) };
    delete denials[denialKey(request)];
    state.denials = denials;
    await persist();
    // Whatever kind of request this answered, the run resumes with the coverage/failure guards it
    // paused with — a pause must never reset those just because a different kind of request raised it.
    return handle({ type: 'run', tabId: state.tabId, goal: resume, mode: (await readSettings()).mode, resume: state.resumeState });
  }
  if (message.type === 'run') {
    if (active) throw new Error('a task is already running');
    // The panel disables the composer while a card is waiting, but this is the enforcement that
    // actually matters: nothing may start a fresh run over a pending request and let it vanish
    // uncounted. Answer it (or decline it) through 'answer' first.
    if (pickBlocking(state.requests || [])) throw new Error('answer the pending request before starting a new task');
    if (!Number.isInteger(message.tabId) || typeof message.goal !== 'string' || !message.goal.trim() || message.goal.length > 10000) throw new Error('choose a tab and enter a task');
    if (message.tabIds !== undefined && (!Array.isArray(message.tabIds) || !message.tabIds.every(Number.isInteger))) throw new Error('invalid tab references');
    // The session outlives one turn: it is what holds a handed-off tab until the next turn resumes it.
    const sessionId = state.sessionId || crypto.randomUUID();
    const run = { controller: new AbortController(), pages: [], attaching: new Set(), sessionId, turnId: crypto.randomUUID() };
    active = run; // Reserve before any storage, attachment, or API awaits.
    state = { ...state, sessionId, tabId: message.tabId, running: true, status: 'connecting', steps: [], cost: 0, startedAt: Date.now(), endedAt: undefined, requests: [], blockedReason: undefined, resumeState: undefined };
    state.messages.push({ role: 'user', text: message.goal.trim() });
    void persist().catch(() => {});
    void execute(run, { ...message, goal: message.goal.trim() });
    return { ok: true };
  }
  // Voice dictation: start capture (creates the offscreen document if needed), forward the command,
  // and translate a permission failure into opening the one-time full-tab grant page.
  if (message.type === 'dictation:start') {
    // Read settings before creating anything: opening the offscreen document is a side effect, and a
    // failed read after it leaves a document with no session behind it.
    const settings = await readSettings().catch(() => ({}));
    try {
      await ensureOffscreen();
    } catch (err) {
      return { ok: false, error: safeError(err, settings) };
    }
    // Raw audio still never crosses a runtime message; only the transcript text comes back.
    const reply = await chrome.runtime.sendMessage({ type: 'offscreen:start', chunkMs: message.chunkMs, settings: voiceSettingsFor(settings) }).catch(err => ({ error: safeError(err, settings) }));
    if (reply?.error) {
      await closeOffscreen();
      const error = safeError(reply.error, settings);
      const needsPermissionTab = NEEDS_PERMISSION_TAB.test(error);
      if (needsPermissionTab) await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') }).catch(() => {});
      state.dictation = { status: 'error', error };
      await persist();
      return { ok: false, error, needsPermissionTab };
    }
    dictationTriggered = false; // a fresh session: eager/prewarm may auto-run again for it
    state.dictation = { status: 'listening', partialText: '' };
    await persist();
    return { ok: true };
  }
  // Stop capture, transcribe whatever is left, then always tear the offscreen document down —
  // whether or not the offscreen side reported an error — so nothing keeps a hot mic.
  if (message.type === 'dictation:stop') {
    // Settings are only needed to redact an error here, so a storage read that fails must not be
    // able to skip the teardown below: the mic is released no matter what.
    const settings = await readSettings().catch(() => ({}));
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'offscreen:stop' }).catch(err => ({ error: safeError(err, settings) }));
    } finally {
      await closeOffscreen();
    }
    if (reply?.error) {
      const error = safeError(reply.error, settings);
      state.dictation = { status: 'error', error };
      await persist();
      return { ok: false, error };
    }
    state.dictation = { status: 'idle', text: reply?.text || '' };
    await persist();
    // "dictate" leaves this for the user to send; "prewarm" (and "eager" as a fallback, if it never
    // crossed its mid-utterance word threshold) run with it now that speech has ended.
    await maybeAutoRunFromDictation({ text: reply?.text || '', isFinal: true });
    return { ok: true, text: reply?.text || '' };
  }
  // Fire-and-forget events from the offscreen document while a session is live.
  if (message.type === 'dictation:partial') {
    state.dictation = { ...(state.dictation || {}), status: 'listening', partialText: message.text };
    await persist();
    // "eager" only: a partial with enough words in it can start a run before speech even ends.
    await maybeAutoRunFromDictation({ text: message.text, isFinal: false });
    return { ok: true };
  }
  if (message.type === 'dictation:error') {
    state.dictation = { ...(state.dictation || {}), status: 'error', error: safeError(message.error, await readSettings().catch(() => ({}))) };
    await persist();
    // A single failed partial transcription is not fatal to the session; a MediaRecorder error is —
    // it has already stopped itself and released the mic in offscreen.js, so close the document too.
    if (message.fatal) await closeOffscreen();
    return { ok: true };
  }
  // Acknowledgement from the one-time full-tab permission page; nothing to do but confirm receipt.
  if (message.type === 'dictation:permission-granted') return { ok: true };
  throw new Error('unknown request');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // 'offscreen:start'/'offscreen:stop' are requests background sends to the offscreen document
  // only; excluded here the same way 'permission' is, so background never answers its own request.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || message?.type === 'state' || message?.type === 'permission' || message?.type === 'offscreen:start' || message?.type === 'offscreen:stop') return;
  handle(message).then(reply, err => reply({ error: safeError(err) }));
  return true;
});
// Content scripts get their own listener: the one above only trusts extension pages, and a content
// script's sender is a web page. It answers exactly one question — what should this tab be showing —
// which is how a freshly injected or bfcache-restored script gets its state without being pushed to.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || message?.type !== 'CONTENT_STATE_REQUEST') return false;
  reply({ state: contentState(sender.tab.id) });
  return false;
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.runtime.openOptionsPage(); });

// Keyboard shortcut: open the side panel on the active tab's window (mirrors chatgpt's open-codex-side-panel).
export async function openSidePanel(windowId) {
  if (windowId == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    windowId = tab?.windowId;
  }
  if (windowId != null) await chrome.sidePanel.open({ windowId });
}
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'open-panel') return;
  // The command listener gets the window's active tab directly; prefer that over the extra
  // chrome.tabs.query round trip in openSidePanel, which can resolve to a window that's no
  // longer focused by the time it settles. Falls back to that query when no tab is given.
  void openSidePanel(tab?.windowId);
});

// Right-click entry: send the selection or link into a chat run on the clicked tab.
export const ASK_CHECKTO_MENU_ID = 'ask-checkto';
export function contextMenuGoal(info) {
  if (info.linkUrl) return `look at this link: ${info.linkUrl}`;
  if (info.selectionText) return `help me with this selection: "${info.selectionText}"`;
  return `help me with this page: ${info.pageUrl || ''}`;
}
if (chrome.contextMenus) {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: ASK_CHECKTO_MENU_ID, title: 'Ask Checkto', contexts: ['page', 'selection', 'link'] }, () => void chrome.runtime.lastError);
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== ASK_CHECKTO_MENU_ID || !tab || !supportedUrl(tab.url)) return;
    void openSidePanel(tab.windowId).then(() => handle({ type: 'run', tabId: tab.id, goal: contextMenuGoal(info), mode: 'fast' })).catch(() => {});
  });
}
