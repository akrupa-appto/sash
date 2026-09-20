import { runTask } from '../agent.ts';
import { ChromePage, supportedUrl } from './browser.js';
import { configure, clearConfig } from './config.js';
import { readSettings, validateSettings } from './settings.js';

let active;
let state = { running: false, messages: [], steps: [], status: 'ready' };
let saving = Promise.resolve();
// Broadcasts can race (a stale in-flight 'run' broadcast landing after a later 'clear'),
// so panel.js uses this to drop any broadcast older than the last one it applied.
let seq = 0;
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get(['runState', 'seq']);
  // The service worker gets killed and restarted on idle while the panel stays open, so an
  // in-memory-only seq would reset to 0 and the panel's lastSeq guard would then drop every
  // broadcast (and the next getState reply) as "stale" forever. Restore it across restarts.
  if (typeof saved.seq === 'number') seq = saved.seq;
  if (saved.runState) state = { ...saved.runState, running: false };
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
    let page = pages.find(p => p.tabId === id);
    if (!page) { page = new ChromePage(tab, controller.signal, pages); pages.push(page); }
    if (!page.attached) await page.attach();
    else {
      await chrome.tabs.update(id, { active: true });
      if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    }
    state.tabId = id; state.tabTitle = tab.title || tab.url;
    await persist();
    return page;
  };
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
    pendingTabs.set(tab.id, work);
    work.finally(() => { attachments.delete(work); pendingTabs.delete(tab.id); });
  };
  const created = tab => {
    if (pages.some(p => p.tabId === tab.openerTabId)) { candidates.set(tab.id, true); attachPopup(tab); }
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
    const page = await selectTab(message.tabId);
    state.status = 'working';
    await persist();
    const previousTasks = state.messages.slice(0, -1).map(m => `${m.role}: ${m.text}`).slice(-12);
    const mentioned = await Promise.all((message.tabIds || []).map(id => chrome.tabs.get(id)));
    const references = mentioned.map(t => `tab ${t.id}: ${t.title || ''} (${t.url})`).join('\n');
    await runTask(page, {
      goal: message.goal + (references ? `\n\nTabs explicitly referenced by the user:\n${references}` : ''), supervisor: mode === 'careful', model: settings.model,
      reasoning: settings.reasoning, maxSteps: settings.maxSteps, previousTasks, liveView: true,
      browserTabs: {
        list: async () => (await chrome.tabs.query({})).filter(t => supportedUrl(t.url)).map(t => ({ id: t.id, title: t.title || '', url: t.url })),
        select: selectTab, currentId: page => page.tabId,
      },
    }, event => {
      if (event.type === 'step') {
        state.steps.push({ step: event.step, action: event.action, plan: event.plan, note: event.note, cost: event.costUsd, title: event.title });
        state.cost = (state.cost || 0) + event.costUsd;
      }
      if (event.type === 'end') { outcome = event; return; }
      void persist().catch(() => {});
    }, controller.signal);
    if (run.popupError) throw run.popupError;
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
    if (run.popupError) outcome = { ...outcome, status: 'error', answer: undefined, message: safeError(run.popupError, settings) };
    // The agent reports an aborted run as "stopped" whether the user or Chrome ended it; only the user's stop is a plain stop.
    else if (outcome?.status === 'stopped' && run.detached && !run.userStopped) outcome = { ...outcome, status: 'blocked', answer: undefined, message: detachMessage(run.detached) };
    state.status = outcome?.status || 'error';
    state.cost = outcome?.totalCostUsd ?? state.cost;
    // Keep the run's actions with the reply they produced so earlier runs still show their steps.
    state.messages.push({ role: 'agent', text: safeError(outcome?.answer || outcome?.message || 'the task ended unexpectedly', settings), steps: state.steps.slice(-60) });
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
    return { state, configured, mode: settings.mode, model: settings.model, reasoning: settings.reasoning, seq };
  }
  if (message.type === 'stop') { await stop(); return { ok: true }; }
  if (message.type === 'clear') {
    if (active) throw new Error('stop the current task before starting a new chat');
    state = { running: false, messages: [], steps: [], status: 'ready' };
    await persist(); return { ok: true, state, seq };
  }
    if (message.type === 'run') {
    if (active) throw new Error('a task is already running');
    if (!Number.isInteger(message.tabId) || typeof message.goal !== 'string' || !message.goal.trim() || message.goal.length > 10000) throw new Error('choose a tab and enter a task');
    if (message.tabIds !== undefined && (!Array.isArray(message.tabIds) || !message.tabIds.every(Number.isInteger))) throw new Error('invalid tab references');
    const run = { controller: new AbortController(), pages: [], attaching: new Set() };
    active = run; // Reserve before any storage, attachment, or API awaits.
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
