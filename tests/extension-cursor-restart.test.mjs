import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The service worker is killed on idle and restarted with nothing in memory but chrome.storage.
// feedbackByTab is restored from there so badges (unread markers) survive; the cursor must not:
// it pointed at what a run that died with the old worker was about to press, and the content
// scripts on those tabs, which did not restart, are still drawing it. This file boots background.js
// once, into exactly that storage, so it is separate from extension-background.test.mjs (a second
// import there would register every listener twice on the shared chrome stub).
const events = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), fire: (...args) => [...listeners].map(f => f(...args)) };
};
const data = {
  settings: { openrouterKey: 'private-test-key', model: 'fixture/model' },
  seq: 40,
  // What the old worker left behind: one tab mid-click with a pointer on it, one finished tab with
  // an unread badge and no pointer, one observed tab with both.
  feedbackByTab: [
    [21, { badge: 'working', cursor: { x: 120, y: 340 }, observed: false }],
    [22, { badge: 'deliverable', cursor: undefined, observed: false }],
    [23, { badge: 'handoff', cursor: { x: 5, y: 6 }, observed: true }],
  ],
};
const sets = [];
const sentToTabs = [];
const pick = (keys, source) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(source[k])]));
globalThis.chrome = {
  storage: { local: {
    setAccessLevel: async () => {},
    get: async keys => pick(keys, data),
    set: async values => { sets.push(structuredClone(values)); Object.assign(data, structuredClone(values)); },
  } },
  runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
    onMessage: events(), onInstalled: events(), openOptionsPage: async () => {}, getContexts: async () => [], sendMessage: async () => {} },
  tabs: {
    get: async id => ({ id, url: 'https://example.test', title: 'Fixture', windowId: 1, active: false }),
    query: async () => [],
    sendMessage: async (tabId, message) => { sentToTabs.push({ tabId, message }); return { ok: true }; },
    onCreated: events(), onUpdated: events(), onActivated: events(), onRemoved: events(),
  },
  windows: { onFocusChanged: events(), get: async () => ({ focused: false }) },
  permissions: { contains: async () => true, request: async () => { throw new Error('no user gesture in a worker'); } },
  debugger: { onDetach: events() },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  commands: { onCommand: events() },
  contextMenus: { create: (_opts, cb) => cb?.(), removeAll: cb => cb(), onClicked: events() },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
};
mock.module('../src/transcribe.ts', { namedExports: {
  defaultTranscriptionSpec: provider => `${provider}:fixture`,
  transcribeCapability: () => ({ provider: 'openrouter', canTranscribe: false, streaming: false, reason: 'fixture' }),
} });
mock.module('../extension/browser.js', { namedExports: {
  supportedUrl: url => /^https?:/.test(url),
  setCursorSink: () => {},
  ChromePage: class { constructor(tab, signal) { this.tabId = tab.id; this.signal = signal; } async attach() {} async detach() {} },
} });
mock.module('../src/agent.ts', { namedExports: { runTask: async () => { throw new Error('no run in this fixture'); } } });
await import('../extension/background.js');
const send = message => new Promise(resolve => chrome.runtime.onMessage.fire(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve));
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('operation did not finish');
};
const contentStates = tabId => sentToTabs.filter(s => s.tabId === tabId && s.message.type === 'CONTENT_STATE').map(s => s.message.state);

test('a restarted worker keeps the badges it persisted but discards every cursor, then persists and pushes the cleanup', async () => {
  // getState waits on the worker's `ready`, i.e. on the restore having run.
  assert.equal((await send({ type: 'getState' })).configured, true);
  // In memory: badges as they were, no coordinates anywhere.
  assert.equal((await send({ type: 'getBadge', tabId: 21 })).badge, 'working');
  assert.equal((await send({ type: 'getBadge', tabId: 22 })).badge, 'deliverable');
  assert.equal((await send({ type: 'getBadge', tabId: 23 })).badge, 'handoff');
  const ask = tabId => new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'CONTENT_STATE_REQUEST' }, { id: chrome.runtime.id, url: 'https://example.test', tab: { id: tabId } }, resolve));
  assert.deepEqual((await ask(21)).state, { badge: 'working', cursor: undefined, observed: false });
  assert.deepEqual((await ask(23)).state, { badge: 'handoff', cursor: undefined, observed: true });
  // Persisted: the stored copy no longer carries the stale coordinates, so a second restart would not either.
  await until(() => sets.some(s => Array.isArray(s.feedbackByTab)));
  const stored = new Map(data.feedbackByTab);
  assert.equal(stored.size, 3);
  for (const [, held] of stored) assert.equal(held.cursor, undefined);
  assert.equal(stored.get(21).badge, 'working');
  assert.equal(stored.get(23).observed, true);
  // Pushed: the two tabs whose content scripts were still drawing a pointer are told to take it down;
  // the tab that never had one is left alone.
  await until(() => contentStates(21).length && contentStates(23).length);
  assert.deepEqual(contentStates(21).at(-1), { badge: 'working', cursor: undefined, observed: false });
  assert.deepEqual(contentStates(23).at(-1), { badge: 'handoff', cursor: undefined, observed: true });
  assert.equal(contentStates(22).length, 0);
  // Both pushes were preceded by the liveness ping, so a page whose script died is not written to.
  for (const tabId of [21, 23]) assert.equal(sentToTabs.find(s => s.tabId === tabId).message.type, 'CONTENT_PING');
  // One write for the whole cleanup, not one per tab, and nothing else touched the record since.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sets.filter(s => Array.isArray(s.feedbackByTab)).length, 1);
});
