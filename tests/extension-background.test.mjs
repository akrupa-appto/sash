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
let stepsToEmit; // set to make the fake run report these steps instead of its one default step
let lastInput;
// Voice dictation: stands in for the offscreen document's own lifecycle and message replies.
let offscreenDocs = 0;
let offscreenStartResult = { ok: true };
let offscreenStopResult = { text: 'hello from the mic' };
let storageFails = false; // proves a failed settings read can never strand a hot mic
const tabsCreated = [];
let cursorSink; // background.js installs this into browser.js; tests drive it the way point() does

globalThis.chrome = {
  storage: { local: {
    setAccessLevel: async () => {},
    get: async key => {
      if (storageFails) throw new Error('storage read failed');
      return { [key]: structuredClone(data[key]) };
    },
    set: async values => Object.assign(data, structuredClone(values)),
  } },
  runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
    onMessage: events(), onInstalled: events(), openOptionsPage: async () => {},
    // Real Chrome's recommended way to check for an existing offscreen document.
    getContexts: async () => (offscreenDocs > 0 ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    sendMessage: async message => {
      messages.push(structuredClone(message));
      // Standing in for the panel: its Allow click is what asks Chrome, so a yes is also a grant.
      if (message.type === 'permission') {
        accessPrompts.push(message.prompt);
        if (allowAccess) grantedOrigins.push(...message.prompt.origins);
        return { allow: allowAccess };
      }
      // Standing in for the offscreen document answering background's start/stop commands.
      if (message.type === 'offscreen:start') return offscreenStartResult;
      if (message.type === 'offscreen:stop') return offscreenStopResult;
    },
  },
  tabs: {
    get: async id => ({ id, url: 'https://example.test', title: 'Fixture' }),
    update: async (id, props) => ({ id, ...props }),
    create: async opts => { tabsCreated.push(opts); return { id: 999, ...opts }; },
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
  offscreen: {
    createDocument: async () => { offscreenDocs++; },
    closeDocument: async () => { offscreenDocs = Math.max(0, offscreenDocs - 1); },
  },
};
// The real transcribeCapability() (unmocked) reads process.env directly in this raw, unbundled
// test run — src/transcribe.ts's own "./env.ts" import only gets aliased to extension/config.js
// (and so to the extension settings this file drives through `data.settings`) by the esbuild step
// that builds the shipped extension bundle (scripts/build-extension.mjs). Mocked here so these
// voice tests exercise background.js's own logic against `data.settings`, not this process's real
// environment variables; transcribeCapability's own provider-resolution logic has its coverage in
// tests/transcribe.test.mjs.
mock.module('../src/transcribe.ts', { namedExports: {
  defaultTranscriptionSpec: provider => ({
    openrouter: 'openai/whisper-1',
    openai: 'openai:whisper-1',
    gemini: 'gemini:gemini-2.5-flash',
    custom: 'custom:whisper-1',
  })[provider],
  transcribeCapability: spec => {
    const provider = spec?.startsWith('openai:') ? 'openai' : spec?.startsWith('gemini:') ? 'gemini' : spec?.startsWith('custom:') ? 'custom' : 'openrouter';
    const key = { openrouter: data.settings.openrouterKey, openai: data.settings.openaiKey, gemini: data.settings.geminiKey, custom: data.settings.customKey }[provider];
    return key ? { provider, canTranscribe: true, streaming: false } : { provider, canTranscribe: false, streaming: false, reason: `${provider} needs a key to transcribe audio` };
  },
} });
mock.module('../extension/browser.js', { namedExports: {
  supportedUrl: url => /^https?:/.test(url),
  setCursorSink: fn => { cursorSink = fn; },
  ChromePage: class {
    constructor(tab, signal) { this.tabId = tab.id; this.signal = signal; pages.push(this); }
    async attach() { if (this.tabId === 99) throw new Error('popup attach refused'); if (attachGate) await attachGate; this.attached = true; this.signal.throwIfAborted(); }
    async detach() { this.attached = false; }
  },
} });
mock.module('../src/agent.ts', { namedExports: { runTask: async (_page, input, emit, signal) => {
  taskStarted++;
  activeSignal = signal;
  lastInput = input;
  for (const s of stepsToEmit ?? [{ step: 1, action: 'CLICK [5] button "upload"', plan: 'click upload' }]) emit({ type: 'step', costUsd: 0, ...s });
  stepsToEmit = undefined;
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
await import('../extension/background.js');
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

// The same failure, arriving one await later: the run reports "done" while a popup attach is still in
// flight, and that attach then fails. The run it belongs to is an error, so the tabs it opened must not
// be left as green results -- the contract marks them deliverable (kept open, green dot) off the
// un-normalized outcome, and only converted the popup error after those marks had been made.
test('an attach that fails after the run reported done is a failed run, not a green result', async () => {
  await send({ type: 'clear' });
  const before = taskStarted;
  await send({ type: 'run', tabId: 12, goal: 'open a popup', mode: 'fast' });
  await until(() => taskStarted === before + 1);
  // One popup the run opens attaches for real: that tab is what the bug would leave behind.
  chrome.tabs.onCreated.fire({ id: 96, openerTabId: 12, url: 'https://example.test/first' });
  await until(() => pages.some(p => p.tabId === 96 && p.attached));
  let failAttach;
  attachGate = new Promise((_resolve, reject) => { failAttach = reject; });
  try {
    // A second popup is held mid-attach while the run finishes.
    chrome.tabs.onCreated.fire({ id: 97, openerTabId: 12, url: 'https://example.test/second' });
    finishTask();
    failAttach(new Error('popup attach refused'));
    await until(() => data.runState?.running === false);
    assert.equal(data.runState.status, 'error');
    assert.equal(data.runState.messages.at(-1).text, 'popup attach refused');
    assert.notEqual((await send({ type: 'getBadge', tabId: 96 })).badge, 'deliverable', 'a tab the failed run opened is not a result');
    assert.notEqual((await send({ type: 'getBadge', tabId: 12 })).badge, 'deliverable');
  } finally {
    attachGate = undefined;
  }
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
  assert.equal(lastInput.resume.goal, resumeState.goal);
  assert.deepEqual(lastInput.resume.history, resumeState.history);
  assert.equal(lastInput.resume.step, resumeState.step);
  assert.equal(lastInput.resume.resolution?.kind, 'answer');
  assert.equal(lastInput.resume.resolution?.text, 'the root one');
  assert.equal(lastInput.goal, 'open the readme');
  assert.equal(data.runState.resumeState, undefined);
  assert.deepEqual(data.runState.messages.filter(m => m.role === 'user').map(m => m.text), ['open the readme', 'the root one']);
});

test('a careful run that pauses on approval resumes in careful mode without a fake "go on"', async () => {
  await send({ type: 'clear' });
  const previousMode = data.settings.mode;
  data.settings = { ...data.settings, mode: 'fast' };
  try {
    const resumeState = { goal: 'delete the account', history: ['step 1: opened settings'], step: 1 };
    const request = { id: 'appr-1', type: 'approval', action: 'click the "Delete account" button' };
    nextOutcome = { status: 'needs_input', message: 'approve deleting the account?', requests: [request], request, resumeState };
    await send({ type: 'run', tabId: 12, goal: 'delete the account', mode: 'careful' });
    await until(() => data.runState?.running === false);
    assert.equal(data.runState.status, 'needs_input');
    assert.equal(data.runState.mode, 'careful');

    nextOutcome = { status: 'done', message: 'deleted' };
    await send({ type: 'answer', id: 'appr-1', outcome: 'submitted', scope: 'once' });
    await until(() => data.runState?.status === 'done');
    assert.equal(lastInput.supervisor, true, 'settings are fast; the paused run was careful and must stay careful');
    assert.equal(lastInput.resume.resolution?.kind, 'approved');
    assert.equal(lastInput.resume.resolution?.action, 'click the "Delete account" button');
    assert.equal(lastInput.resume.resolution?.scope, 'once');
    assert.equal(lastInput.goal, 'delete the account');
    assert.equal(data.runState.messages.some(m => m.role === 'user' && m.text === 'go on'), false);
    assert.deepEqual(data.runState.messages.filter(m => m.role === 'user').map(m => m.text), ['delete the account']);
  } finally { data.settings = { ...data.settings, mode: previousMode }; }
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

// The reply used to keep only the last 60 steps. The panel's trace header reports the run's step count
// off that array and marks where an action failed, so an 80-step run read "60 steps" and a failure on
// step 1 vanished from both the track and the row list once the run ended.
test('a long run keeps every step on its reply, including an early failure, so the finished trace counts and marks the run truthfully', async () => {
  await send({ type: 'clear' });
  const before = taskStarted;
  stepsToEmit = Array.from({ length: 80 }, (_, i) => ({
    step: i + 1, action: `CLICK [${i}] link "next"`, plan: `click next (${i + 1})`,
    ...(i === 0 ? { note: 'action failed: Error: the control is covered or not visible' } : {}),
  }));
  assert.equal((await send({ type: 'run', tabId: 12, goal: 'sweep the archive', mode: 'fast' })).ok, true);
  await until(() => taskStarted === before + 1);
  // Live state already holds all 80; the terminal reply must carry the same, not a tail.
  assert.equal(data.runState.steps.length, 80);
  finishTask();
  await until(() => data.runState?.running === false);
  const reply = data.runState.messages.at(-1);
  assert.equal(reply.steps.length, 80);
  assert.equal(reply.steps[0].step, 1);
  assert.match(reply.steps[0].note, /^action failed/);
  assert.equal(reply.steps.at(-1).step, 80);
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

// --- the agent cursor: from an action's coordinates to the page, and back off it ---------------
const contentStates = tabId => sentToTabs.filter(s => s.tabId === tabId && s.message.type === 'CONTENT_STATE').map(s => s.message.state);

test('an action moving the cursor reaches the page as a position, gated by whether the tab is observed', async () => {
  assert.equal(typeof cursorSink, 'function', 'background.js installs the sender into browser.js');
  sentToTabs.length = 0;
  // A tab nobody is looking at: the worker keeps the position and tells the page not to paint it.
  const held = await cursorSink(31, { x: 120, y: 340 });
  assert.deepEqual(held, { badge: 'none', cursor: { x: 120, y: 340 }, observed: false });
  assert.deepEqual(contentStates(31), [{ badge: 'none', cursor: { x: 120, y: 340 }, observed: false }]);
  // The user switches to it: the same position is now painted, and the next move reports observed.
  chrome.tabs.onActivated.fire({ tabId: 31 });
  await until(() => contentStates(31).some(s => s.observed));
  assert.deepEqual(contentStates(31).at(-1), { badge: 'none', cursor: { x: 120, y: 340 }, observed: true });
  const next = await cursorSink(31, { x: 400, y: 80 });
  assert.equal(next.observed, true);
  assert.deepEqual(contentStates(31).at(-1).cursor, { x: 400, y: 80 });
});

test('a navigation drops the cursor: the new document is not told where the old one was clicked', async () => {
  sentToTabs.length = 0;
  await cursorSink(32, { x: 50, y: 50 });
  chrome.tabs.onUpdated.fire(32, { status: 'loading' }, { id: 32 });
  // The leaving page is not written to; the arriving copy of content.js pulls state and gets no cursor.
  assert.equal(contentStates(32).length, 1);
  const ask = () => new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'CONTENT_STATE_REQUEST' }, { id: chrome.runtime.id, url: 'https://example.test/next', tab: { id: 32 } }, resolve));
  assert.deepEqual((await ask()).state.cursor, undefined);
  chrome.tabs.onUpdated.fire(32, { status: 'complete' }, { id: 32 });
  await until(() => contentStates(32).length === 2);
  assert.equal(contentStates(32).at(-1).cursor, undefined);
});

test('a same-document URL change (pushState, hash route) drops the cursor and tells the surviving content script', async () => {
  sentToTabs.length = 0;
  await cursorSink(33, { x: 50, y: 50 });
  assert.deepEqual(contentStates(33).at(-1).cursor, { x: 50, y: 50 });
  // No status change: the document did not reload, so the content script that drew the pointer is still there.
  chrome.tabs.onUpdated.fire(33, { url: 'https://example.test/#/step-2' }, { id: 33, url: 'https://example.test/#/step-2' });
  await until(() => contentStates(33).length === 2);
  assert.equal(contentStates(33).at(-1).cursor, undefined, 'the live page is told to take the pointer down');
  assert.equal(contentStates(33).at(-1).badge, 'none', 'only the cursor goes; the badge is untouched');
  await until(() => data.feedbackByTab?.some(([id, held]) => id === 33 && held.cursor === undefined));
  // The same change with no cursor held is a no-op: nothing to persist, nothing to push.
  chrome.tabs.onUpdated.fire(33, { url: 'https://example.test/#/step-3' }, { id: 33 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(contentStates(33).length, 2);
});

test('the cursor is cleared from every tab when the run ends, is stopped, or the chat is cleared', async () => {
  await send({ type: 'clear' });
  // Ended: the end-of-turn sweep leaves the badge but never the cursor.
  let before = taskStarted;
  await send({ type: 'run', tabId: 12, goal: 'buy it', mode: 'fast' });
  await until(() => taskStarted === before + 1);
  await cursorSink(12, { x: 10, y: 20 });
  assert.deepEqual(contentStates(12).at(-1).cursor, { x: 10, y: 20 });
  finishTask();
  await until(() => data.runState?.running === false);
  assert.deepEqual(contentStates(12).at(-1), { badge: 'deliverable', cursor: undefined, observed: false });
  // Stopped: same sweep, on the user's stop.
  await send({ type: 'clear' });
  before = taskStarted;
  await send({ type: 'run', tabId: 13, goal: 'buy it', mode: 'fast' });
  await until(() => taskStarted === before + 1);
  await cursorSink(13, { x: 10, y: 20 });
  await send({ type: 'stop' });
  await until(() => data.runState?.running === false);
  assert.equal(contentStates(13).at(-1).cursor, undefined);
  // New chat: a position left on a tab from an earlier turn goes with it.
  await cursorSink(14, { x: 1, y: 2 });
  await send({ type: 'clear' });
  assert.equal(contentStates(14).at(-1).cursor, undefined);
  assert.equal((await send({ type: 'getBadge', tabId: 14 })).badge, 'none');
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

// --- voice dictation: offscreen document lifecycle ----------------------------------------------
test('starting dictation creates the offscreen document once and marks the state listening', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  const reply = await send({ type: 'dictation:start', chunkMs: 4000 });
  assert.equal(reply.ok, true);
  assert.equal(offscreenDocs, 1, 'the offscreen document was created');
  assert.equal(data.runState.dictation.status, 'listening');
  // Calling start again while one is already open must not create a second document.
  await send({ type: 'dictation:start' });
  assert.equal(offscreenDocs, 1, 'a second start does not open a second offscreen document');
  const startMessages = messages.filter(m => m.type === 'offscreen:start');
  assert.equal(startMessages.at(-1).chunkMs, undefined, 'the second call forwarded its own (unset) chunkMs');
});

test('stopping dictation tears the offscreen document down and returns the transcript', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  offscreenStopResult = { text: 'buy oat milk' };
  await send({ type: 'dictation:start' });
  assert.equal(offscreenDocs, 1);
  const reply = await send({ type: 'dictation:stop' });
  assert.equal(reply.ok, true);
  assert.equal(reply.text, 'buy oat milk');
  assert.equal(offscreenDocs, 0, 'the offscreen document is closed once the session ends');
  assert.equal(data.runState.dictation.status, 'idle');
  assert.equal(data.runState.dictation.text, 'buy oat milk');
});

test('only the chosen voice provider key crosses to the offscreen document, never the rest', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  Object.assign(data.settings, { openaiKey: 'voice-key', geminiKey: 'gemini-key', voiceProvider: 'openai' });
  try {
    await send({ type: 'dictation:start' });
    const start = messages.filter(m => m.type === 'offscreen:start').at(-1);
    assert.deepEqual(Object.keys(start.settings).sort(), ['model', 'openaiKey', 'voiceProvider'],
      'the payload carries the chosen provider key, the model that resolves the provider, and nothing else');
    assert.equal(start.settings.openaiKey, 'voice-key');
    assert.equal(start.settings.openrouterKey, undefined, 'the planner key does not travel');
    assert.equal(start.settings.geminiKey, undefined, 'an unused provider key does not travel');
  } finally {
    delete data.settings.openaiKey;
    delete data.settings.geminiKey;
    data.settings.voiceProvider = '';
  }
});

test('a failed settings read cannot skip the teardown: stopping dictation always releases the mic', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  offscreenStopResult = { text: 'buy oat milk' };
  await send({ type: 'dictation:start' });
  assert.equal(offscreenDocs, 1);
  storageFails = true;
  try {
    const reply = await send({ type: 'dictation:stop' });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(offscreenDocs, 0, 'the offscreen document is closed even when settings could not be read');
  } finally {
    storageFails = false;
  }
});

test('a mic permission failure on start opens the one-time full-tab grant page and tears the document down', async () => {
  offscreenDocs = 0;
  tabsCreated.length = 0;
  offscreenStartResult = { error: 'NotAllowedError: Permission dismissed' };
  const reply = await send({ type: 'dictation:start' });
  assert.equal(reply.ok, false);
  assert.equal(reply.needsPermissionTab, true);
  assert.equal(offscreenDocs, 0, 'no offscreen document is left open after a failed start');
  assert.equal(tabsCreated.length, 1);
  assert.equal(tabsCreated[0].url, 'chrome-extension://test-extension/mic-permission.html');
  assert.equal(data.runState.dictation.status, 'error');
  offscreenStartResult = { ok: true };
});

test('an ordinary recording error on start does not open the permission tab', async () => {
  offscreenDocs = 0;
  tabsCreated.length = 0;
  offscreenStartResult = { error: 'recorder failed to initialize' };
  const reply = await send({ type: 'dictation:start' });
  assert.equal(reply.ok, false);
  assert.equal(reply.needsPermissionTab, false);
  assert.equal(tabsCreated.length, 0);
  offscreenStartResult = { ok: true };
});

test('partial and error events from the offscreen document update dictation state without tearing it down', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  await send({ type: 'dictation:start' });
  const offscreenSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') };
  await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:partial', text: 'buy oat' }, offscreenSender, resolve));
  assert.equal(data.runState.dictation.status, 'listening');
  assert.equal(data.runState.dictation.partialText, 'buy oat');
  assert.equal(offscreenDocs, 1, 'a partial event is not a session end');
  await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:error', error: 'OpenRouter transcription failed (500): boom' }, offscreenSender, resolve));
  assert.equal(data.runState.dictation.status, 'error');
  assert.match(data.runState.dictation.error, /transcription failed/);
  await send({ type: 'dictation:stop' });
});

test('a fatal offscreen error (the recorder itself failing) closes the offscreen document; a non-fatal one does not', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  await send({ type: 'dictation:start' });
  const offscreenSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') };
  // A failed chunk transcription (fatal not set) must not tear the session down.
  await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:error', error: 'chunk transcription failed' }, offscreenSender, resolve));
  assert.equal(offscreenDocs, 1, 'a non-fatal error leaves the offscreen document open');
  // The recorder itself dying is fatal: offscreen.js already released the mic, so background closes the document too.
  await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:error', error: 'recording error', fatal: true }, offscreenSender, resolve));
  assert.equal(offscreenDocs, 0, 'a fatal error closes the offscreen document');
  assert.equal(data.runState.dictation.status, 'error');
});

test('clear tears down an in-flight dictation session instead of leaving the mic hot', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  await send({ type: 'dictation:start' });
  assert.equal(offscreenDocs, 1);
  assert.equal(data.runState.dictation.status, 'listening');
  // Before the fix, 'clear' replaced state wholesale without ever closing the offscreen document
  // or telling it to stop capture, so the getUserMedia stream kept recording with no state.dictation
  // left to reach it.
  await send({ type: 'clear' });
  assert.equal(offscreenDocs, 0, 'clear closes the offscreen document rather than abandoning a hot mic');
  assert.equal(data.runState.dictation, undefined, 'no in-flight dictation state survives clear');
});

test('stop tears down an in-flight dictation session the same way clear does', async () => {
  offscreenDocs = 0;
  offscreenStartResult = { ok: true };
  await send({ type: 'dictation:start' });
  assert.equal(offscreenDocs, 1);
  await send({ type: 'stop' });
  assert.equal(offscreenDocs, 0, 'stop closes the offscreen document rather than abandoning a hot mic');
  assert.equal(data.runState.dictation, undefined);
});

// --- voice: the three eagerness modes, wired to real runs -------------------------------------
// A goal typed through voice reaches the exact same 'run' path a manual submit does (see the
// recursive handle({type:'run',...}) call the 'answer' handler above already uses), so it is
// impossible for these tests to pass while skipping the pending-request/already-running guards.
async function withVoiceSettings(patch, fn) {
  const before = { ...data.settings };
  Object.assign(data.settings, patch);
  try { await fn(); } finally { data.settings = before; }
}
test('getState reports which eagerness modes the configured provider supports, and none at all with no key', async () => {
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'eager' }, async () => {
    const reply = await send({ type: 'getState' });
    assert.equal(reply.voice.enabled, true);
    assert.equal(reply.voice.mode, 'eager', 'the configured mode is supported, so it resolves unchanged');
    assert.equal(reply.voice.capability.canTranscribe, true);
  });
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'eager', openrouterKey: '' }, async () => {
    const reply = await send({ type: 'getState' });
    assert.equal(reply.voice.capability.canTranscribe, false, 'no provider key means no transcription at all');
    assert.equal(reply.voice.mode, undefined, 'so no mode is offered, "eager" included — never silently downgraded to another mode');
  });
});
test('voice/dictate: the final transcript never starts a run on its own', async () => {
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'dictate' }, async () => {
    offscreenDocs = 0; offscreenStartResult = { ok: true }; offscreenStopResult = { text: 'summarize this page' };
    const before = taskStarted;
    await send({ type: 'dictation:start' });
    await send({ type: 'dictation:stop' });
    assert.equal(taskStarted, before, 'dictate fills the composer; it never sends for the user');
    assert.equal(data.runState.dictation.status, 'idle');
    assert.equal(data.runState.dictation.text, 'summarize this page');
    assert.equal(data.runState.running, false);
  });
});
test('voice/prewarm: streams partials without running, then runs once speech ends', async () => {
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'prewarm' }, async () => {
    offscreenDocs = 0; offscreenStartResult = { ok: true }; offscreenStopResult = { text: 'summarize this page' };
    const before = taskStarted;
    await send({ type: 'dictation:start' });
    const offscreenSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') };
    await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:partial', text: 'summarize this' }, offscreenSender, resolve));
    assert.equal(taskStarted, before, 'a partial never runs anything under prewarm, no matter how long it gets');
    nextOutcome = { status: 'done', message: 'summarized' };
    await send({ type: 'dictation:stop' });
    await until(() => data.runState.running === false);
    assert.equal(taskStarted, before + 1, 'speech ending is what starts the run');
    assert.equal(lastInput.goal, 'summarize this page');
    assert.equal(data.runState.dictation, undefined, 'the run starting tears the mic session down, same as an explicit stop');
  });
});

