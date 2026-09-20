// The approval card offers three scopes (once/conversation/always). Before this file, the scope
// the user picked was recorded and never read anywhere: every scope behaved like "once". These
// tests drive the worker end to end (the same message-passing surface panel.js uses) and check the
// *behaviour* the scopes promise, not just that a grant object gets written somewhere.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { denialKey, DENIAL_LIMIT, grantKey } from '../extension/requests.js';

const events = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f), fire: (...args) => [...listeners].map(f => f(...args)) };
};

// A fresh chrome mock every time it is called, all bound to the same `data` object, so a "restart"
// can swap in brand-new event buses (nothing double-registered on the old ones) while storage --
// where the always-scope grant actually lives -- carries over untouched, the same way a real
// service-worker restart keeps chrome.storage.local but drops everything in memory.
function makeChrome(data) {
  return {
    storage: { local: {
      setAccessLevel: async () => {},
      // Unlike the single-key `{ [key]: ... }` shortcut some other fixtures use, background.js
      // always calls get() with an array of keys, and the restart test below genuinely depends on
      // reading `grants` back out of storage -- so this resolves every requested key for real.
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])),
      set: async values => Object.assign(data, structuredClone(values)),
    } },
    runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
      onMessage: events(), onInstalled: events(), openOptionsPage: async () => {},
      getContexts: async () => [],
      sendMessage: async message => (message.type === 'permission' ? { allow: true } : undefined),
    },
    tabs: {
      get: async id => ({ id, url: 'https://shop.test', title: 'Shop' }),
      create: async opts => ({ id: 999, ...opts }),
      query: async () => [{ id: 12, windowId: 1, url: 'https://shop.test', active: true }],
      // A run that switches tabs mid-flight keeps more than one page attached at once, which walks
      // background.js's mute-the-tabs-not-being-watched path (syncTabMute) -- needed for real once a
      // test drives that path, unlike the single-tab-at-a-time runs elsewhere in this file.
      update: async (id, props) => ({ id, ...props }),
      sendMessage: async () => ({ ok: true }),
      onCreated: events(), onUpdated: events(), onActivated: events(), onRemoved: events(),
    },
    windows: { onFocusChanged: events() },
    permissions: { contains: async () => true, request: async () => { throw new Error('no user gesture'); } },
    debugger: { onDetach: events() },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    commands: { onCommand: events() },
    contextMenus: { create: (opts, cb) => cb?.(), removeAll: cb => cb(), onClicked: events() },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  };
}

const data = { settings: { openrouterKey: 'private-test-key', model: 'fixture/model' } };
globalThis.chrome = makeChrome(data);

let taskStarted = 0;
let nextOutcome; // a single 'end' event for the next runTask call
let nextOutcomes = []; // a queue of 'end' events, for a chain of runTask calls inside one execute()
let capturedPages = []; // tabId the `page` argument carried into each runTask call, in order
let capturedInputs = [];
let switchToTabId; // if set, the next runTask call switches tabs via browserTabs.select first

mock.module('../extension/browser.js', { namedExports: {
  supportedUrl: url => /^https?:/.test(url),
  ChromePage: class {
    constructor(tab, signal) { this.tabId = tab.id; this.signal = signal; }
    async attach() { this.attached = true; }
    async detach() { this.attached = false; }
  },
} });
mock.module('../src/agent.ts', { namedExports: { runTask: async (page, input, emit) => {
  taskStarted++;
  capturedPages.push(page.tabId);
  capturedInputs.push(input);
  if (switchToTabId !== undefined) { const target = switchToTabId; switchToTabId = undefined; await input.browserTabs.select(target); }
  emit({ type: 'step', step: 1, action: 'CLICK [5] button "submit"', plan: 'submit', costUsd: 0 });
  const outcome = nextOutcomes.length ? nextOutcomes.shift() : nextOutcome;
  nextOutcome = undefined;
  emit({ type: 'end', totalCostUsd: 0, ...(outcome || { status: 'done', message: 'finished' }) });
} } });

