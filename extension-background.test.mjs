import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const events = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), fire: (...args) => [...listeners].map(f => f(...args)) };
};
const data = { settings: { openrouterKey: 'private-test-key', model: 'fixture/model' } };
const messages = [];
const sentToTabs = [];
let liveContentScript = true;
const pages = [];
let activeSignal;
let taskStarted = 0;
let finishTask;
let attachGate;
const accessPrompts = [];
const grantedOrigins = [];
let allowAccess = true;
const sidePanelOpens = [];
const menuCreated = [];
let pendingRequest; // set to make the fixture run end waiting on the user
let nextOutcome; // set to make the fake run end straight away with that outcome
let lastInput;

globalThis.chrome = {
  storage: { local: {
    setAccessLevel: async () => {}, get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)),
  } },
  runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
    onMessage: events(), onInstalled: events(), openOptionsPage: async () => {},
    sendMessage: async message => {
      messages.push(structuredClone(message));
      // Standing in for the panel: its Allow click is what asks Chrome, so a yes is also a grant.
      if (message.type === 'permission') {
        accessPrompts.push(message.prompt);
        if (allowAccess) grantedOrigins.push(...message.prompt.origins);
        return { allow: allowAccess };
      }
    },
  },
  tabs: {
    get: async id => ({ id, url: 'https://example.test', title: 'Fixture' }),
    // Window 7's active tab is 12. The keyboard shortcut asks for the current window instead of
    // naming one, and gets the same tab back, so it has a windowId to open the panel on.
    query: async ({ windowId, currentWindow } = {}) => (currentWindow
      ? [{ id: 12, windowId: 7, url: 'https://example.test', active: true }]
      : [{ id: windowId === 7 ? 12 : 99, windowId, active: true }]),
    sendMessage: async (tabId, message) => { sentToTabs.push({ tabId, message }); return message.type === 'CONTENT_PING' ? { ok: liveContentScript } : { ok: true }; },
    onCreated: events(), onUpdated: events(), onActivated: events(), onRemoved: events(),
  },
  windows: { onFocusChanged: events() },
  permissions: {
    contains: async ({ origins }) => origins.every(o => grantedOrigins.includes(o)),
    // Chrome refuses this outside a user gesture, and a service worker never has one.
    request: async () => { throw new Error('the service worker must not call permissions.request'); },
  },
  debugger: { onDetach: events() },
  sidePanel: { setPanelBehavior: async () => {}, open: async opts => { sidePanelOpens.push(opts); } },
  commands: { onCommand: events() },
  contextMenus: { create: (opts, cb) => { menuCreated.push(opts); cb?.(); }, removeAll: cb => cb(), onClicked: events() },
};
mock.module('./extension/browser.js', { namedExports: {
  supportedUrl: url => /^https?:/.test(url),
  ChromePage: class {
    constructor(tab, signal) { this.tabId = tab.id; this.signal = signal; pages.push(this); }
    async attach() { if (this.tabId === 99) throw new Error('popup attach refused'); if (attachGate) await attachGate; this.attached = true; this.signal.throwIfAborted(); }
    async detach() { this.attached = false; }
  },
} });
mock.module('./agent.ts', { namedExports: { runTask: async (_page, input, emit, signal) => {
  taskStarted++;
  activeSignal = signal;
  lastInput = input;
  emit({ type: 'step', step: 1, action: 'CLICK [5] button "upload"', plan: 'click upload', costUsd: 0 });
  if (nextOutcome) { const outcome = nextOutcome; nextOutcome = undefined; emit({ type: 'end', totalCostUsd: 0, ...outcome }); return; }
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

test('a new run is refused while a request is pending, and the request survives untouched', async () => {
  await send({ type: 'clear' });
  pendingRequest = { id: 'req-2', type: 'approval', action: 'submit this $500 order' };
  const before = taskStarted;
  try {
    await send({ type: 'run', tabId: 12, goal: 'submit this order', mode: 'fast' });
    await until(() => taskStarted === before + 1);
    finishTask();
    await until(() => data.runState?.running === false);
    assert.equal(data.runState.status, 'needs_input');
    assert.deepEqual(data.runState.requests.map(r => r.id), ['req-2']);

    // The user, seeing an ordinary-looking chat box, types "yes" instead of answering the card.
    // The handler must refuse the new run rather than silently overwriting `requests`.
    const attempt = await send({ type: 'run', tabId: 12, goal: 'yes', mode: 'fast' });
    assert.match(attempt.error, /pending request/);
    assert.equal(taskStarted, before + 1, 'no new run started over the pending request');
    assert.deepEqual(data.runState.requests.map(r => r.id), ['req-2'], 'the pending request is still there, not dropped');
    assert.equal(data.runState.declined, undefined, 'nothing was declined either: it is simply still waiting');

    // Answering the card properly still works afterwards -- the refusal is not a dead end.
    nextOutcome = { status: 'done', message: 'order submitted', totalCostUsd: 0 };
    await send({ type: 'answer', id: 'req-2', outcome: 'submitted', scope: 'once' });
    await until(() => data.runState?.status === 'done');
    assert.deepEqual(data.runState.requests, []);
  } finally { pendingRequest = undefined; }
});

test('a paused request carries the coverage/failure guards back in when the answer resumes the run', async () => {
  await send({ type: 'clear' });
  const resumeState = { goal: 'open the readme', history: ['step 1: did CLICK [1] link "README.md"'], step: 1, realActions: 1, pagesSeen: ['fp1'], coverageRefusals: 0 };
  const request = { id: 'ask-1', type: 'user_input', question: 'which README do you mean?' };
  nextOutcome = { status: 'needs_input', message: request.question, requests: [request], request, resumeState };
  await send({ type: 'run', tabId: 12, goal: 'open the readme', mode: 'careful' });
  await until(() => data.runState?.running === false);
  assert.equal(data.runState.status, 'needs_input');
  assert.equal(data.runState.messages.at(-1).text, 'which README do you mean?');
  assert.deepEqual(data.runState.resumeState, resumeState);

  nextOutcome = { status: 'done', message: 'finished', answer: 'opened the root readme' };
  await send({ type: 'answer', id: 'ask-1', text: 'the root one' });
  await until(() => data.runState?.status === 'done');
  assert.deepEqual(lastInput.resume, resumeState, "the answer carries the paused run's guards back into the agent");
  assert.equal(lastInput.goal, 'the root one');
  assert.equal(data.runState.resumeState, undefined);
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

// --- the favicon badge as an unread marker -----------------------------------------------------
const untilBadge = async (tabId, badge) => {
  for (let i = 0; i < 100; i++) {
    if ((await send({ type: 'getBadge', tabId })).badge === badge) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`tab ${tabId} never reached badge "${badge}"`);
};

test('a finished run leaves a badge that stays until the user looks at that tab', async () => {
  await send({ type: 'clear' });
  const before = taskStarted;
  await send({ type: 'run', tabId: 12, goal: 'upload the file', mode: 'fast' });
  await until(() => taskStarted === before + 1);
  assert.equal((await send({ type: 'getBadge', tabId: 12 })).badge, 'working');
  finishTask();
  await until(() => data.runState?.running === false);
  assert.equal((await send({ type: 'getBadge', tabId: 12 })).badge, 'deliverable');
  // Someone looking at a different tab has not read this result.
  chrome.tabs.onActivated.fire({ tabId: 5 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await send({ type: 'getBadge', tabId: 12 })).badge, 'deliverable');
  // Looking at the tab itself is what marks it read.
  chrome.tabs.onActivated.fire({ tabId: 12 });
  await untilBadge(12, 'none');
});

// A turn waiting on an answer is waiting on that very tab: the tab contract has to treat it exactly
// like a blocked one, or the sign-in tab the request card points at is closed under the user.
test('a turn that ends waiting hands its tab over instead of finishing with it', async () => {
  await send({ type: 'clear' });
  pendingRequest = { id: 'req-2', type: 'credential', kind: 'credential', origin: 'https://example.test', fields: [] };
  const before = taskStarted;
  try {
    await send({ type: 'run', tabId: 12, goal: 'sign in', mode: 'fast' });
    await until(() => taskStarted === before + 1);
    finishTask();
    await until(() => data.runState?.running === false);
    assert.equal(data.runState.status, 'needs_input');
    await untilBadge(12, 'handoff');
  } finally { pendingRequest = undefined; }
});

test('focusing a window clears the badge on the tab it reveals', async () => {
  await send({ type: 'setBadge', tabId: 12, badge: 'handoff' });
  assert.equal((await send({ type: 'getBadge', tabId: 12 })).badge, 'handoff');
  chrome.windows.onFocusChanged.fire(-1); // every window lost focus: nothing has been read
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await send({ type: 'getBadge', tabId: 12 })).badge, 'handoff');
  chrome.windows.onFocusChanged.fire(7); // window 7's active tab is 12
  await untilBadge(12, 'none');
});

test('the worker pings a tab before pushing, and pushes nothing to a script that does not answer', async () => {
  sentToTabs.length = 0;
  liveContentScript = false;
  await send({ type: 'setBadge', tabId: 21, badge: 'working' });
  assert.deepEqual(sentToTabs.map(s => s.message.type), ['CONTENT_PING']);
  liveContentScript = true;
  sentToTabs.length = 0;
  await send({ type: 'setBadge', tabId: 21, badge: 'deliverable' });
  assert.deepEqual(sentToTabs.map(s => s.message.type), ['CONTENT_PING', 'CONTENT_STATE']);
  assert.equal(sentToTabs.at(-1).message.state.badge, 'deliverable');
  assert.deepEqual(sentToTabs.map(s => s.tabId), [21, 21]);
});

test('a content script asks the worker for its own tab state instead of being assumed live', async () => {
  const ask = sender => new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'CONTENT_STATE_REQUEST' }, sender, resolve));
  assert.deepEqual(await ask({ id: chrome.runtime.id, url: 'https://example.test/page', tab: { id: 21 } }),
    { state: { badge: 'deliverable', cursor: undefined, observed: false } });
  // A message with no tab behind it is not a content script and gets no answer.
  let answered = false;
  chrome.runtime.onMessage.fire({ type: 'CONTENT_STATE_REQUEST' }, { id: chrome.runtime.id, url: 'https://example.test/page' }, () => { answered = true; });
  assert.equal(answered, false);
});

// --- the keyboard shortcut and the right-click entry -------------------------------------------
test('the context menu registers "Ask Checkto" on page, selection and link', () => {
  assert.equal(menuCreated.length, 1);
  assert.equal(menuCreated[0].id, 'ask-checkto');
  assert.deepEqual(menuCreated[0].contexts, ['page', 'selection', 'link']);
});

test('the open-panel keyboard command opens the side panel on the active tab window', async () => {
  const before = sidePanelOpens.length;
  chrome.commands.onCommand.fire('open-panel');
  await until(() => sidePanelOpens.length === before + 1);
  assert.deepEqual(sidePanelOpens.at(-1), { windowId: 7 });
});

test('an unrelated command is ignored', async () => {
  const before = sidePanelOpens.length;
  chrome.commands.onCommand.fire('some-other-command');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sidePanelOpens.length, before);
});

