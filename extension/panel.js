let running = false;
let configured = false;
let currentState;
let tabs = [];
let selected = [];
let matches = [];
let highlighted = 0;
let mention;
let submitting = false;
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
  $('#send').disabled = running || submitting || !configured || !$('#goal').value.trim() || !tabs.some(isWebsite);
  $('#send').hidden = running;
  $('#stop').hidden = !running;
  $('#new-chat').disabled = running || submitting;
  $('#mode').disabled = running || submitting;
}
async function refreshTabs() {
  tabs = await chrome.tabs.query({});
  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeId = current[0]?.id;
  tabs.sort((a,b) => Number(b.id === activeId) - Number(a.id === activeId) || a.windowId - b.windowId || a.index - b.index);
  selected = selected.map(t => tabs.find(tab => tab.id === t.id) || { ...t, closed: true });
  renderSelected();
  controls();
  if (mention) renderPicker();
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
function render(state) {
  currentState = state; running = state.running;
  $('#intro').hidden = !!state.messages.length;
  $('#messages').replaceChildren(...state.messages.map(m => {
    const el = document.createElement('div'); el.className = `message ${m.role}`;
    const label = document.createElement('span'); label.className = 'message-label'; label.textContent = m.role === 'user' ? 'you' : 'checkto';
    const body = document.createElement('div'); body.textContent = m.text; el.append(label,body); return el;
  }));
  $('#steps-wrap').hidden = !state.steps.length;
  $('#steps-label').textContent = `${state.steps.length} ${state.steps.length === 1 ? 'action' : 'actions'}`;
  $('#steps').replaceChildren(...state.steps.map(s => {
    const el = document.createElement('div'); el.className = 'step';
    el.textContent = `${s.step}. ${s.plan || s.action}`;
    for (const text of [s.plan ? s.action : '', s.note].filter(Boolean)) { const p = document.createElement('p'); p.textContent = text; el.append(p); }
    return el;
  }));
  const latest = state.steps.at(-1);
  $('#status-text').textContent = running ? (latest?.plan || latest?.action || (state.status === 'connecting' ? 'connecting to your tab…' : 'reading your page…')) : ({ ready: 'ready when you are', done: 'finished', error: 'could not finish', stopped: 'stopped', blocked: 'needs your attention', max_steps: 'step limit reached' }[state.status] || state.status);
  $('#status-text').title = $('#status-text').textContent;
  $('#cost').textContent = state.cost ? `$${state.cost.toFixed(4)}` : '';
  $('#run-status').classList.toggle('running', running);
  controls();
  $('#content').scrollTop = $('#content').scrollHeight;
}
async function load() {
  const response = await request({ type: 'getState' });
  $('#mode').value = response.mode;
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
document.querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', () => { $('#goal').value = b.dataset.task; $('#goal').focus(); controls(); if (b.dataset.task.includes('tabs')) $('#mention-tabs').click(); }));
$('#mention-tabs').addEventListener('click', () => {
  const input = $('#goal'); input.focus();
  const prefix = input.selectionStart && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' @' : '@';
  input.setRangeText(prefix, input.selectionStart, input.selectionEnd, 'end'); updateMention();
  void refreshTabs().catch(showError);
});
$('#new-chat').addEventListener('click', async () => { try { await request({ type: 'clear' }); selected = []; renderSelected(); $('#error').textContent = ''; } catch (err) { showError(err); } });
$('#stop').addEventListener('click', async () => { try { await request({ type: 'stop' }); } catch (err) { showError(err); } });
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault(); if (running || submitting) return;
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
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (matches[highlighted]) chooseTab(matches[highlighted]); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && !running) { event.preventDefault(); $('#task-form').requestSubmit(); }
});
document.addEventListener('click', event => { if (!event.target.closest('.compose-box')) closePicker(); });
void load().catch(showError);
