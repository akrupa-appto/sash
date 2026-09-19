import { runTask } from '../agent.ts';
import { ChromePage, supportedUrl } from './browser.js';
import { configure, clearConfig } from './config.js';
import { readSettings, validateSettings } from './settings.js';

let active;
let state = { running: false, messages: [], steps: [], status: 'ready' };
let saving = Promise.resolve();
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = (await chrome.storage.local.get('runState')).runState;
  if (saved) state = { ...saved, running: false };
  if (saved?.running) {
    state.status = 'stopped';
    state.messages.push({ role: 'agent', text: 'the browser restarted, so the task stopped. send a task to continue.' });
    await persist();
  }
})();
function persist() {
  const copy = structuredClone(state);
  saving = saving.catch(() => {}).then(() => chrome.storage.local.set({ runState: copy }));
  chrome.runtime.sendMessage({ type: 'state', state: copy }).catch(() => {});
  return saving;
}
function safeError(error, settings = {}) {
  let text = String(error?.message || error || 'something went wrong');
  for (const key of [settings.openrouterKey, settings.typesafeKey]) if (key) text = text.split(key).join('[redacted]');
  return text.slice(0, 600);
}
async function stop() {
  const run = active;
  if (!run) return;
  run.controller.abort(new DOMException('stopped', 'AbortError'));
  await Promise.allSettled(run.pages.map(p => p.detach()));
}
async function execute(run, message) {
  let settings;
  const { controller, pages } = run;
  const attachments = new Set();
  const candidates = new Map();
  const attachPopup = (tab) => {
    if (!candidates.has(tab.id) || !supportedUrl(tab.url) || pages.some(p => p.tabId === tab.id) || run.attaching.has(tab.id)) return;
    run.attaching.add(tab.id);
    const page = new ChromePage(tab, controller.signal, pages);
    pages.push(page);
    const work = page.attach().then(() => {
      controller.signal.throwIfAborted();
      state.tabId = tab.id; state.tabTitle = tab.title || tab.url;
      return persist();
    }).catch(err => {
      if (!controller.signal.aborted) { run.popupError = err; controller.abort(); }
    });
    attachments.add(work);
    work.finally(() => attachments.delete(work));
  };
  const created = tab => {
    if (pages.some(p => p.tabId === tab.openerTabId)) { candidates.set(tab.id, true); attachPopup(tab); }
  };
  const updated = (_id, _change, tab) => attachPopup(tab);
  const detached = source => {
    if (pages.some(p => p.tabId === source.tabId) && !run.cleaning) controller.abort();
  };
  chrome.tabs.onCreated.addListener(created);
  chrome.tabs.onUpdated.addListener(updated);
  chrome.debugger.onDetach.addListener(detached);
  try {
    settings = await readSettings();
    const mode = message.mode === 'fast' ? 'fast' : 'careful';
    validateSettings(settings, mode);
    configure(settings);
    const tab = await chrome.tabs.get(message.tabId);
    const page = new ChromePage(tab, controller.signal, pages);
    pages.push(page);
    await page.attach();
    state.tabTitle = tab.title || tab.url;
    state.status = 'working';
    await persist();
    const previousTasks = state.messages.slice(0, -1).map(m => `${m.role}: ${m.text}`).slice(-12);
    await runTask(page, {
      goal: message.goal, supervisor: mode === 'careful', model: settings.model,
      reasoning: settings.reasoning, maxSteps: settings.maxSteps, previousTasks, liveView: true,
    }, event => {
      if (event.type === 'step') {
        state.steps.push({ step: event.step, action: event.action, plan: event.plan, note: event.note, cost: event.costUsd });
        state.cost = (state.cost || 0) + event.costUsd;
      }
      if (event.type === 'end') {
        state.status = event.status;
        state.cost = event.totalCostUsd;
        state.messages.push({ role: 'agent', text: safeError(event.answer || event.message, settings) });
        state.messages = state.messages.slice(-20);
      }
      void persist().catch(() => {});
    }, controller.signal);
    if (run.popupError) throw run.popupError;
  } catch (err) {
    state.status = controller.signal.aborted && !run.popupError ? 'stopped' : 'error';
    state.messages.push({ role: 'agent', text: state.status === 'stopped' ? 'stopped' : safeError(err, settings) });
  } finally {
    run.cleaning = true;
    chrome.tabs.onCreated.removeListener(created);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.debugger.onDetach.removeListener(detached);
    // Any attach that was already in flight must finish before the final detach.
    await Promise.allSettled([...attachments]);
    await Promise.allSettled(pages.map(p => p.detach()));
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
    return { state, configured, mode: settings.mode };
  }
  if (message.type === 'stop') { await stop(); return { ok: true }; }
  if (message.type === 'clear') {
    if (active) throw new Error('stop the current task before starting a new chat');
    state = { running: false, messages: [], steps: [], status: 'ready' };
    await persist(); return { ok: true };
  }
  if (message.type === 'run') {
    if (active) throw new Error('a task is already running');
    if (!Number.isInteger(message.tabId) || typeof message.goal !== 'string' || !message.goal.trim() || message.goal.length > 10000) throw new Error('choose a tab and enter a task');
    const run = { controller: new AbortController(), pages: [], attaching: new Set() };
    active = run; // Reserve before any storage, attachment, or API awaits.
    if (state.tabId !== message.tabId) state.messages = [];
    state = { ...state, tabId: message.tabId, running: true, status: 'connecting', steps: [], cost: 0 };
    state.messages.push({ role: 'user', text: message.goal.trim() });
    void persist().catch(() => {});
    void execute(run, { ...message, goal: message.goal.trim() });
    return { ok: true };
  }
  throw new Error('unknown request');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || message?.type === 'state') return;
  handle(message).then(reply, err => reply({ error: safeError(err) }));
  return true;
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') chrome.runtime.openOptionsPage(); });
