import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as lease from '../extension/lease.js';
import { setFaviconRestorer } from '../extension/tabs.js';

const events = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), fire: (...args) => [...listeners].map(f => f(...args)) };
};
// Survives a simulated service-worker restart, the way chrome.storage.local does.
const storage = { settings: { openrouterKey: 'private-test-key', model: 'fixture/model' } };
const calls = [];
const open = new Map();
const openTab = (id, extra = {}) => open.set(id, { id, url: `https://example.test/${id}`, title: `tab ${id}`, windowId: 1, active: false, ...extra });
let nextGroupId = 700;
let turns = 0;
let script = async () => ({ status: 'done', message: 'finished' });

globalThis.chrome = {
  storage: { local: {
    setAccessLevel: async () => {}, get: async key => ({ [key]: structuredClone(storage[key]) }),
    set: async values => Object.assign(storage, structuredClone(values)),
  } },
  runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
    onMessage: events(), onInstalled: events(), openOptionsPage: async () => {}, sendMessage: async () => {} },
  tabs: {
    get: async id => { const tab = open.get(id); if (!tab) throw new Error(`No tab with id: ${id}`); return { ...tab }; },
    update: async (id, props) => { calls.push(['update', id, props]); Object.assign(open.get(id) || {}, props); return open.get(id); },
    remove: async id => { calls.push(['remove', id]); open.delete(id); },
    group: async info => {
      calls.push(['group', info]);
      const groupId = info.groupId ?? nextGroupId++;
      for (const id of info.tabIds) Object.assign(open.get(id) || {}, { groupId });
      return groupId;
    },
    ungroup: async tabIds => { calls.push(['ungroup', tabIds]); },
    query: async () => [...open.values()],
    // The in-page badge/cursor feedback in background.js pushes state to content scripts and
    // watches tab activation and window focus. Stubbed inert here: no content script answers the
    // ping, which is the "nothing injected" path, and none of it touches the tab contract.
    sendMessage: async () => undefined,
    onCreated: events(), onUpdated: events(), onActivated: events(), onRemoved: events(),
  },
  tabGroups: { update: async (id, props) => { calls.push(['groupUpdate', id, props]); return { id, ...props }; } },
  action: { setBadgeText: async a => { calls.push(['badgeText', a]); }, setBadgeBackgroundColor: async a => { calls.push(['badgeColor', a]); } },
  windows: { update: async () => {}, onFocusChanged: events() },
  // Host access is not what this file is about: the origin is already granted.
  permissions: { contains: async () => true, request: async () => true },
  debugger: { onDetach: events() },
  sidePanel: { setPanelBehavior: async () => {} },
};
mock.module('../extension/browser.js', { namedExports: {
  supportedUrl: url => /^https?:/.test(url),
  ChromePage: class {
    constructor(tab, signal, pages) { this.tabId = tab.id; this.signal = signal; this.pages = pages; }
    async attach() { this.attached = true; }
    async detach() { this.attached = false; }
  },
} });
mock.module('../src/agent.ts', { namedExports: { runTask: async (_page, _input, emit, signal) => {
  turns++;
  const end = await script({ emit, signal });
  emit({ type: 'end', totalCostUsd: 0, ...end });
} } });
await import('../extension/background.js');
setFaviconRestorer(async tabId => { calls.push(['favicon', tabId]); });

const send = message => new Promise(resolve => chrome.runtime.onMessage.fire(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve));
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('operation did not finish');
};
const spawn = id => { openTab(id); chrome.tabs.onCreated.fire({ ...open.get(id), openerTabId: 9 }); };

test('a run ending keeps openedByUs popups as deliverable without a mark event, and leaves the user tab alone', async () => {
  openTab(9, { active: true }); // the tab the user handed over
  script = async () => {
    spawn(21); spawn(22); spawn(23);
    await until(() => [21, 22, 23].every(id => lease.get(id)?.openedByUs === true));
    return { status: 'done', message: 'finished' };
  };
  assert.equal((await send({ type: 'run', tabId: 9, goal: 'book it', mode: 'fast' })).ok, true);
  await until(() => storage.runState?.running === false);

  // opened by us, still attached, run done: open, ungrouped, green, no longer leased. The agent
  // emitted no mark; execute marked every still-attached openedByUs tab deliverable.
  for (const id of [21, 22, 23]) {
    assert.equal(open.has(id), true, `popup ${id} stays open`);
    assert.equal(lease.get(id), undefined, `popup ${id} is unleased`);
    assert.deepEqual(calls.find(c => c[0] === 'badgeColor' && c[1].tabId === id)[1], { tabId: id, color: '#22c55e' });
  }
  assert.deepEqual(calls.filter(c => c[0] === 'ungroup').map(c => c[1]), [[21], [22], [23]]);
  assert.equal(calls.some(c => c[0] === 'remove' && [21, 22, 23].includes(c[1])), false, 'no openedByUs popup is closed');
  // the user's own tab is released, never closed and never grouped.
  assert.equal(open.has(9), true);
  assert.equal(lease.get(9), undefined);
  assert.equal(calls.some(c => c[0] === 'group' && c[1].tabIds.includes(9)), false);
  assert.equal(calls.some(c => c[0] === 'remove' && c[1] === 9), false);
});

