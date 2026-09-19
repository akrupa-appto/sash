import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Follows the extension-background.test.mjs mock conventions, extended with a tiny
// per-tab mute registry so we can assert on real chrome.tabs.update({ muted }) calls.
const events = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), fire: (...args) => [...listeners].map(f => f(...args)) };
};
const data = { settings: { openrouterKey: 'private-test-key', model: 'fixture/model' } };
const tabState = new Map();
const updateCalls = [];
const tabRecord = id => {
  if (!tabState.has(id)) tabState.set(id, { id, url: 'https://example.test', title: 'Fixture', mutedInfo: { muted: false } });
  return tabState.get(id);
};
let capturedSelect;
let finishTask;

globalThis.chrome = {
  storage: { local: {
    setAccessLevel: async () => {}, get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)),
  } },
  runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
    onMessage: events(), onInstalled: events(), openOptionsPage: async () => {},
    sendMessage: async () => {},
  },
  tabs: {
    get: async id => structuredClone(tabRecord(id)),
    update: async (id, changes) => {
      const rec = tabRecord(id);
      updateCalls.push({ id, changes: structuredClone(changes) });
      if ('muted' in changes) rec.mutedInfo = { muted: changes.muted, reason: changes.muted ? 'extension' : undefined };
      return structuredClone(rec);
    },
    // The badge/cursor feedback in background.js pushes state to content scripts and listens for
    // tab activation and window focus. None of that touches muting, so it is stubbed inert here:
    // no content script answers the ping, which is exactly the "nothing injected" path.
    query: async ({ windowId }) => [{ ...tabRecord(20), windowId, active: true }],
    sendMessage: async () => undefined,
    onCreated: events(), onUpdated: events(), onActivated: events(), onRemoved: events(),
  },
  windows: { onFocusChanged: events(), update: async () => {} },
  debugger: { onDetach: events() }, sidePanel: { setPanelBehavior: async () => {} },
};
mock.module('./extension/browser.js', { namedExports: {
  supportedUrl: url => /^https?:/.test(url),
  ChromePage: class {
    constructor(tab, signal) { this.tabId = tab.id; this.signal = signal; }
    async attach() { this.attached = true; }
    async detach() { this.attached = false; }
  },
} });
mock.module('./agent.ts', { namedExports: { runTask: async (_page, input, emit, signal) => {
  capturedSelect = input.browserTabs.select;
  await new Promise(resolve => {
    finishTask = resolve;
    signal.addEventListener('abort', resolve, { once: true });
  });
  emit({ type: 'end', status: signal.aborted ? 'stopped' : 'done', message: 'done', totalCostUsd: 0 });
} } });
await import('./extension/background.js');
const send = message => new Promise(resolve => chrome.runtime.onMessage.fire(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve));
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('operation did not finish');
};

test('background agent tabs are muted while not watched, and only checkto-muted tabs get unmuted on reactivation', async () => {
  // Tab 20 is the tab the run starts on. It becomes the sole watched tab first.
  assert.equal((await send({ type: 'run', tabId: 20, goal: 'test', mode: 'fast' })).ok, true);
  await until(() => capturedSelect !== undefined);

  // Tab 21 opens as a popup from 20 and takes over as the watched tab: 20 drops to the
  // background and must get muted by us.
  chrome.tabs.onCreated.fire({ id: 21, openerTabId: 20, url: 'https://example.test/popup-1' });
  await until(() => tabRecord(20).mutedInfo.muted === true);
  assert.deepEqual(updateCalls.filter(c => c.id === 20), [{ id: 20, changes: { muted: true } }]);
  assert.equal(tabRecord(20).mutedInfo.reason, 'extension');

  // The user (not this extension) mutes tab 21 by hand before a third tab takes focus.
  tabRecord(21).mutedInfo = { muted: true, reason: 'user' };
  const updatesBeforeTab22 = updateCalls.length;

  // Tab 22 opens as a popup from 21 and takes over: both 20 (already muted by us) and
  // 21 (already muted, but not by us) are background tabs now. Neither should be touched.
  chrome.tabs.onCreated.fire({ id: 22, openerTabId: 21, url: 'https://example.test/popup-2' });
  await until(() => updateCalls.length > updatesBeforeTab22 || tabRecord(22).mutedInfo.muted !== undefined);
  assert.equal(updateCalls.some(c => c.id === 21), false, 'an unrelated already-muted tab must be left alone');
  assert.equal(tabRecord(21).mutedInfo.reason, 'user');

  // Reactivating tab 21 (the agent switches its watched tab back) must NOT unmute it:
  // its lease was never marked mutedByUs, so checkto never touches it.
  const updatesBeforeReactivate21 = updateCalls.length;
  await capturedSelect(21);
  assert.equal(updateCalls.slice(updatesBeforeReactivate21).some(c => c.id === 21 && c.changes.muted === false), false);
  assert.equal(tabRecord(21).mutedInfo.muted, true);

  // Reactivating tab 20 (which checkto itself muted) must unmute it.
  await capturedSelect(20);
  assert.equal(tabRecord(20).mutedInfo.muted, false);
  assert.equal(updateCalls.some(c => c.id === 20 && c.changes.muted === false), true);

  finishTask();
  await until(() => data.runState?.running === false);
});