// A dictation run is a new turn, not a resume, so it starts in the mode the user has in settings now.
// Preferring `state.mode` meant the leftover mode of the last run won: a user who switched back to fast
// still got a careful run (a planner call, its cost, and an approval card for what fast mode would
// just do), and vice versa.
test('voice/prewarm: a dictation run runs in the settings mode, not the mode the last run left behind', async () => {
  await send({ type: 'clear' });
  const before = taskStarted;
  // A careful run first: it leaves state.mode 'careful', which outlives it.
  nextOutcome = { status: 'done', message: 'finished' };
  await send({ type: 'run', tabId: 12, goal: 'a careful task', mode: 'careful' });
  await until(() => data.runState?.status === 'done');
  assert.equal(data.runState.mode, 'careful');

  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'prewarm', mode: 'fast' }, async () => {
    offscreenDocs = 0; offscreenStartResult = { ok: true }; offscreenStopResult = { text: 'summarize this page' };
    nextOutcome = { status: 'done', message: 'summarized' };
    await send({ type: 'dictation:start' });
    await send({ type: 'dictation:stop' });
    await until(() => taskStarted === before + 2);
    assert.equal(data.runState.mode, 'fast');
    assert.equal(lastInput.supervisor, false, 'settings say fast, so the new run is fast even though the last run was careful');
    await until(() => data.runState?.running === false);
  });
});
test('voice/eager: a partial with enough words starts the run mid-utterance, and only once', async () => {
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'eager' }, async () => {
    offscreenDocs = 0; offscreenStartResult = { ok: true }; offscreenStopResult = { text: 'open the upload tab and click upload' };
    const before = taskStarted;
    await send({ type: 'dictation:start' });
    const offscreenSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') };
    // One word: not enough of a head start yet.
    await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:partial', text: 'open' }, offscreenSender, resolve));
    assert.equal(taskStarted, before);
    nextOutcome = { status: 'done', message: 'opened it' };
    // Three words: eager acts before the sentence is finished.
    await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:partial', text: 'open the upload' }, offscreenSender, resolve));
    await until(() => taskStarted === before + 1);
    assert.equal(lastInput.goal, 'open the upload', 'ran on the partial as it stood at that moment, not a later one');
    await until(() => data.runState.running === false);
    // A later partial for the same (already-triggered, now-torn-down) session must not start a second run.
    await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:partial', text: 'open the upload tab and click' }, offscreenSender, resolve));
    assert.equal(taskStarted, before + 1, 'eager fires once per utterance, not once per chunk');
  });
});
test('voice never starts a run while a request is pending, or while one is already running', async () => {
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'prewarm' }, async () => {
    // Already running: start an ordinary run first, then try to auto-run over it.
    offscreenDocs = 0; offscreenStartResult = { ok: true }; offscreenStopResult = { text: 'do something else' };
    const beforeRun = taskStarted;
    await send({ type: 'run', tabId: 12, goal: 'a long-running task', mode: 'fast' });
    await until(() => taskStarted === beforeRun + 1);
    try {
      const before = taskStarted;
      await send({ type: 'dictation:start' });
      await send({ type: 'dictation:stop' });
      assert.equal(taskStarted, before, 'voice must not be a way to start a second run over one already in flight');
    } finally {
      finishTask?.(); // never leave the fixture's fake task hanging for later tests, even if an assertion above throws
      await until(() => data.runState.running === false);
    }
  });
});
// The session-liveness filtering itself (a result resolving after its session already ended) is
// offscreen.js's job, thoroughly covered by extension-offscreen.test.mjs's "a late-arriving partial
// from a stopped session is ignored" — background.js trusts what offscreen.js sends it. This only
// covers background's own new piece: an eager auto-run is per-session (dictationTriggered resets on
// dictation:start), so a partial arriving with no session behind it at all must not start a run.
test('a dictation:partial with no session behind it (voice disabled, or never started) never starts a run', async () => {
  const before = taskStarted;
  const offscreenSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') };
  const reply = await new Promise(resolve => chrome.runtime.onMessage.fire({ type: 'dictation:partial', text: 'buy oat milk now' }, offscreenSender, resolve));
  assert.equal(reply.ok, true);
  assert.equal(taskStarted, before, 'voice is off by default in this fixture, so this must never start a run');
});

