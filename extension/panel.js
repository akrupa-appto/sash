import { blockedText, pickBlocking, RequestOutcome } from './requests.js';

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
  $('#goal').placeholder = blocked ? 'answer the request above before sending a new message' : 'say what you need';
  $('#send').title = blocked ? 'answer the request above first' : 'send task';
}
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
// A finished step's row always shows its expanded sentence: by the time an entry exists the action is
// already done, so there is no live/ticker form to show here (the ticker is used in #status-text instead).
function stepElement(s) {
  const el = document.createElement('div'); el.className = 'step';
  el.textContent = `${s.step}. ${s.log?.expanded || s.plan || s.action}`;
  for (const text of [s.log ? '' : (s.plan ? s.action : ''), s.note].filter(Boolean)) { const p = document.createElement('p'); p.textContent = text; el.append(p); }
  return el;
}
// The collapsed <details> summary reads as one joined sentence ("opened the upload tab, clicked upload"),
// not a step count or a stack trace: the first fragment starts a sentence, the rest read lowercase mid-sentence.
function summarySentence(steps) {
  if (!steps.length) return 'activity';
  return steps.map((s, i) => (s.log ? (i === 0 ? s.log.fragmentCapitalized : s.log.fragment) : (s.plan || s.action))).join(', ');
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
  no.addEventListener('click', () => renderRequest(currentState));
  actions.append(yes, no);
  card.append(actions);
}
function requestCard(pending) {
  const card = el('div', 'notice request-card');
  card.dataset.requestType = pending.type;
  if (pending.kind) card.dataset.requestKind = pending.kind;
  card.append(el('p', 'request-question', pending.question || `allow checkto to ${pending.action}?`));
  if (pending.why) card.append(el('p', 'muted', pending.why));
  if (pending.screenshot) {
    const shot = document.createElement('img');
    shot.className = 'request-shot'; shot.alt = ''; shot.src = `data:image/jpeg;base64,${pending.screenshot}`;
    card.append(shot);
  }
  const actions = el('div', 'request-actions');
  // Three scopes, not yes/no. The widest one is confirmed a second time with the warning spelled out.
  if (pending.scopes?.length) {
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
      label.append(input); form.append(label); inputs.set(field.label, input);
    }
    if (pending.signInOptions?.length) form.append(el('p', 'muted', `or use the page's own buttons: ${pending.signInOptions.join(', ')}`));
    const submit = el('button', undefined, pending.submit?.label || 'sign in'); submit.type = 'submit';
    const tookOver = el('button', 'secondary', 'i signed in myself'); tookOver.type = 'button';
    const cancel = el('button', 'secondary', 'cancel'); cancel.type = 'button';
    tookOver.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.USER_TOOK_OVER }));
    cancel.addEventListener('click', () => void answerRequest(pending, { outcome: RequestOutcome.DECLINED }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const values = Object.fromEntries([...inputs].map(([label, input]) => [label, input.value]));
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
  $('#blocked').textContent = reason || '';
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
  $('#intro').hidden = !!state.messages.length;
  // The run stopped on a request: the last reply is what the user has to answer, not a finished result.
  const waiting = !running && state.status === 'needs_input';
  $('#messages').replaceChildren(...state.messages.map((m, i) => {
    const el = document.createElement('div'); el.className = `message ${m.role}${waiting && m.role === 'agent' && i === state.messages.length - 1 ? ' asking' : ''}`;
    const label = document.createElement('span'); label.className = 'message-label'; label.textContent = m.role === 'user' ? 'you' : 'checkto';
    const body = document.createElement('div'); body.textContent = m.text;
    el.append(label);
    // The actions belong above the reply they produced, so the answer stays the last thing on screen.
    // The duration divider sits between them: it is that run's own outcome, not the current run's.
    if (m.steps?.length) {
      const wrap = document.createElement('details'); wrap.className = 'steps';
      const summary = document.createElement('summary'); summary.textContent = summarySentence(m.steps);
      wrap.append(summary, ...m.steps.map(stepElement));
      el.append(wrap);
      const text = durationText({ startedAt: m.startedAt, endedAt: m.endedAt, stopped: m.stopped, live: false });
      if (text) { const d = document.createElement('div'); d.className = 'duration'; d.textContent = text; el.append(d); }
    }
    el.append(body);
    return el;
  }));
  // The live list only covers the run in flight; once it ends the steps move onto that run's reply.
  $('#steps-wrap').hidden = !running || !state.steps.length;
  $('#steps-label').textContent = summarySentence(state.steps);
  $('#steps').replaceChildren(...state.steps.map(stepElement));
  const latest = state.steps.at(-1);
  $('#status-text').textContent = running ? (latest?.log?.ticker || latest?.plan || latest?.action || (state.status === 'connecting' ? 'connecting to your tab…' : 'reading your page…')) : ({ ready: 'ready when you are', done: 'finished', error: 'could not finish', stopped: 'stopped', blocked: 'needs your attention', needs_input: 'waiting for your answer', max_steps: 'step limit reached' }[state.status] || state.status);
  $('#status-text').title = $('#status-text').textContent;
  $('#cost').textContent = state.cost ? `$${state.cost.toFixed(4)}` : '';
  $('#run-status').classList.toggle('running', running);
  renderLiveDuration();
  // The same pending request both gates the composer and is what the request card renders: computed
  // once here so the two can never see a different answer to "is something waiting on the user".
  pendingRequest = running ? undefined : pickBlocking(state.requests || []);
  renderRequest(state, pendingRequest);
  controls();
  $('#content').scrollTop = $('#content').scrollHeight;
  // Re-tick every second while a run is live, so the duration divider can appear once a second has
  // passed. Only that one line is redrawn: a full render would collapse an open activity list and
  // throw away the scroll position under the user every second.
  clearInterval(durationTimer);
  if (running) durationTimer = setInterval(renderLiveDuration, 1000);
}
async function load() {
  const response = await request({ type: 'getState' });
  $('#mode').value = response.mode;
  $('#model-link').textContent = response.model ? `${response.model.replace(/^(openai|gemini|custom):/, '')} · ${response.reasoning || 'auto'}` : '';
  $('#model-link').hidden = response.mode !== 'careful' || !response.model;
  configured = response.configured; $('#setup').hidden = configured;
  render(response.state); await refreshTabs();
}
chrome.runtime.onMessage.addListener(message => { if (message.type === 'state') render(message.state); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) void load().catch(showError); });
let refreshTimer;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refreshTabs().catch(showError), 150); };
chrome.tabs.onCreated.addListener(scheduleRefresh); chrome.tabs.onRemoved.addListener(scheduleRefresh); chrome.tabs.onUpdated.addListener(scheduleRefresh); chrome.tabs.onActivated.addListener(scheduleRefresh);
function showError(err) { $('#error').textContent = err.message || String(err); }
document.querySelectorAll('.settings-link').forEach(b => b.addEventListener('click', () => chrome.runtime.openOptionsPage()));
document.querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', event => { event.stopPropagation(); $('#goal').value = b.dataset.task; $('#goal').focus(); controls(); if (b.dataset.task.includes('tabs')) $('#mention-tabs').click(); }));
$('#mention-tabs').addEventListener('click', () => {
  const input = $('#goal'); input.focus();
  const prefix = input.selectionStart && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' @' : '@';
  input.setRangeText(prefix, input.selectionStart, input.selectionEnd, 'end'); updateMention();
  void refreshTabs().catch(showError);
});
$('#new-chat').addEventListener('click', async () => { try { await request({ type: 'clear' }); selected = []; renderSelected(); $('#error').textContent = ''; } catch (err) { showError(err); } });
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
    $('#goal').value = ''; closePicker();
  } catch (err) { showError(err); }
  finally { submitting = false; controls(); }
});
$('#goal').addEventListener('input', () => { updateMention(); controls(); });
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
