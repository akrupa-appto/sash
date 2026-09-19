import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const events = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), fire: (...args) => [...listeners].map(f => f(...args)) };
};
const data = { settings: { openrouterKey: 'private-test-key', model: 'fixture/model' } };
const messages = [];
const pages = [];
let activeSignal;
let taskStarted = 0;
let finishTask;
let attachGate;

globalThis.chrome = {
  storage: { local: {
    setAccessLevel: async () => {}, get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)),
  } },
  runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
    onMessage: events(), onInstalled: events(), openOptionsPage: async () => {},
    sendMessage: async message => { messages.push(structuredClone(message)); },
  },
  tabs: { get: async id => ({ id, url: 'https://example.test', title: 'Fixture' }), onCreated: events(), onUpdated: events() },
  debugger: { onDetach: events() }, sidePanel: { setPanelBehavior: async () => {} },
};
mock.module('./extension/browser.js', { namedExports: {
  supportedUrl: url => /^https?:/.test(url),
  ChromePage: class {
    constructor(tab, signal) { this.tabId = tab.id; this.signal = signal; pages.push(this); }
    async attach() { if (this.tabId === 99) throw new Error('popup attach refused'); if (attachGate) await attachGate; this.attached = true; this.signal.throwIfAborted(); }
    async detach() { this.attached = false; }
  },
} });
mock.module('./agent.ts', { namedExports: { runTask: async (_page, _input, emit, signal) => {
  taskStarted++;
  activeSignal = signal;
  await new Promise(resolve => {
    finishTask = resolve;
    signal.addEventListener('abort', resolve, { once: true });
  });
  emit({ type: 'end', status: signal.aborted ? 'stopped' : 'done', message: signal.aborted ? 'stopped' : 'finished', totalCostUsd: 0 });
} } });
await import('./extension/background.js');
const send = message => new Promise(resolve => chrome.runtime.onMessage.fire(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve));
const until = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('operation did not finish');
};

test('worker rejects simultaneous runs, aborts and detaches, and never broadcasts keys', async () => {
  assert.equal((await send({ type: 'getState' })).configured, true);
  assert.equal((await send({ type: 'run', tabId: 9, goal: 'test', mode: 'fast' })).ok, true);
  const duplicate = await send({ type: 'run', tabId: 10, goal: 'duplicate', mode: 'fast' });
  assert.match(duplicate.error, /already running/);
  await until(() => taskStarted === 1);
  assert.equal(pages[0].tabId, 9);
  await send({ type: 'stop' });
  await until(() => data.runState?.running === false);
  assert.equal(activeSignal.aborted, true);
  assert.equal(pages[0].attached, false);
  assert.equal(data.runState.status, 'stopped');
  assert.doesNotMatch(JSON.stringify(messages), /private-test-key/);
  assert.doesNotMatch(JSON.stringify(data.runState), /private-test-key/);
  await send({ type: 'clear' });
  assert.deepEqual(data.runState.messages, []);
});

test('stop while attach is pending detaches after the pending attach completes', async () => {
  let release;
  attachGate = new Promise(resolve => { release = resolve; });
  await send({ type: 'run', tabId: 11, goal: 'test', mode: 'fast' });
  await until(() => pages.length === 2);
  await send({ type: 'stop' });
  release();
  await until(() => data.runState?.running === false);
  assert.equal(pages[1].attached, false);
  assert.equal(taskStarted, 1);
  attachGate = undefined;
});

test('Chrome cancelling browser control aborts the current task', async () => {
  await send({ type: 'run', tabId: 12, goal: 'test', mode: 'fast' });
  await until(() => taskStarted === 2);
  chrome.debugger.onDetach.fire({ tabId: 12 }, 'canceled_by_user');
  await until(() => data.runState?.running === false);
  assert.equal(activeSignal.aborted, true);
  assert.equal(data.runState.status, 'stopped');
});

test('web pages cannot send extension control messages', () => {
  let replied = false;
  chrome.runtime.onMessage.fire({ type: 'run', tabId: 9, goal: 'untrusted' }, { id: chrome.runtime.id, url: 'https://example.test' }, () => { replied = true; });
  assert.equal(replied, false);
});


test('a failed popup attachment produces one terminal error message', async () => {
  await send({ type: 'clear' });
  await send({ type: 'run', tabId: 13, goal: 'test popup', mode: 'fast' });
  await until(() => taskStarted === 3);
  chrome.tabs.onCreated.fire({ id: 99, openerTabId: 13, url: 'https://example.test/popup' });
  await until(() => data.runState?.running === false);
  const replies = data.runState.messages.filter(m => m.role === 'agent');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'popup attach refused');
  assert.equal(data.runState.status, 'error');
});