test('the checkto group is created once and a restarted worker rejoins it', async () => {
  const grouped = calls.filter(c => c[0] === 'group');
  assert.deepEqual(grouped.map(c => c[1].tabIds), [[21], [22], [23]]);
  const creates = grouped.filter(c => c[1].groupId === undefined);
  assert.equal(creates.length, 1, 'only the first agent tab creates the group');
  const groupId = open.get(21).groupId;
  assert.equal(grouped.at(-1)[1].groupId, groupId);
  const titled = calls.filter(c => c[0] === 'groupUpdate');
  assert.equal(titled.length, 1);
  assert.equal(titled[0][1], groupId);
  assert.equal(titled[0][2].title, 'checkto');
  assert.equal(titled[0][2].collapsed, false);
  assert.equal(storage.tabGroup.id, groupId);

  // A restarted service worker is a fresh module with nothing in memory but the same storage.
  const restarted = await import('../extension/tabs.js?restart=1');
  openTab(31);
  lease.claim(31, { sessionId: 'restarted-session', turnId: 'turn-r', openedByUs: true });
  await restarted.groupTab(31);
  assert.equal(open.get(31).groupId, groupId, 'the restarted worker rejoins the stored group');
  assert.equal(calls.filter(c => c[0] === 'group' && c[1].groupId === undefined).length, 1, 'no second group is created');
  lease.release(31);
});

test('the next turn resumes a surviving handoff tab and drops the one the user closed', async () => {
  // A waiting run hands the current tab over; that is what the next turn resumes, not a fake mark.
  script = async () => {
    spawn(41);
    await until(() => lease.get(41)?.openedByUs === true);
    open.get(41).active = true;
    return { status: 'needs_input', message: 'approve?', requests: [{ id: 'h', type: 'approval', action: 'submit' }] };
  };
  await send({ type: 'run', tabId: 9, goal: 'need a sign-off', mode: 'fast' });
  await until(() => storage.runState?.running === false);
  const handedOff = lease.get(41);
  assert.equal(handedOff.disposition, 'handoff');
  const previousTurn = handedOff.turnId;
  // A second handed-off tab, which the user closed before the next turn.
  lease.claim(42, { sessionId: handedOff.sessionId, turnId: previousTurn, openedByUs: true });
  lease.mark(42, 'handoff');
  open.get(9).active = true;

  await send({ type: 'stop' });
  await until(() => (storage.runState.requests || []).length === 0);

  let probe;
  const mark = calls.length;
  script = async () => {
    probe = { resumed: structuredClone(lease.get(41)), dropped: lease.get(42), stillOpen: open.has(41) };
    return { status: 'done', message: 'finished again' };
  };
  const before = turns;
  await send({ type: 'run', tabId: 9, goal: 'carry on', mode: 'fast' });
  await until(() => turns === before + 1 && storage.runState?.running === false);

  assert.equal(probe.resumed.tabId, 41, 'the surviving handoff tab is still leased');
  assert.notEqual(probe.resumed.turnId, previousTurn, 'it is resumed under the new turn id');
  assert.equal(probe.resumed.disposition, undefined, 'and is no longer a tab that was left behind');
  assert.equal(probe.stillOpen, true, 'it is never reloaded or reopened, so origin and viewport survive');
  assert.equal(probe.dropped, undefined, 'the tab the user closed is dropped silently');
  const resumeCalls = calls.slice(mark);
  assert.equal(resumeCalls.some(c => c[0] === 'update' && c[1] === 41 && c[2].active === true), true, 'the active handoff tab is put back in front');
  assert.equal(resumeCalls.some(c => c[0] === 'remove' && c[1] === 42), false, 'a tab the user already closed is not chased');
  assert.equal(storage.runState.messages.at(-1).text, 'finished again');
});

test('the manifest asks for the tabGroups permission the group needs', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.equal(manifest.permissions.includes('tabGroups'), true);
});