test('voice errors are redacted before replies, broadcasts, and persisted state', async () => {
  await withVoiceSettings({ openaiKey: 'voice-session-secret', voiceProvider: 'openai' }, async () => {
    offscreenDocs = 0;
    offscreenStartResult = { ok: true };
    try {
      offscreenStopResult = { error: 'upstream echoed voice-session-secret' };
      await send({ type: 'dictation:start' });
      const reply = await send({ type: 'dictation:stop' });
      assert.equal(reply.error, 'upstream echoed [redacted]');
      assert.equal(data.runState.dictation.error, 'upstream echoed [redacted]');
      assert.doesNotMatch(JSON.stringify(data.runState), /voice-session-secret/);
      assert.equal(messages.filter(message => message.type === 'state').at(-1).state.dictation.error, 'upstream echoed [redacted]');
    } finally {
      offscreenStopResult = { text: 'hello from the mic' };
    }
  });
});

// --- voice: the global "toggle-dictation" shortcut ----------------------------------------------
test('the global shortcut never opens the mic for a configuration voice cannot actually use', async () => {
  offscreenDocs = 0; offscreenStartResult = { ok: true };
  // voiceEnabled is off in this fixture by default: a press must not open a mic nobody turned on.
  chrome.commands.onCommand.fire('toggle-dictation');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(offscreenDocs, 0, 'voice is off, so the shortcut is a no-op');
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'prewarm', openrouterKey: '' }, async () => {
    // Voice is on, but the configured provider has no key at all: still no mode to use, still no mic.
    chrome.commands.onCommand.fire('toggle-dictation');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(offscreenDocs, 0, 'no provider can transcribe, so there is no mode to fall back to');
  });
});
test('the global shortcut opens the mic once voice is on and a mode is actually usable', async () => {
  await withVoiceSettings({ voiceEnabled: true, voiceMode: 'prewarm' }, async () => {
    offscreenDocs = 0; offscreenStartResult = { ok: true };
    // Empty, not a leftover transcript from an earlier test: this test is only about the toggle
    // mechanics (start, then stop), not "prewarm" auto-running on stop — that has its own coverage
    // above, and a non-empty transcript here would start a real (hanging, in this fixture) run.
    offscreenStopResult = { text: '' };
    chrome.commands.onCommand.fire('toggle-dictation');
    await until(() => offscreenDocs === 1);
    assert.equal(data.runState.dictation.status, 'listening');
    chrome.commands.onCommand.fire('toggle-dictation'); // a second press, past the double-tap window, stops it
    await until(() => offscreenDocs === 0);
  });
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
