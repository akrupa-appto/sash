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
let pendingRequest; // set to make the fixture run end waiting on the user

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
  emit({ type: 'step', step: 1, action: 'CLICK [5] button "upload"', plan: 'click upload', costUsd: 0 });
  await new Promise(resolve => {
    finishTask = resolve;
    signal.addEventListener('abort', resolve, { once: true });
  });
  emit({
    type: 'end',
    status: signal.aborted ? 'stopped' : pendingRequest ? 'needs_input' : 'done',
    message: signal.aborted ? 'stopped' : 'finished',
    totalCostUsd: 0,
    ...(!signal.aborted && pendingRequest ? { requests: [pendingRequest], request: pendingRequest } : {}),
  });
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

test('Chrome cancelling browser control aborts the current task and explains what ended it', async () => {
  await send({ type: 'run', tabId: 12, goal: 'test', mode: 'fast' });
  await until(() => taskStarted === 2);
  pages.at(-1).currentTitle = 'Sign in - Google Accounts'; pages.at(-1).currentUrl = 'https://accounts.google.com/signin';
  chrome.debugger.onDetach.fire({ tabId: 12 }, 'canceled_by_user');
  await until(() => data.runState?.running === false);
  assert.equal(activeSignal.aborted, true);
  assert.equal(data.runState.status, 'blocked');
  const text = data.runState.messages.at(-1).text;
  assert.match(text, /browser control of "Sign in - Google Accounts" ended: Chrome's control banner was cancelled/);
  assert.match(text, /finish signing in on that page yourself, then say "go on"/);
});

test('the stop button still reports a plain stop', async () => {
  const started = taskStarted;
  await send({ type: 'run', tabId: 13, goal: 'test', mode: 'fast' });
  await until(() => taskStarted === started + 1);
  await send({ type: 'stop' });
  await until(() => data.runState?.running === false);
  assert.equal(data.runState.status, 'stopped');
  assert.equal(data.runState.messages.at(-1).text, 'stopped');
});

test('web pages cannot send extension control messages', () => {
  let replied = false;
  chrome.runtime.onMessage.fire({ type: 'run', tabId: 9, goal: 'untrusted' }, { id: chrome.runtime.id, url: 'https://example.test' }, () => { replied = true; });
  assert.equal(replied, false);
});


test('a failed popup attachment produces one terminal error message', async () => {
  await send({ type: 'clear' });
  const started = taskStarted;
  await send({ type: 'run', tabId: 13, goal: 'test popup', mode: 'fast' });
  await until(() => taskStarted === started + 1);
  chrome.tabs.onCreated.fire({ id: 99, openerTabId: 13, url: 'https://example.test/popup' });
  await until(() => data.runState?.running === false);
  const replies = data.runState.messages.filter(m => m.role === 'agent');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, 'popup attach refused');
  assert.equal(data.runState.status, 'error');
});


test('stopping a turn that is waiting declines the request instead of dropping it', async () => {
  await send({ type: 'clear' });
  pendingRequest = { id: 'req-1', type: 'approval', action: 'send the message' };
  const before = taskStarted;
  try {
    await send({ type: 'run', tabId: 12, goal: 'send it', mode: 'fast' });
    await until(() => taskStarted === before + 1);
    finishTask();
    await until(() => data.runState?.running === false);
    assert.equal(data.runState.status, 'needs_input');
    assert.deepEqual(data.runState.requests.map(r => r.id), ['req-1']);
    await send({ type: 'stop' });
    await until(() => (data.runState.requests || []).length === 0);
    assert.deepEqual(data.runState.declined, [{ id: 'req-1', type: 'approval', outcome: 'declined', reason: 'stopped' }]);
    // The decline counts: three of them and the agent stops asking this one altogether.
    assert.equal(data.runState.denials['approval:send the message'], 1);
    // An answer to a request nobody is waiting on any more is refused, not silently accepted.
    assert.match((await send({ type: 'answer', id: 'req-1', outcome: 'submitted', scope: 'once' })).error, /no longer waiting/);
  } finally { pendingRequest = undefined; }
});

test('a finished run keeps its actions on the reply it produced', async () => {
  await send({ type: 'clear' });
  const before = taskStarted;
  assert.equal((await send({ type: 'run', tabId: 12, goal: 'upload the file', mode: 'fast' })).ok, true);
  await until(() => taskStarted === before + 1);
  finishTask();
  await until(() => data.runState?.running === false);
  const reply = data.runState.messages.at(-1);
  assert.equal(reply.role, 'agent');
  assert.equal(reply.text, 'finished');
  assert.deepEqual(reply.steps.map(s => s.action), ['CLICK [5] button "upload"']);
});
