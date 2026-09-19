let mode = 'careful';
let running = false;
let currentState;
let selectedTab;
const $ = selector => document.querySelector(selector);
const request = async message => {
  const reply = await chrome.runtime.sendMessage(message);
  if (reply?.error) throw new Error(reply.error);
  return reply;
};
function setMode(value) {
  mode = value;
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === value)));
}
async function refreshTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const available = tabs.filter(t => /^https?:\/\//i.test(t.url || ''));
  const old = Number($('#tab').value) || selectedTab;
  $('#tab').replaceChildren(...available.map(tab => {
    const option = document.createElement('option'); option.value = tab.id;
    option.textContent = tab.title || new URL(tab.url).hostname; return option;
  }));
  const target = available.find(t => t.id === (running ? currentState?.tabId : old)) || available.find(t => t.active) || available[0];
  if (target) { $('#tab').value = target.id; selectedTab = target.id; }
  else { const option = document.createElement('option'); option.textContent = 'open a website to start'; option.value = ''; $('#tab').append(option); }
  $('#send').disabled = running || !target;
}
function render(state) {
  currentState = state;
  running = state.running;
  $('#intro').hidden = !!state.messages.length;
  $('#messages').replaceChildren(...state.messages.map(m => {
    const el = document.createElement('div'); el.className = `message ${m.role}`; el.textContent = m.text; return el;
  }));
  $('#steps-wrap').hidden = !state.steps.length;
  $('#steps-label').textContent = `${state.steps.length} ${state.steps.length === 1 ? 'step' : 'steps'}`;
  $('#steps').replaceChildren(...state.steps.map(s => {
    const el = document.createElement('div'); el.className = 'step';
    el.textContent = `${s.step}. ${s.action}`;
    for (const text of [s.plan, s.note].filter(Boolean)) { const p = document.createElement('p'); p.textContent = text; el.append(p); }
    return el;
  }));
  $('#status-text').textContent = state.status.replaceAll('_', ' ');
  $('#cost').textContent = state.cost ? `$${state.cost.toFixed(4)}` : '';
  $('#run-status').classList.toggle('running', running);
  $('#send').disabled = running || !$('#tab').value;
  $('#stop').hidden = !running;
  $('#tab').disabled = running;
  $('#new-chat').disabled = running;
  document.querySelectorAll('[data-mode]').forEach(b => { b.disabled = running; });
  $('#content').scrollTop = $('#content').scrollHeight;
}
async function load() {
  const response = await request({ type: 'getState' });
  setMode(response.mode);
  $('#setup').hidden = response.configured;
  render(response.state);
  await refreshTabs();
}
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'state') { render(message.state); if (running && message.state.tabId !== Number($('#tab').value)) void refreshTabs(); }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) void load().catch(showError); });
function showError(err) { $('#error').textContent = err.message || String(err); }
document.querySelectorAll('.settings-link').forEach(b => b.addEventListener('click', () => chrome.runtime.openOptionsPage()));
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', () => { $('#goal').value = b.dataset.task; $('#goal').focus(); }));
$('#refresh-tabs').addEventListener('click', () => refreshTabs().catch(showError));
$('#new-chat').addEventListener('click', async () => { try { await request({ type: 'clear' }); $('#error').textContent = ''; } catch (err) { showError(err); } });
$('#stop').addEventListener('click', async () => { try { await request({ type: 'stop' }); } catch (err) { showError(err); } });
$('#task-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#error').textContent = '';
  try {
    await request({ type: 'run', tabId: Number($('#tab').value), goal: $('#goal').value.trim(), mode });
    $('#goal').value = '';
  } catch (err) { showError(err); }
});
$('#goal').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !running) { event.preventDefault(); $('#task-form').requestSubmit(); } });
void load().catch(showError);
