import { blockedText, pickBlocking, RequestOutcome } from './requests.js';
import { chunkMsFor, createPushToTalk, VOICE_MODES } from './voice.js';

let running = false;
let configured = false;
let currentState;
let tabs = [];
let selected = [];
let matches = [];
let highlighted = 0;
let mention;
let submitting = false;
let durationTimer;
// The one request currently blocking the composer, or undefined when nothing is pending. Set once
// per render from the same `pickBlocking` the request card itself uses, so the composer and the
// card can never disagree about whether there is something to answer first.
let pendingRequest;
let lastSeq = -1;
// Voice dictation. `voice` is refreshed on every load() (see chrome.storage.onChanged below, the
// same way #mode/#model-link only update on a settings change, not on every broadcast).
let voice = { enabled: false, mode: undefined, capability: { canTranscribe: false } };
let dictationSessionActive = false; // between a successful dictation:start and its matching stop
let micBusy = false; // dictation:stop is in flight: recording has ended, the final transcription hasn't
let micFilledComposer = false; // #goal's text was last written by dictation, not typed — see render()
let voiceMayWriteComposer = false; // dictation currently owns the composer; cleared on user input
let dictationListening = false; // last render saw dictation.status === 'listening'
const $ = selector => document.querySelector(selector);
const isWebsite = tab => /^https?:\/\//i.test(tab.url || '') && !/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(tab.url || '');
const request = async message => {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply) throw new Error('checkto could not connect. reload the extension and reopen this panel.');
  if (reply.error) throw new Error(reply.error);
  return reply;
};
const site = tab => { try { return new URL(tab.url).hostname || tab.url; } catch { return tab.url || ''; } };
function controls() {
  const blocked = !running && !!pendingRequest;
  $('#send').disabled = running || submitting || blocked || !configured || !$('#goal').value.trim() || !tabs.some(isWebsite);
  $('#send').hidden = running;
  $('#stop').hidden = !running;
  $('#new-chat').disabled = running || submitting;
  $('#mode').disabled = running || submitting;
  // A card is waiting for an answer: the chat box itself must go inert, not just the send button,
  // or submitting free text over it looks like it worked and quietly drops the pending request.
  $('#goal').disabled = blocked;
  $('#goal').placeholder = blocked ? 'answer the request above before sending a new message' : 'Do anything';
  $('#send').title = blocked ? 'answer the request above first' : 'send task';
  renderMic();
}
// --- voice dictation ------------------------------------------------------------------------
// Idle / listening / transcribing / hands-free are the only four states the mic button shows;
// see extension/style.css's .mic-button[data-state] rule for how each one reads in the panel's
// signal-only palette (blue = live, the same as .running .dot; there is no brand accent).
function renderMic() {
  const mic = $('#mic');
  const usable = voice.enabled && voice.capability?.canTranscribe && !!voice.mode;
  mic.hidden = !usable;
  if (!usable) return;
  mic.disabled = running || submitting || !!pendingRequest;
  let visual = '';
  if (micBusy) visual = 'transcribing';
  else if (currentState?.dictation?.status === 'listening') visual = (ptt.latched || currentState.dictation.handsFree) ? 'hands-free' : 'listening';
  if (visual) mic.dataset.state = visual; else delete mic.dataset.state;
  mic.setAttribute('aria-pressed', String(visual === 'listening' || visual === 'hands-free'));
  mic.title = { transcribing: 'transcribing…', listening: 'release to stop', 'hands-free': 'listening hands-free — tap the mic (or M) again to stop' }[visual]
    || `hold to talk · ${VOICE_MODES[voice.mode]?.label || voice.mode} mode (hold M, or double-tap M for hands-free)`;
}
async function startDictation() {
  if (dictationSessionActive || micBusy || running || submitting || pendingRequest) return;
  if (!voice.enabled || !voice.capability?.canTranscribe || !voice.mode) return;
  dictationSessionActive = true;
  renderMic();
  try {
    const reply = await request({ type: 'dictation:start', chunkMs: chunkMsFor(voice.mode) });
    if (!reply.ok) { dictationSessionActive = false; showError(new Error(reply.error || 'could not start the mic')); }
    else voiceMayWriteComposer = true;
  } catch (err) { dictationSessionActive = false; showError(err); }
  renderMic();
}
async function stopDictation() {
  if (!dictationSessionActive) return;
  dictationSessionActive = false;
  micBusy = true;
  renderMic();
  try { await request({ type: 'dictation:stop' }); }
  catch (err) { showError(err); }
  micBusy = false;
  renderMic();
}
// Hold-to-talk with a double-tap-to-latch, driven by real keydown/keyup — see voice.js
// createPushToTalk for why this (not the global chrome.commands shortcut) is where true
// hold-then-release lives: a DOM keydown/keyup pair gives both edges, which chrome.commands cannot.
const ptt = createPushToTalk({ onStart: () => void startDictation(), onStop: () => void stopDictation(), onLatchOn: renderMic, onLatchOff: renderMic });
$('#mic').addEventListener('pointerdown', event => { event.preventDefault(); ptt.keydown({}); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(type => $('#mic').addEventListener(type, () => ptt.keyup()));
// The in-panel keyboard shortcut: hold M while the composer (or any field) isn't focused, so typing
// "m" into a message never triggers the mic. This key is deliberately NOT in manifest.json's
// commands block — chrome.commands shortcuts are intercepted by Chrome before a keydown reaches the
// page at all, which would make real hold-then-release here impossible for that key.
function typingTarget(target) { return /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName) || target?.isContentEditable; }
// Plain "m" only: Ctrl/Alt/Meta+M are real browser/OS shortcuts (bookmark, minimize, etc.) that must
// reach them untouched, not be swallowed as a mic press.
const isMicKey = event => event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.altKey && !event.metaKey;
window.addEventListener('keydown', event => { if (isMicKey(event) && !typingTarget(event.target)) ptt.keydown(event); });
window.addEventListener('keyup', event => { if (isMicKey(event)) ptt.keyup(); });
// The panel losing focus (alt-tab, clicking into the page, DevTools) with the key still physically
// down would otherwise leave the mic recording with nothing left able to see the matching keyup.
window.addEventListener('blur', () => ptt.keyup());
async function refreshTabs() {
  tabs = await chrome.tabs.query({});
  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeId = current[0]?.id;
  tabs.sort((a,b) => Number(b.id === activeId) - Number(a.id === activeId) || a.windowId - b.windowId || a.index - b.index);
  selected = selected.map(t => tabs.find(tab => tab.id === t.id) || { ...t, closed: true });
  renderTabCard(current[0]);
  renderSelected();
  controls();
  if (mention) renderPicker();
}
function renderTabCard(tab) {
  const usable = tab && isWebsite(tab);
  $('#tab-card-title').textContent = usable ? (tab.title || site(tab)) : 'open a website tab';
  const icon = $('#tab-card-icon'), mark = $('#tab-card-mark');
  icon.hidden = !(usable && tab.favIconUrl); if (!icon.hidden) icon.src = tab.favIconUrl;
  mark.hidden = !icon.hidden; mark.textContent = usable ? (site(tab).replace(/^www\./, '').slice(0, 1) || '·') : '·';
}
function renderSelected() {
  $('#selected-tabs').replaceChildren(...selected.map(tab => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tab-chip';
    button.textContent = `@ ${tab.title || site(tab)}${tab.closed ? ' (closed)' : ''} ×`; button.title = `remove ${tab.title || site(tab)}`;
    button.addEventListener('click', () => { selected = selected.filter(t => t.id !== tab.id); renderSelected(); if (mention) renderPicker(); });
    return button;
  }));
  $('#tab-context').textContent = selected.length ? `${selected.length} ${selected.length === 1 ? 'tab referenced' : 'tabs referenced'}` : 'all tabs available · starts on your current tab';
}
function closePicker() {
  mention = undefined; $('#tab-picker').hidden = true;
  $('#goal').setAttribute('aria-expanded', 'false'); $('#goal').removeAttribute('aria-activedescendant');
}
function updateMention() {
  const input = $('#goal');
  const before = input.value.slice(0, input.selectionStart);
  const match = before.match(/(?:^|\s)@([^@\n]*)$/);
  if (!match) { closePicker(); return; }
  mention = { start: before.length - match[1].length - 1, end: input.selectionStart, query: match[1].trim().toLowerCase() };
  highlighted = 0; renderPicker();
}
function renderPicker() {
  if (!mention) return;
  matches = tabs.filter(t => !selected.some(s => s.id === t.id) && `${t.title} ${t.url}`.toLowerCase().includes(mention.query));
  highlighted = Math.max(0, Math.min(highlighted, matches.length - 1));
  $('#tab-picker').hidden = false; $('#goal').setAttribute('aria-expanded', 'true');
  $('#tab-count').textContent = `${matches.length}`;
  $('#tab-results').replaceChildren(...matches.map((tab, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tab-option';
    button.id = `tab-option-${tab.id}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === highlighted));
    button.setAttribute('aria-disabled', String(!isWebsite(tab)));
    const icon = document.createElement('span'); icon.className = 'tab-monogram'; icon.textContent = site(tab).replace(/^www\./, '').slice(0,1).toUpperCase() || '·';
    const text = document.createElement('span'); text.className = 'tab-option-text';
    const title = document.createElement('strong'); title.textContent = tab.title || tab.url || 'untitled tab';
    const detail = document.createElement('small'); detail.textContent = isWebsite(tab) ? `${site(tab)}${tab.active ? ' · active' : ''}` : 'Chrome does not allow control of this page';
    text.append(title, detail); button.append(icon, text);
    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', () => chooseTab(tab)); return button;
  }));
  if (!matches.length) { const empty = document.createElement('p'); empty.className = 'picker-empty'; empty.textContent = 'no matching tabs'; $('#tab-results').append(empty); }
  const active = matches[highlighted];
  if (active) $('#goal').setAttribute('aria-activedescendant', `tab-option-${active.id}`);
  else $('#goal').removeAttribute('aria-activedescendant');
}
function chooseTab(tab) {
  if (!isWebsite(tab)) { showError(new Error('Chrome protects this page. choose a regular website tab.')); return; }
  selected.push(tab);
  const input = $('#goal');
  input.setRangeText('', mention.start, mention.end, 'end');
  closePicker(); renderSelected(); input.focus(); controls();
}
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// A finished step's row always shows its expanded sentence: by the time an entry exists the action is
// already done, so every glyph resolves straight to its check — there is no live/ticker form to show
// here (the ticker is folded into the live trace header instead). Raw execution detail (why a step was corrected,
// retried or failed) is the one thing on this row set in monospace, faded out behind a gradient mask
// rather than hard-clipped; everything else on the row is Archivo.
function stepElement(s) {
  const el = document.createElement('div'); el.className = 'step';
  const glyph = document.createElement('span'); glyph.className = 'status-glyph'; glyph.innerHTML = ICON_CHECK; glyph.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div'); body.className = 'step-body';
  const label = document.createElement('span'); label.className = 'step-label'; label.textContent = s.log?.expanded || s.plan || s.action;
  body.append(label);
  if (s.note) {
    const detail = document.createElement('div'); detail.className = 'tool-output';
    const tag = document.createElement('span'); tag.className = 'lang-tag'; tag.textContent = 'plaintext';
    const text = document.createElement('span'); text.textContent = s.note;
    detail.append(tag, text); body.append(detail);
  }
  el.append(glyph, body);
  return el;
}
// The collapsed trace reads as one joined sentence ("opened the upload tab, clicked upload"), not a
// step count or a stack trace, when read by assistive tech: it is the header's aria-label, kept off
// the visible face so the visible face can carry checkto's own tick track and duration instead.
function summarySentence(steps) {
  if (!steps.length) return 'activity';
  return steps.map((s, i) => (s.log ? (i === 0 ? s.log.fragmentCapitalized : s.log.fragment) : (s.plan || s.action))).join(', ');
}
// The segmented tick track — checkto's signature move. One filled tick per step that has landed;
// there is no "pending" tick because the agent loop only ever records a step once it is done, so the
// track itself, growing turn over turn, is the progress signal (see the .trace-header comment in
// style.css for why glyphs never show an in-flight state).
function ticksMarkup(count) {
  return `<span class="ticks" aria-hidden="true">${'<span class="tick is-done"></span>'.repeat(count)}</span>`;
}
function stepCountLabel(count) { return `${count} step${count === 1 ? '' : 's'}`; }
// Cost lives in the trace header now, next to the duration/step-count it already reports —
// there is no separate status strip to hold it any more.
function costSuffix(cost) { return cost ? ` · $${cost.toFixed(4)}` : ''; }
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The visible face of a trace header: ticks, then a plain label, then (for a collapsible, finished
// trace) the chevron. The prose join-sentence goes on aria-label instead, so screen readers still get
// a sentence, never a step count read as a stack trace.
// The live label can now carry a step's raw ticker/plan/action text (page content the agent read),
// not just a computed word or number like the finished-trace label always was — so it is escaped
// before going into innerHTML, the same way any other untrusted string would be.
function traceHeaderMarkup(steps, label, { chevron } = {}) {
  return ticksMarkup(steps.length) + `<span class="trace-label">${escapeHtml(label)}</span>` + (chevron ? ICON_CHEV : '');
}
// Three states only, phrased as what happened to the run, not as the agent's failure.
function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}
function durationText({ startedAt, endedAt, stopped, live }) {
  if (!startedAt) return '';
  if (live) return Date.now() - startedAt >= 1000 ? 'Working' : '';
  if (!endedAt) return '';
  const elapsed = endedAt - startedAt;
  if (elapsed < 1000) return '';
  return stopped ? `You stopped after ${formatDuration(elapsed)}` : `Worked for ${formatDuration(elapsed)}`;
}
// The live divider under the running steps, redrawn on its own every second.
function renderLiveDuration() {
  const text = durationText({ startedAt: currentState?.startedAt, live: running });
  $('#live-duration').hidden = !running || !text;
  $('#live-duration').textContent = text;
}
// ---- the pending request card.
// A turn can raise several blocking states; pickBlocking returns the one the user answers first,
// so this block renders exactly one card no matter how many are queued behind it.
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
// One answer per card. A second click while the first is still travelling would reach a worker that
// has already cleared the request, and the user would be shown "no longer waiting" for an answer that
// actually went through. The id is held until the card is replaced, or released if the send failed.
let answering;
const answerRequest = async (pending, body) => {
  if (answering) return;
  answering = pending.id;
  const controls = [...$('#request').querySelectorAll('button, input')];
  for (const control of controls) control.disabled = true;
  try { await request({ type: 'answer', id: pending.id, ...body }); }
  catch (err) {
    answering = undefined;
    for (const control of controls) control.disabled = false;
    showError(err);
  }
};
function confirmScope(card, pending, scope) {
  card.replaceChildren();
  card.dataset.confirming = scope.id;
  card.append(el('p', 'request-question', scope.confirm.title), el('p', 'confirm-warning', scope.confirm.warning));
  const actions = el('div', 'request-actions');
  const yes = el('button', undefined, scope.confirm.accept); yes.type = 'button';
  yes.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.SUBMITTED, scope: scope.id }));
  const no = el('button', 'secondary', scope.confirm.cancel); no.type = 'button';
  no.addEventListener('click', () => renderRequest(currentState, pending));
  actions.append(yes, no);
  card.append(actions);
}
function requestCard(pending) {
  const card = el('div', 'notice request-card');
  card.dataset.requestType = pending.type;
  if (pending.kind) card.dataset.requestKind = pending.kind;
  // An explicit question (an ask, a picker) is plain sentence text. An approval with no question of
  // its own is phrased around the action it wants to take, and that action is the one place in the
  // whole panel where colour is used to mean "needs you": it's the thing being asked about, set in
  // the same amber the status strip's "needs your attention" state uses.
  if (pending.question) {
    card.append(el('p', 'request-question', pending.question));
  } else if (pending.action) {
    const q = el('p', 'request-question');
    q.append('allow checkto to ', el('span', 'request-target', pending.action), '?');
    card.append(q);
  }
  if (pending.why) card.append(el('p', 'muted', pending.why));
  if (pending.screenshot) {
    const shot = document.createElement('img');
    shot.className = 'request-shot'; shot.alt = ''; shot.src = `data:image/jpeg;base64,${pending.screenshot}`;
    card.append(shot);
  }
  const actions = el('div', 'request-actions');
  // Three scopes, not yes/no. The widest one is confirmed a second time with the warning spelled out.
  if (pending.scopes?.length) {
    actions.classList.add('request-scopes');
    for (const scope of pending.scopes) {
      const button = el('button', scope.id === 'once' ? undefined : 'secondary', scope.label);
      button.type = 'button'; button.dataset.scope = scope.id;
      button.addEventListener('click', () => scope.confirm
        ? confirmScope(card, pending, scope)
        : void answerRequest(pending, { outcome: RequestOutcome.SUBMITTED, scope: scope.id }));
      actions.append(button);
    }
    const deny = el('button', 'secondary', pending.denyLabel || 'deny'); deny.type = 'button';
    deny.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.DECLINED }));
    actions.append(deny);
    card.append(actions);
    return card;
  }
  const form = el('form', 'request-fields');
  // A login wall hands back a described form: labels, input types and autocomplete hints, no values.
  if (pending.kind === 'credential') {
    const inputs = new Map();
    for (const field of pending.fields || []) {
      const label = el('label', 'request-field');
      label.append(el('span', undefined, field.label));
      const input = document.createElement('input');
      input.type = field.secret ? 'password' : (['email', 'tel', 'url', 'number'].includes(field.inputType) ? field.inputType : 'text');
      if (field.autocomplete) input.autocomplete = field.autocomplete;
      input.required = !!field.required;
      label.append(input); form.append(label); inputs.set(field.elementId, input);
    }
    if (pending.signInOptions?.length) form.append(el('p', 'muted', `or use the page's own buttons: ${pending.signInOptions.join(', ')}`));
    const submit = el('button', undefined, pending.submit?.label || 'sign in'); submit.type = 'submit';
    const tookOver = el('button', 'secondary', 'i signed in myself'); tookOver.type = 'button';
    const cancel = el('button', 'secondary', 'cancel'); cancel.type = 'button';
    tookOver.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.USER_TOOK_OVER }));
    cancel.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.DECLINED }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      // Keyed by elementId, not label: two fields can share a label (e.g. password + confirm password).
      const values = Object.fromEntries([...inputs].map(([elementId, input]) => [elementId, input.value]));
      for (const input of inputs.values()) input.value = '';
      void answerRequest(pending, { outcome: RequestOutcome.SUBMITTED, values });
    });
    actions.append(submit, tookOver, cancel);
    form.append(actions);
    card.append(form);
    return card;
  }
  // Everything else is answered in words, with a picker in front of it when it is really a choice.
  if (pending.options?.length) {
    const options = el('div', 'request-options');
    for (const option of pending.options) {
      const button = el('button', 'secondary', option); button.type = 'button'; button.dataset.option = option;
      button.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.SUBMITTED, choice: option }));
      options.append(button);
    }
    form.append(options);
  }
  // A picker says whether an answer of the user's own is allowed beside the choices. A question with
  // no options is always answered in words, so there the box is the only way to answer at all.
  const free = !pending.options?.length || pending.allowFreeText ? document.createElement('input') : undefined;
  if (free) {
    free.type = 'text'; free.className = 'request-text';
    free.placeholder = pending.options?.length ? 'or answer in your own words' : 'your answer';
    form.append(free);
    const send = el('button', undefined, 'send'); send.type = 'submit';
    form.addEventListener('submit', event => { event.preventDefault(); void answerRequest(pending, { outcome: RequestOutcome.SUBMITTED, text: free.value }); });
    actions.append(send);
  }
  const skip = el('button', 'secondary', 'skip'); skip.type = 'button';
  skip.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.DECLINED }));
  actions.append(skip);
  form.append(actions);
  card.append(form);
  return card;
}
function renderRequest(state, pending) {
  const reason = blockedText(state.blockedReason);
  $('#blocked-text').textContent = reason || '';
  $('#blocked').hidden = running || !reason;
  // An answer already on its way keeps its card exactly as it is: redrawing it would re-enable the
  // buttons the user just used and throw away what they typed into it.
  if (pending && answering === pending.id) return;
  answering = undefined;
  $('#request').hidden = !pending;
  $('#request').replaceChildren(...(pending ? [requestCard(pending)] : []));
}
function render(state) {
  currentState = state; running = state.running;
  // A run starting (from any trigger — the mic, the global shortcut, or a plain typed message) ends
  // hands-free listening, per the owner's spec ("...until the key is tapped again or the run
  // starts"). The offscreen session itself is torn down on the background side; this only resets
  // this panel's own in-page latch (extension/background.js resets its own command-shortcut latch
  // the same way, independently, since it can't see this panel's local ptt state).
  if (running) ptt.endLatch();
  // Dictation reaching the composer: "dictate" only fills it once speech ends, so the user can still
  // edit before pressing send; "prewarm"/"eager" stream the interim transcript live. Ownership is
  // `voiceMayWriteComposer` (set when a listening session starts, cleared on a keystroke); provenance
  // of the current text is `micFilledComposer` and is not the same flag.
  const nowListening = !!(voice.enabled && state.dictation && state.dictation.status === 'listening');
  if (nowListening && !dictationListening) voiceMayWriteComposer = true;
  dictationListening = nowListening;
  if (voice.enabled && state.dictation && !running && voiceMayWriteComposer) {
    const goal = $('#goal');
    if (voice.mode !== 'dictate' && state.dictation.status === 'listening' && typeof state.dictation.partialText === 'string') {
      goal.value = state.dictation.partialText; micFilledComposer = true; updateMultiline(); controls();
    } else if (voice.mode === 'dictate' && state.dictation.status === 'idle' && state.dictation.text) {
      goal.value = state.dictation.text; micFilledComposer = true; updateMultiline(); controls();
    }
  } else if (running && micFilledComposer) {
    $('#goal').value = ''; micFilledComposer = false; updateMultiline();
  }
  if (state.dictation?.status === 'error' && state.dictation.error) $('#error').textContent = state.dictation.error;
  $('#intro').hidden = !!state.messages.length;
  // The run stopped on a request: the last reply is what the user has to answer, not a finished result.
  const waiting = !running && state.status === 'needs_input';
  $('#messages').replaceChildren(...state.messages.map((m, i) => {
    const isAsking = waiting && m.role === 'agent' && i === state.messages.length - 1;
    const el = document.createElement('div'); el.className = `message ${m.role}${isAsking ? ' asking' : ''}`;
    const label = document.createElement('span'); label.className = 'message-label';
    // .asking carries no visible border/stripe (palette 4's own "no decoration, only meaning"
    // rule), so the sr-only label is where its text difference lives now that the old run-status
    // strip's "waiting for your answer" is gone — color independence, per the Accessibility section.
    label.textContent = m.role === 'user' ? 'you' : (isAsking ? 'checkto, waiting for your answer' : 'checkto');
    const body = document.createElement('div'); body.textContent = m.text;
    el.append(label);
    // The actions belong above the reply they produced, so the answer stays the last thing on screen.
    // The trace header IS that run's duration line ("Worked for Ns ›") — there is no separate divider
    // repeating it below; when a run ended too fast to report a duration, the header falls back to a
    // plain step count instead of leaving the header blank.
    if (m.steps?.length) {
      const wrap = document.createElement('details'); wrap.className = 'trace steps';
      const header = document.createElement('summary'); header.className = 'trace-header';
      header.setAttribute('aria-label', summarySentence(m.steps));
      const label = (durationText({ startedAt: m.startedAt, endedAt: m.endedAt, stopped: m.stopped, live: false }) || stepCountLabel(m.steps.length)) + costSuffix(m.cost);
      header.innerHTML = traceHeaderMarkup(m.steps, label, { chevron: true });
      const body = document.createElement('div'); body.className = 'trace-body';
      const inner = document.createElement('div'); inner.className = 'trace-steps'; inner.append(...m.steps.map(stepElement));
      body.append(inner);
      wrap.append(header, body);
      el.append(wrap);
    }
    el.append(body);
    return el;
  }));
  // The live list covers the run in flight, from the moment it starts (even before a first step has
  // landed — the header then reads the same live ticker text the old standalone status strip used to
  // carry, plus the running cost, since the header is the one place a run already reports on itself).
  $('#steps-wrap').hidden = !running;
  $('#steps-label').setAttribute('aria-label', summarySentence(state.steps));
  const latest = state.steps.at(-1);
  const liveLabel = (latest?.log?.ticker || latest?.plan || latest?.action || (state.status === 'connecting' ? 'connecting to your tab…' : 'reading your page…')) + costSuffix(state.cost);
  $('#steps-label').innerHTML = traceHeaderMarkup(state.steps, liveLabel);
  $('#steps').replaceChildren(...state.steps.map(stepElement));
  renderLiveDuration();
  // The same pending request both gates the composer and is what the request card renders: computed
  // once here so the two can never see a different answer to "is something waiting on the user".
  pendingRequest = running ? undefined : pickBlocking(state.requests || []);
  renderRequest(state, pendingRequest);
  controls();
  // There is nothing to pin to the bottom of an empty conversation: the hero (and, unconfigured, the
  // setup notice above it) can be taller than the panel, and scrolling to the bottom used to bury both
  // off-screen the moment the panel first loaded. Only a real conversation (messages, or a run in
  // flight) rides the bottom; the empty state always opens at its own top.
  if (state.messages.length || running) { if (pinnedToBottom) scrollToEnd(); }
  else contentEl.scrollTop = 0;
  // Re-tick every second while a run is live, so the duration divider can appear once a second has
  // passed. Only that one line is redrawn: a full render would collapse an open activity list and
  // throw away the scroll position under the user every second.
  clearInterval(durationTimer);
  if (running) durationTimer = setInterval(renderLiveDuration, 1000);
}
// A single scrollTop = scrollHeight read right after replaceChildren() is not actually stale —
// browsers force layout on that read — but content can still grow *after* this point (the
// Archivo web font swapping in via font-display:swap, an image finishing decode, the steps
// <details> settling its final box), and nothing re-corrects the scroll position when that
// happens. That's what leaves the scrollbar thumb short of the track end, or the actions
// toggle sitting right at the clipped edge next to the status strip. So instead of a one-shot
// scroll, #content watches its own size with a ResizeObserver and keeps riding the bottom for
// as long as the person was already there, however late the real layout settles.
const contentEl = $('#content');
let pinnedToBottom = true;
function scrollToEnd() {
  requestAnimationFrame(() => { contentEl.scrollTop = contentEl.scrollHeight - contentEl.clientHeight; });
}
contentEl.addEventListener('scroll', () => {
  pinnedToBottom = contentEl.scrollHeight - contentEl.clientHeight - contentEl.scrollTop <= 4;
});
// #content's own box never resizes from new messages — its *children* (#messages, the live
// steps block) do, and that's exactly the growth a ResizeObserver on #content alone would miss.
const clamp = () => { if (pinnedToBottom) contentEl.scrollTop = contentEl.scrollHeight - contentEl.clientHeight; };
const contentResize = new ResizeObserver(clamp);
contentResize.observe(contentEl);
contentResize.observe($('#messages'));
contentResize.observe($('#steps-wrap'));
async function load() {
  const response = await request({ type: 'getState' });
  $('#mode').value = response.mode;
  // The model pill is the composer's permanent home for "what model" (it doubles as the old
  // model-link into settings); it shows a reasoning level only in careful mode, since fast mode
  // has none to report.
  $('#model-link').textContent = response.model
    ? `${response.model.replace(/^(openai|gemini|custom):/, '')}${response.mode === 'careful' && response.reasoning ? ` · ${response.reasoning}` : ''}`
    : 'choose a model';
  $('#model-link').hidden = false;
  configured = response.configured; $('#setup').hidden = configured;
  voice = response.voice || { enabled: false, mode: undefined, capability: { canTranscribe: false } };
  // getState can be in flight while a newer broadcast lands, so its snapshot gets the same
  // staleness check as a broadcast: never render (or rewind lastSeq to) an older state.
  if (response.seq === undefined || response.seq >= lastSeq) {
    if (response.seq !== undefined) lastSeq = response.seq;
    render(response.state);
  }
  await refreshTabs();
}
// Host access is asked for at the moment the agent needs the site; the wording is the guard.
// Chrome only grants an optional permission from a user gesture, so the Allow button below is
// what calls chrome.permissions.request — the worker cannot, and does not try.
// The dialog is one shared element, so two prompts arriving close together (e.g. two tabs each
// needing origin access mid-run) must not race: the second call used to overwrite the first's
// onclick handlers and title/detail before it resolved, leaving the first caller's promise (and
// whatever in the background was awaiting it) hung forever. Queue instead of overwriting.
let permissionQueue = Promise.resolve();
function askForAccess(prompt) {
  const run = () => new Promise(resolve => {
    const allow = $('#permission-allow');
    const deny = $('#permission-deny');
    $('#permission-title').textContent = prompt.title;
    $('#permission-detail').textContent = prompt.detail;
    allow.textContent = prompt.allow;
    deny.textContent = prompt.deny;
    $('#permission').hidden = false;
    const done = answer => { $('#permission').hidden = true; allow.onclick = null; deny.onclick = null; resolve(answer); };
    // Nothing may be awaited before request(): the gesture ends the moment this handler yields.
    allow.onclick = () => chrome.permissions.request({ origins: prompt.origins }, ok => { void chrome.runtime.lastError; done(ok === true); });
    deny.onclick = () => done(false);
    allow.focus();
  });
  const result = permissionQueue.then(run);
  permissionQueue = result.catch(() => {});
  return result;
}
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === 'permission') { void askForAccess(message.prompt).then(allow => reply({ allow })); return true; }
  if (message.type !== 'state') return;
  // A broadcast can arrive after a newer one (e.g. a stale in-flight run update landing after
  // a clear response already applied), so ignore anything older than what we already showed.
  if (message.seq !== undefined && message.seq < lastSeq) return;
  if (message.seq !== undefined) lastSeq = message.seq;
  render(message.state);
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) void load().catch(showError); });
let refreshTimer;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refreshTabs().catch(showError), 150); };
chrome.tabs.onCreated.addListener(scheduleRefresh); chrome.tabs.onRemoved.addListener(scheduleRefresh); chrome.tabs.onUpdated.addListener(scheduleRefresh); chrome.tabs.onActivated.addListener(scheduleRefresh);
function showError(err) { $('#error').textContent = err.message || String(err); }
const singleLineHeight = $('#goal').scrollHeight; // measured while the textarea starts out empty, i.e. one line
function updateMultiline() {
  const goal = $('#goal');
  goal.toggleAttribute('data-multiline', goal.scrollHeight > singleLineHeight + 1);
}
document.querySelectorAll('.settings-link').forEach(b => b.addEventListener('click', () => chrome.runtime.openOptionsPage()));
document.querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', event => { event.stopPropagation(); $('#goal').value = b.dataset.task; $('#goal').focus(); updateMultiline(); controls(); if (b.dataset.task.includes('tabs')) $('#mention-tabs').click(); }));
$('#mention-tabs').addEventListener('click', () => {
  const input = $('#goal'); input.focus();
  const prefix = input.selectionStart && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' @' : '@';
  input.setRangeText(prefix, input.selectionStart, input.selectionEnd, 'end'); updateMention();
  void refreshTabs().catch(showError);
});
$('#new-chat').addEventListener('click', async () => {
  try {
    const response = await request({ type: 'clear' });
    // Apply the cleared state from this response directly instead of waiting on the
    // async broadcast, which can otherwise race with a stale in-flight update.
    if (response.state !== undefined) {
      if (response.seq !== undefined) lastSeq = response.seq;
      render(response.state);
    }
    selected = []; renderSelected(); $('#error').textContent = '';
  } catch (err) { showError(err); }
});
$('#stop').addEventListener('click', async () => { try { await request({ type: 'stop' }); } catch (err) { showError(err); } });
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (running || submitting || pendingRequest) return;
  $('#error').textContent = '';
  submitting = true; controls();
  try {
    const goal = $('#goal').value.trim();
    if (!goal) return;
    if (selected.some(t => t.closed)) throw new Error('a referenced tab was closed. remove it or pick another tab.');
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const target = selected[0] || (isWebsite(active || {}) ? active : tabs.find(isWebsite));
    if (!target) throw new Error('open a website tab first');
    await request({ type: 'run', tabId: target.id, tabIds: selected.map(t => t.id), goal, mode: $('#mode').value });
    $('#goal').value = ''; updateMultiline(); closePicker();
  } catch (err) { showError(err); }
  finally { submitting = false; controls(); }
});
$('#goal').addEventListener('input', () => {
  voiceMayWriteComposer = false;
  micFilledComposer = false;
  updateMention(); updateMultiline(); controls();
});
$('#goal').addEventListener('click', updateMention);
$('#goal').addEventListener('keydown', event => {
  if (mention) {
    if (event.key === 'Escape') { event.preventDefault(); closePicker(); return; }
    if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); highlighted = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % (matches.length || 1); renderPicker(); document.getElementById(`tab-option-${matches[highlighted]?.id}`)?.scrollIntoView({ block: 'nearest' }); return; }
    if (event.key === 'Enter' && !event.shiftKey) {
      if (matches[highlighted]) { event.preventDefault(); chooseTab(matches[highlighted]); return; }
      closePicker();
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !running && !pendingRequest) { event.preventDefault(); $('#task-form').requestSubmit(); }
});
document.addEventListener('click', event => { if (!event.target.closest('.compose-box')) closePicker(); });
void load().catch(showError);