test('right-clicking a selection sends it into a new chat run', async () => {
  await send({ type: 'clear' });
  const started = taskStarted;
  chrome.contextMenus.onClicked.fire({ menuItemId: 'ask-checkto', selectionText: 'hello world' }, { id: 21, windowId: 7, url: 'https://example.test' });
  await until(() => taskStarted === started + 1);
  await until(() => sidePanelOpens.at(-1)?.windowId === 7);
  assert.equal(data.runState.messages.at(-1).text, 'help me with this selection: "hello world"');
  finishTask();
  await until(() => data.runState?.running === false);
});

test('right-clicking a link sends the link URL into a new chat run', async () => {
  await send({ type: 'clear' });
  const started = taskStarted;
  chrome.contextMenus.onClicked.fire({ menuItemId: 'ask-checkto', linkUrl: 'https://example.test/page' }, { id: 22, windowId: 7, url: 'https://example.test' });
  await until(() => taskStarted === started + 1);
  assert.equal(data.runState.messages.at(-1).text, 'look at this link: https://example.test/page');
  finishTask();
  await until(() => data.runState?.running === false);
});

test('a different menu item or an unsupported tab is ignored', () => {
  const started = taskStarted;
  chrome.contextMenus.onClicked.fire({ menuItemId: 'something-else', selectionText: 'nope' }, { id: 23, windowId: 7, url: 'https://example.test' });
  chrome.contextMenus.onClicked.fire({ menuItemId: 'ask-checkto', selectionText: 'nope' }, { id: 24, windowId: 7, url: 'chrome://extensions' });
  assert.equal(taskStarted, started);
});

// Without these two manifest entries Chrome never fires either listener, so the code above is dead.
test('the manifest declares the shortcut and the contextMenus permission the entry points need', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.equal(manifest.permissions.includes('contextMenus'), true);
  assert.equal(manifest.commands['open-panel'].suggested_key.default, 'Ctrl+Shift+Period');
});

// --- host access is asked for before a site is touched -----------------------------------------
// Last in the file: it empties the granted origins, so anything after it would have to re-grant.
test('a run on a site checkto has no access to asks for that origin, and a no stops the run', async () => {
  await send({ type: 'clear' });
  grantedOrigins.length = 0;
  accessPrompts.length = 0;
  allowAccess = false;
  const before = taskStarted;
  await send({ type: 'run', tabId: 21, goal: 'open the page', mode: 'fast' });
  await until(() => data.runState?.running === false);
  assert.equal(accessPrompts.at(-1).title, 'allow checkto to access https://example.test?');
  assert.equal(accessPrompts.at(-1).scope, 'origin');
  assert.equal(taskStarted, before, 'no task may run before access is granted');
  assert.equal(data.runState.status, 'error');
  assert.match(data.runState.messages.at(-1).text, /needs your permission to use https:\/\/example\.test/);
  allowAccess = true;
});