let background = await import('../extension/background.js');
const send = message => new Promise(resolve => chrome.runtime.onMessage.fire(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('operation did not finish'); };

const approval = (id, overrides = {}) => ({ id, type: 'approval', action: 'submit the $89.00 order', origin: 'https://shop.test', ...overrides });
const paused = request => ({ status: 'needs_input', message: 'approve?', requests: [request], request });
// 'clear' deliberately leaves always-scope grants alone (that is the behaviour under test), so a
// test that stored one has to revoke it itself before the next test, the same way a real settings
// page would; otherwise it silently authorizes an unrelated later test's identical action text.
async function resetGrants() {
  const { grants } = await send({ type: 'grants:list' });
  for (const grant of grants) await send({ type: 'grants:revoke', key: grant.key });
}

test('once: choosing "once" then repeating the same action prompts again', async () => {
  await send({ type: 'clear' });
  nextOutcome = paused(approval('once-1'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');

  nextOutcome = { status: 'done', message: 'done' };
  await send({ type: 'answer', id: 'once-1', outcome: 'submitted', scope: 'once' });
  await until(() => data.runState?.status === 'done');
  assert.deepEqual(data.runState.grants ?? {}, {}, '"once" stores no grant');

  nextOutcome = paused(approval('once-2'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order again', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  assert.deepEqual(data.runState.requests.map(r => r.id), ['once-2'], '"once" does not authorize a repeat');
  await send({ type: 'answer', id: 'once-2', outcome: 'declined' });
});

test('conversation: repeating the same action does not prompt, and clear makes it ask again', async () => {
  await send({ type: 'clear' });
  nextOutcome = paused(approval('conv-1'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');

  nextOutcome = { status: 'done', message: 'done' };
  await send({ type: 'answer', id: 'conv-1', outcome: 'submitted', scope: 'conversation' });
  await until(() => data.runState?.status === 'done');
  assert.equal(Object.keys(data.runState.grants || {}).length, 1, 'the conversation grant is stored on runState');

  // The same action recurs in a later, separate turn of the same chat. The worker must answer it
  // from the stored grant on its own: no card, and two runTask calls happen back to back inside the
  // one 'run' (the auto-skip loop), not one that stops and waits.
  const before = taskStarted;
  nextOutcomes = [paused(approval('conv-2')), { status: 'done', message: 'done again' }];
  await send({ type: 'run', tabId: 12, goal: 'submit the order once more', mode: 'fast' });
  await until(() => data.runState?.status === 'done' && taskStarted === before + 2);
  assert.deepEqual(data.runState.requests, [], 'the stored grant covered the repeat: no card was shown');
  assert.equal(data.runState.messages.at(-1).text, 'done again');
  const auto = capturedInputs.at(-1);
  assert.equal(auto.goal.startsWith('submit the order once more'), true);
  assert.notEqual(auto.goal, 'go on');
  assert.equal(auto.resume?.resolution?.kind, 'approved');
  assert.equal(auto.resume?.resolution?.action, 'submit the $89.00 order');
  assert.equal(auto.resume?.resolution?.scope, 'conversation');

  await send({ type: 'clear' });
  assert.deepEqual(data.runState.grants ?? {}, {}, 'clear wipes conversation-scoped grants');

  nextOutcome = paused(approval('conv-3'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order yet again', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  assert.deepEqual(data.runState.requests.map(r => r.id), ['conv-3'], 'after clear the same action asks again');
  await send({ type: 'answer', id: 'conv-3', outcome: 'declined' });
});

test('always: repeating the same action does not prompt, and it survives a simulated service-worker restart', async () => {
  await send({ type: 'clear' });
  await resetGrants();
  nextOutcome = paused(approval('always-1'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');

  nextOutcome = { status: 'done', message: 'done' };
  await send({ type: 'answer', id: 'always-1', outcome: 'submitted', scope: 'always' });
  await until(() => data.runState?.status === 'done');
  assert.deepEqual(data.runState.grants ?? {}, {}, 'an always-scope grant never lives in runState');
  assert.equal(Object.keys(data.grants || {}).length, 1, 'it is written straight through to chrome.storage.local');

  // A restarted service worker is a fresh module with nothing left in memory but the same storage
  // (the same trick tests/tab-contract.test.mjs uses for tabs.js): swap in brand-new event buses so
  // the restarted module's listeners are not doubled up on the old ones, but keep `data` itself, the
  // way chrome.storage.local survives a real restart.
  globalThis.chrome = makeChrome(data);
  background = await import('../extension/background.js?restart=1');
  const restartedSend = message => new Promise(resolve => chrome.runtime.onMessage.fire(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve));

  const before = taskStarted;
  nextOutcomes = [paused(approval('always-2')), { status: 'done', message: 'done after restart' }];
  await restartedSend({ type: 'run', tabId: 12, goal: 'submit the order after a restart', mode: 'fast' });
  await until(() => data.runState?.status === 'done' && taskStarted === before + 2);
  assert.deepEqual(data.runState.requests, [], 'the always-scope grant survived the restart and covered the repeat');
  assert.equal(data.runState.messages.at(-1).text, 'done after restart');

  // 'clear' on the restarted module must not erase the always-scope grant either.
  await restartedSend({ type: 'clear' });
  assert.equal(Object.keys(data.grants || {}).length, 1, 'clear does not touch always-scope grants');
  // Leave the restarted module in a clean state for later tests in this file, exactly as a settings
  // page revoking the grant through grants:revoke would.
  await restartedSend({ type: 'grants:revoke', key: Object.keys(data.grants)[0] });
});

test('a grant does not authorize a materially different action: different amount, different origin', async () => {
  await send({ type: 'clear' });
  await resetGrants();
  nextOutcome = paused(approval('narrow-1'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  nextOutcome = { status: 'done', message: 'done' };
  await send({ type: 'answer', id: 'narrow-1', outcome: 'submitted', scope: 'always' });
  await until(() => data.runState?.status === 'done');

  // Same origin, a different order total: still a different action, so it must still ask.
  nextOutcome = paused(approval('narrow-2', { action: 'submit the $145.00 order' }));
  await send({ type: 'run', tabId: 12, goal: 'submit a bigger order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  assert.deepEqual(data.runState.requests.map(r => r.id), ['narrow-2'], 'a different order amount is a different action');
  await send({ type: 'answer', id: 'narrow-2', outcome: 'declined' });

  // Identical action wording, a different origin: still a different action.
  nextOutcome = paused(approval('narrow-3', { origin: 'https://other.test' }));
  await send({ type: 'run', tabId: 12, goal: 'submit the order on a different site', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  assert.deepEqual(data.runState.requests.map(r => r.id), ['narrow-3'], 'a different origin is a different action');
  await send({ type: 'answer', id: 'narrow-3', outcome: 'declined' });
  await resetGrants(); // leave a clean slate: this test stored an always-scope grant on 'narrow-1'
});

test('deny still works, and still counts toward the repeated-denial cutoff', async () => {
  await send({ type: 'clear' });
  await resetGrants();
  const request = approval('deny-0');
  for (let i = 0; i < DENIAL_LIMIT; i++) {
    nextOutcome = paused(approval(`deny-${i}`));
    await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
    await until(() => data.runState?.status === 'needs_input');
    await send({ type: 'answer', id: `deny-${i}`, outcome: 'declined' });
  }
  assert.equal(data.runState.denials[denialKey(request)], DENIAL_LIMIT);
  assert.deepEqual(data.runState.grants ?? {}, {}, 'a denied approval never becomes a grant');
});

test('grantKey is scoped by origin and action; denialKey is not (grants must not reuse it)', () => {
  const same = approval('x');
  const otherOrigin = approval('y', { origin: 'https://other.test' });
  assert.notEqual(grantKey(same), grantKey(otherOrigin), 'grantKey distinguishes origins');
  assert.equal(denialKey(same), denialKey(otherOrigin), 'denialKey folds origin into the subject and would over-grant if reused for grants');
});

test('grants:list and grants:revoke expose stored grants for a future settings surface', async () => {
  await send({ type: 'clear' });
  await resetGrants();
  nextOutcome = paused(approval('list-1'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  nextOutcome = { status: 'done', message: 'done' };
  await send({ type: 'answer', id: 'list-1', outcome: 'submitted', scope: 'always' });
  await until(() => data.runState?.status === 'done');

  const { ok, grants } = await send({ type: 'grants:list' });
  assert.equal(ok, true);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].scope, 'always');
  assert.equal(grants[0].origin, 'https://shop.test');

  const revoked = await send({ type: 'grants:revoke', key: grants[0].key });
  assert.equal(revoked.ok, true);
  assert.deepEqual((await send({ type: 'grants:list' })).grants, []);

  // The action asks again now that the grant behind it is gone.
  nextOutcome = paused(approval('list-2'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  assert.deepEqual(data.runState.requests.map(r => r.id), ['list-2']);
  await send({ type: 'answer', id: 'list-2', outcome: 'declined' });
});

test('a tab switch mid-run is carried into a grant-covered auto-resume, not the original tab', async () => {
  await send({ type: 'clear' });
  await resetGrants();
  nextOutcome = paused(approval('switch-setup'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  nextOutcome = { status: 'done', message: 'done' };
  await send({ type: 'answer', id: 'switch-setup', outcome: 'submitted', scope: 'always' });
  await until(() => data.runState?.status === 'done');

  capturedPages.length = 0;
  switchToTabId = 77; // the first runTask call switches tabs before it pauses on the grant-covered ask
  nextOutcomes = [paused(approval('switch-1')), { status: 'done', message: 'done after switch' }];
  await send({ type: 'run', tabId: 12, goal: 'submit the order on the new tab', mode: 'fast' });
  await until(() => data.runState?.status === 'done' && capturedPages.length === 2);
  assert.deepEqual(capturedPages, [12, 77], 'the auto-resumed call used the tab the agent switched to, not the tab the run started on');
  await resetGrants();
});

test('the auto-approve loop is capped instead of spinning forever on a repeating grantable ask', async () => {
  await send({ type: 'clear' });
  await resetGrants();
  nextOutcome = paused(approval('cap-setup'));
  await send({ type: 'run', tabId: 12, goal: 'submit the order', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  nextOutcome = { status: 'done', message: 'done' };
  await send({ type: 'answer', id: 'cap-setup', outcome: 'submitted', scope: 'always' });
  await until(() => data.runState?.status === 'done');

  // Every call keeps returning the identical grantable approval (same action + origin, so every one
  // matches the stored grant): the loop must stop auto-resuming after MAX_AUTO_APPROVALS and show
  // the card, rather than call runTask forever.
  nextOutcomes = Array.from({ length: 25 }, (_v, i) => paused(approval(`cap-${i + 1}`)));
  const before = taskStarted;
  await send({ type: 'run', tabId: 12, goal: 'submit the order repeatedly', mode: 'fast' });
  await until(() => data.runState?.status === 'needs_input');
  assert.equal(taskStarted - before, 21, 'the loop stopped after MAX_AUTO_APPROVALS auto-resumes instead of consuming the whole queue');
  assert.equal(data.runState.requests.length, 1, 'the card is finally shown once the cap is hit');
  await send({ type: 'answer', id: data.runState.requests[0].id, outcome: 'declined' });
  await resetGrants();
});
