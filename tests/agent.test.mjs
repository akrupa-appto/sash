import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RequestType } from '../extension/types.js';
import { declineAll, pickBlocking } from '../extension/requests.js';

let state, decisions, plans, executed, lastQuestions, planCalls = [], clickDestination = 'file-preview';
const snap = () => ({
  url: `https://example.test/${state}`, title: state, text: state,
  fingerprint: state, scroll: { y: 0, max: 0 },
  elements: [{ id: 1, role: 'link', name: 'README.md', kind: 'click', inViewport: true }],
});
let snapFn = () => snap();
let clickFn = async () => { executed++; state = clickDestination === 'progress' ? `record-${executed}` : clickDestination; };
let typeTextFn = async () => {};
mock.module('../src/browser.ts', { namedExports: {
  snapshot: async () => snapFn(), screenshot: async () => '', settle: async () => {},
  describe: e => `[${e.id}] ${e.role} "${e.name}"`,
  click: async (p, id) => clickFn(p, id),
  typeText: async (...a) => typeTextFn(...a), selectOption: async () => {}, scroll: async () => {},
}});
mock.module('../src/jev.ts', { namedExports: {
  decide: async (_state, questions) => { lastQuestions = questions; return { answers: decisions.shift(), ms: 1, cost_usd: 0 }; },
  writeText: async () => '',
}});
mock.module('../src/planner.ts', { namedExports: {
  plannerModel: () => 'fixture',
  plan: async (ctx) => { planCalls.push(ctx); return { ...plans.shift(), ms: 1, cost_usd: 0 }; },
}});
const { runTask } = await import('./agent.ts');
const choice = (operation, achieved = 0) => ({
  operation: { choice: operation }, goal_achieved: { noul: achieved },
  click_target: { choice: 'el_1' },
});
// `extra` is either the task as a bare string, or extra RunInput fields (goal, resume, denials, …).
async function run(supervisor, maxSteps = 3, extra = {}) {
  const over = typeof extra === 'string' ? { goal: extra } : extra;
  state = 'repository'; executed = 0; planCalls = [];
  const page = { url: () => snap().url, title: async () => state, waitForTimeout: async () => {}, context: () => ({ pages: () => [page] }) };
  const events = [];
  await runTask(page, { goal: 'open the raw README.md', supervisor, ...(maxSteps === null ? {} : {maxSteps}), ...over }, e => events.push(e), new AbortController().signal);
  return events.at(-1);
}

test('navigation alone does not prove a planned final action completed the task', async () => {
  plans = [
    { status: 'continue', next: 'open raw README.md', completes_task: true, answer: 'opened raw readme' },
    { status: 'blocked', why: 'this is a preview, not the raw file' },
  ];
  decisions = [choice('CLICK')];
  const result = await run(true);
  assert.equal(executed, 1);
  assert.equal(result.status, 'blocked');
});

test('default budget completes a progressing workflow longer than twenty steps', async () => {
  clickDestination = 'progress';
  decisions = [...Array.from({length:24}, () => choice('CLICK')), choice('DONE')];
  try {
    const result = await run(false, null);
    assert.equal(result.status, 'done');
    assert.equal(executed, 24);
  } finally { clickDestination = 'file-preview'; }
});

test('explicit step limits remain bounded and do not execute extra actions', async () => {
  clickDestination = 'progress';
  decisions = Array.from({length:4}, () => choice('CLICK'));
  try {
    const result = await run(false, 2);
    assert.equal(result.status, 'max_steps');
    assert.equal(executed, 2);
  } finally { clickDestination = 'file-preview'; }
});

test('completion uses the operation decision without buying an unused second answer', async () => {
  decisions = [choice('DONE')];
  assert.equal((await run(false)).status, 'done');
  assert.equal(lastQuestions.goal_achieved, undefined);
});

test('fast mode does not replace a requested action with an independent completion score', async () => {
  decisions = [choice('CLICK', 0.95), choice('DONE', 1)];
  const result = await run(false);
  assert.equal(executed, 1);
  assert.equal(result.status, 'done');
});

test('a repeated agent action reports a loop rather than blaming the website', async () => {
  clickDestination = 'repository';
  decisions = Array.from({ length: 4 }, () => choice('CLICK'));
  const result = await run(false, 6);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /repeating "CLICK/);
  assert.doesNotMatch(result.message, /page stopped responding/);
  clickDestination = 'file-preview';
});

test('a repeated action is reported to the planner and jev before the run stops, and the stop names it', async () => {
  clickDestination = 'repository';
  plans = Array.from({ length: 4 }, () => ({ status: 'continue', next: 'open README.md' }));
  decisions = Array.from({ length: 4 }, () => choice('CLICK'));
  const result = await run(true, 10);
  assert.equal(planCalls[0].warnings, undefined);
  assert.equal(planCalls[1].warnings, undefined);
  assert.match(planCalls[2].warnings[0], /CLICK \[1\] link "README.md" \(done 2 times/);
  assert.match(planCalls[3].warnings[0], /done 3 times/);
  assert.equal(executed, 4);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /repeating "CLICK \[1\] link "README.md""/);
  clickDestination = 'file-preview';
});

test('an action the models switch away from after the warning does not end the run', async () => {
  clickDestination = 'repository';
  plans = [
    ...Array.from({ length: 2 }, () => ({ status: 'continue', next: 'open README.md' })),
    { status: 'continue', next: 'scroll down' },
    { status: 'done', answer: 'finished' },
  ];
  decisions = [choice('CLICK'), choice('CLICK'), choice('SCROLL_DOWN')];
  const result = await run(true, 10);
  assert.equal(result.status, 'done');
  clickDestination = 'file-preview';
});

test('after three waits in a row the next step must inspect the page instead of waiting', async () => {
  clickDestination = 'progress';
  plans = [
    ...Array.from({ length: 3 }, () => ({ status: 'continue', next: 'wait for the run to finish' })),
    { status: 'continue', next: 'open the finished run' },
    { status: 'done', answer: 'run result read' },
  ];
  decisions = [choice('WAIT'), choice('WAIT'), choice('WAIT'), choice('CLICK')];
  const result = await run(true, 10);
  assert.ok(!planCalls[2].warnings?.some(w => /waited .* in a row/.test(w)));
  assert.ok(planCalls[3].warnings.some(w => /waited 3 times in a row/.test(w)));
  assert.equal(lastQuestions.operation.criteria.WAIT, undefined, 'jev must not be offered WAIT on the capped step');
  assert.equal(result.status, 'done');
  clickDestination = 'file-preview';
});

test('jev cannot swap the control the planner named for a skip button', async () => {
  const el = snap;
  const twoButtons = () => ({ ...el(), elements: [
    { id: 1, role: 'button', name: 'Continue', kind: 'click', inViewport: true },
    { id: 2, role: 'button', name: 'Skip for now (demo mode)', kind: 'click', inViewport: true },
  ] });
  const [origSnap, origClick] = [snapFn, clickFn];
  let clicked = [];
  snapFn = twoButtons;
  clickFn = async (_p, id) => { clicked.push(id); state = 'ob2'; };
  try {
    plans = [{ status: 'continue', next: 'click the "Continue" button' }, { status: 'done', answer: 'ok' }];
    decisions = [{ operation: { choice: 'CLICK' }, click_target: { choice: 'el_2' } }];
    const result = await run(true, 5);
    assert.deepEqual(clicked, [1]);
    assert.equal(result.status, 'done');
  } finally { snapFn = origSnap; clickFn = origClick; }
});

test('an exact-name match beats a pick that only contains the planner-quoted name', async () => {
  const [origSnap, origClick] = [snapFn, clickFn];
  let clicked = [];
  snapFn = () => ({ ...snap(), elements: [
    { id: 1, role: 'button', name: 'Save as draft', kind: 'click', inViewport: true },
    { id: 2, role: 'button', name: 'Save', kind: 'click', inViewport: true },
  ] });
  clickFn = async (_p, id) => { clicked.push(id); state = 'saved'; };
  try {
    plans = [{ status: 'continue', next: 'click the "Save" button' }, { status: 'done', answer: 'ok' }];
    decisions = [{ operation: { choice: 'CLICK' }, click_target: { choice: 'el_1' } }];
    await run(true, 5);
    assert.deepEqual(clicked, [2]);
  } finally { snapFn = origSnap; clickFn = origClick; }
});

test('a step whose action failed cannot be reported as a success by the next planner call', async () => {
  const [origSnap, origClick, origType] = [snapFn, clickFn, typeTextFn];
  snapFn = () => ({ ...snap(), elements: [
    { id: 1, role: 'textbox', name: 'Condition value', kind: 'type', inViewport: true },
    { id: 2, role: 'button', name: 'Update', kind: 'click', inViewport: true },
  ] });
  typeTextFn = async () => { throw new Error('the control is covered or not visible'); };
  clickFn = async () => { executed++; state = 'filter-saved'; };
  try {
    plans = [
      { status: 'continue', next: 'type the domain into the condition value field' },
      { status: 'continue', next: 'click the "Update" button', completes_task: true },
      { status: 'done', answer: 'the catch-all filter was updated' },
      { status: 'done', answer: 'the catch-all filter was updated' },
    ];
    decisions = [
      { operation: { choice: 'TYPE_TEXT' }, type_target: { choice: 'el_1' } },
      { operation: { choice: 'CLICK' }, click_target: { choice: 'el_2' } },
    ];
    const result = await run(true, 6);
    assert.notEqual(result.status, 'done');
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /control is covered or not visible/);
    // the planner is told to re-check before the run gives up on it
    assert.ok(planCalls[2].warnings.some(w => /did not happen/.test(w)), 'planner must be warned the step failed');
  } finally { snapFn = origSnap; clickFn = origClick; typeTextFn = origType; }
});

test('a retry that succeeds on the same control clears the earlier failure', async () => {
  const [origSnap, origClick, origType] = [snapFn, clickFn, typeTextFn];
  snapFn = () => ({ ...snap(), elements: [
    { id: 1, role: 'textbox', name: 'Condition value', kind: 'type', inViewport: true },
  ] });
  let typed = 0;
  typeTextFn = async () => { if (++typed === 1) throw new Error('the control is covered or not visible'); state = 'typed'; };
  try {
    plans = [
      { status: 'continue', next: 'type the domain into the condition value field' },
      { status: 'continue', next: 'type the domain into the condition value field' },
      { status: 'done', answer: 'the catch-all filter was updated' },
    ];
    decisions = Array.from({ length: 2 }, () => ({ operation: { choice: 'TYPE_TEXT' }, type_target: { choice: 'el_1' } }));
    const result = await run(true, 6);
    assert.equal(result.status, 'done');
  } finally { snapFn = origSnap; clickFn = origClick; typeTextFn = origType; }
});

test('the run reports the item it actually opened, not a same-named one it only considered', async () => {
  const [origSnap, origClick] = [snapFn, clickFn];
  let clicked = [];
  clickFn = async (_p, id) => {
    clicked.push(id);
    state = id === 2 ? 'pr-fix-login-bug' : 'pr-fix-login-bug-retry';
  };
  snapFn = () => ({
    ...snap(),
    elements: [
      { id: 1, role: 'link', name: 'Fix login bug (retry)', kind: 'click', inViewport: true },
      { id: 2, role: 'link', name: 'Fix login bug', kind: 'click', inViewport: true },
    ],
    text:
      state === 'pr-fix-login-bug' ? 'PR #12 Fix login bug: 3/3 checks passing'
      : state === 'pr-fix-login-bug-retry' ? 'PR #14 Fix login bug (retry): 1/3 checks failing'
      : 'repository',
  });
  try {
    // jev picks the wrong PR (el_1, the retry); the exact-name correction should send the click to
    // the PR the supervisor actually named ("Fix login bug", el_2), and everything downstream —
    // the click, and what the run tells the next planner call happened — must be about that PR only.
    plans = [{ status: 'continue', next: 'open the "Fix login bug" pull request' }, { status: 'done', answer: 'ok' }];
    decisions = [{ operation: { choice: 'CLICK' }, click_target: { choice: 'el_1' } }];
    await run(true, 5);
    assert.deepEqual(clicked, [2]);
    assert.match(planCalls[1].history[0], /showing: "PR #12 Fix login bug: 3\/3 checks passing"/);
    assert.doesNotMatch(planCalls[1].history[0], /PR #14/);
  } finally { snapFn = origSnap; clickFn = origClick; }
});

test('the planner sees every step of a long run, older ones shortened', async () => {
  clickDestination = 'progress';
  plans = [...Array.from({ length: 30 }, () => ({ status: 'continue', next: 'x'.repeat(400) })), { status: 'done', answer: 'ok' }];
  decisions = Array.from({ length: 30 }, () => choice('CLICK'));
  try {
    await run(true, 40);
    const last = planCalls.at(-1).history;
    assert.equal(last.length, 30);
    assert.ok(last[0].length < 300 && last[0].endsWith('…'));
    assert.ok(last.at(-1).length > 400);
  } finally { clickDestination = 'file-preview'; }
});

test('a final answer naming a fact the run never observed is not passed through as done', async () => {
  plans = [{ status: 'done', answer: 'Merged pull request #4821 and closed "Fix login redirect".' }];
  const result = await run(true);
  assert.notEqual(result.status, 'done');
  assert.equal(result.answer, undefined);
  assert.match(result.message, /#4821/);
});

test('a final answer whose claims match the run history is passed through as done', async () => {
  plans = [{ status: 'done', answer: 'Opened "README.md" as requested.' }];
  const result = await run(true);
  assert.equal(result.status, 'done');
  assert.equal(result.answer, 'Opened "README.md" as requested.');
});

test('a "test the app" run cannot report done after a single navigation', async () => {
  clickDestination = 'progress';
  plans = [{ status: 'continue', next: 'open the app' }, ...Array.from({ length: 12 }, () => ({ status: 'done', answer: 'tested the app, all good' }))];
  decisions = [choice('CLICK')];
  try {
    const result = await run(true, 12, 'test the app and try out everything');
    assert.equal(executed, 1);
    assert.equal(result.status, 'blocked', 'a one-click run must not be allowed to report done');
    assert.notEqual(result.answer, 'tested the app, all good');
    assert.match(result.message, /not reporting that as tested/);
    assert.ok(planCalls.at(-1).warnings.some(w => /took 1 real action/.test(w)), 'the planner must be told the run is too shallow');
  } finally { clickDestination = 'file-preview'; }
});

test('the coverage floor lifts once the app has really been exercised', async () => {
  clickDestination = 'progress';
  plans = [...Array.from({ length: 5 }, () => ({ status: 'continue', next: 'use the app' })), { status: 'done', answer: 'covered five sections' }];
  decisions = Array.from({ length: 5 }, () => choice('CLICK'));
  try {
    const result = await run(true, 12, 'test the app and try out everything');
    assert.equal(executed, 5);
    assert.equal(result.status, 'done');
    assert.equal(result.answer, 'covered five sections');
  } finally { clickDestination = 'file-preview'; }
});

test('the coverage floor does not delay a one-step task that is not about testing an app', async () => {
  plans = [{ status: 'done', answer: 'opened raw readme' }];
  const result = await run(true, 3);
  assert.equal(result.status, 'done');
  assert.equal(result.answer, 'opened raw readme');
});

test('history records what appeared on the page after an action, not only that it changed', async () => {
  clickDestination = 'progress';
  const orig = snapFn;
  snapFn = () => ({ ...snap(), text: `Jev header ${state === 'repository' ? 'Runs list' : 'Run finished: 7/8 tests passed on "#42 feat: browser settings"'}` });
  plans = [{ status: 'continue', next: 'open the run' }, { status: 'done', answer: 'ok' }];
  decisions = [choice('CLICK')];
  try {
    await run(true, 5);
    assert.match(planCalls[1].history[0], /showing: "Run finished: 7\/8 tests passed on "#42 feat: browser settings""/);
  } finally { snapFn = orig; clickDestination = 'file-preview'; }
});

// ---- blocking states: one request per turn, a named reason, and an end to repeated asking.

test('a page that blocks the run names which of the four reasons it was', async () => {
  plans = [{ status: 'blocked', blocked_reason: 'captcha_failed', why: 'stuck' }];
  decisions = [];
  const result = await run(true);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockedReason, 'captcha_failed');
  assert.match(result.message, /captcha/);
  assert.equal(executed, 0);
});

test('an invented blocked reason is not carried through as one of ours', async () => {
  plans = [{ status: 'blocked', blocked_reason: 'the vibes were off', why: 'this is a preview, not the raw file' }];
  decisions = [];
  const result = await run(true);
  assert.equal(result.blockedReason, undefined);
  assert.equal(result.message, 'this is a preview, not the raw file');
});

test('a credential handoff describes the form and never carries what is already in it', async () => {
  const orig = snapFn;
  snapFn = () => ({ ...snap(), elements: [
    { id: 1, role: 'email', name: 'Email', kind: 'type', value: 'me@pcstyle.dev', inViewport: true },
    { id: 2, role: 'password', name: 'Password', kind: 'type', value: 'hunter2', inViewport: true },
    { id: 3, role: 'button', name: 'Sign in', kind: 'click', inViewport: true },
    { id: 4, role: 'button', name: 'Continue with Google', kind: 'click', inViewport: true },
  ] });
  try {
    plans = [{ status: 'credential', why: 'the site wants a sign-in' }];
    decisions = [];
    const result = await run(true);
    assert.equal(result.status, 'needs_input');
    assert.equal(result.request.type, 'user_input');
    assert.equal(result.request.kind, 'credential');
    assert.equal(result.request.origin, 'https://example.test');
    assert.deepEqual(result.request.fields.map(f => [f.label, f.inputType, f.autocomplete, f.elementId]), [
      ['Email', 'email', 'email', 1],
      ['Password', 'password', 'current-password', 2],
    ]);
    assert.equal(result.request.submit.label, 'Sign in');
    assert.deepEqual(result.request.signInOptions, ['Continue with Google']);
    // The form describes the fields; what the page already holds never travels with it, and the
    // agent types nothing itself.
    assert.ok(result.request.fields.every(f => !('value' in f)));
    assert.doesNotMatch(JSON.stringify(result), /hunter2|me@pcstyle\.dev/);
    assert.equal(executed, 0);
  } finally { snapFn = orig; }
});

// "Continue with Google" reads like a submit button, but clicking it after a password is typed sends
// the user somewhere else entirely. It is an alternative, never this form's submit.
test('a federated sign-in button is offered as an option, never picked as the form submit', async () => {
  const orig = snapFn;
  snapFn = () => ({ ...snap(), elements: [
    { id: 1, role: 'button', name: 'Continue with Google', kind: 'click', inViewport: true },
    { id: 2, role: 'email', name: 'Email', kind: 'type', inViewport: true },
    { id: 3, role: 'password', name: 'Password', kind: 'type', inViewport: true },
    { id: 4, role: 'button', name: 'Log in', kind: 'click', inViewport: true },
  ] });
  try {
    plans = [{ status: 'credential', why: 'the site wants a sign-in' }];
    decisions = [];
    const result = await run(true);
    assert.equal(result.request.submit.label, 'Log in');
    assert.deepEqual(result.request.signInOptions, ['Continue with Google']);
  } finally { snapFn = orig; }
});

test('a mid-run question becomes a picker when the planner listed the choices', async () => {
  plans = [{ status: 'ask', question: 'which inbox should i use?', options: ['work', 'personal'] }];
  decisions = [];
  const picker = await run(true);
  assert.equal(picker.status, 'needs_input');
  assert.equal(picker.request.type, 'option_picker');
  assert.deepEqual(picker.request.options, ['work', 'personal']);
  assert.equal(picker.request.allowFreeText, true);
  plans = [{ status: 'ask', question: 'what should the subject line say?' }];
  const open = await run(true);
  assert.equal(open.request.type, 'user_input');
  assert.equal(open.request.options, undefined);
});

test('an approval offers three scopes, and only whole-internet access is confirmed twice', async () => {
  plans = [{ status: 'approve', action: 'send the message', origin: 'https://example.test' }];
  decisions = [];
  const oneSite = await run(true);
  assert.equal(oneSite.status, 'needs_input');
  assert.equal(oneSite.request.type, 'approval');
  assert.deepEqual(oneSite.request.scopes.map(s => s.id), ['once', 'conversation', 'always']);
  assert.equal(oneSite.request.scopes.at(-1).confirm, undefined);
  plans = [{ status: 'approve', action: 'act on any site i open', origin: '*' }];
  const everywhere = await run(true);
  assert.match(everywhere.request.scopes.at(-1).confirm.warning, /any site/);
});

test('after repeated denials the turn ends saying so instead of asking a fourth time', async () => {
  const request = { status: 'approve', action: 'send the message', origin: 'https://example.test' };
  plans = [request]; decisions = [];
  const stillAsking = await run(true, 3, { denials: { 'approval:send the message': 2 } });
  assert.equal(stillAsking.status, 'needs_input');
  plans = [request];
  const giveUp = await run(true, 3, { denials: { 'approval:send the message': 3 } });
  assert.equal(giveUp.status, 'blocked');
  assert.match(giveUp.message, /after 3 denials/);
  assert.match(giveUp.message, /send the message/);
  assert.equal(giveUp.request, undefined);
});

test('stopping declines every pending request type instead of dropping them', () => {
  const queue = Object.values(RequestType).map((type, i) => ({ id: `r${i}`, type }));
  const declined = declineAll(queue, 'stopped');
  assert.deepEqual(declined.map(d => d.type), Object.values(RequestType));
  assert.ok(declined.every(d => d.outcome === 'declined' && d.reason === 'stopped'));
  // Something already answered is not declined a second time.
  assert.deepEqual(declineAll([{ id: 'x', type: RequestType.PLAN, outcome: 'submitted' }]), []);
});

test('one turn hands back one request: the highest priority, most recent of its kind', () => {
  const queue = [
    { id: 'plan', type: RequestType.PLAN },
    { id: 'elicitation', type: RequestType.ELICITATION },
    { id: 'approval-old', type: RequestType.APPROVAL },
    { id: 'approval-new', type: RequestType.APPROVAL },
    { id: 'setup', type: RequestType.SETUP_STEP },
  ];
  assert.equal(pickBlocking(queue).id, 'setup');
  assert.equal(pickBlocking(queue.filter(r => r.type !== RequestType.SETUP_STEP)).id, 'approval-new');
  assert.equal(pickBlocking(queue.map(r => ({ ...r, outcome: 'declined' }))), undefined);
  assert.equal(pickBlocking([]), undefined);
});

test('an element that vanishes between snapshot and click is retried by name instead of burning the step', async () => {
  const [origSnap, origClick] = [snapFn, clickFn];
  let attempts = [];
  // The page re-renders every snapshot, so the element carries a new id each time.
  let nextId = 1;
  snapFn = () => ({ ...snap(), elements: [{ id: nextId++, role: 'link', name: 'README.md', kind: 'click', inViewport: true }] });
  clickFn = async (_p, id) => {
    attempts.push(id);
    if (attempts.length === 1) throw new Error('locator.evaluate: Timeout 30000ms exceeded.\n  waiting for locator');
    state = 'file-preview';
  };
  try {
    plans = [{ status: 'continue', next: 'open README.md' }, { status: 'done', answer: 'opened' }];
    decisions = [choice('CLICK')];
    const events = [];
    state = 'repository'; planCalls = [];
    const page = { url: () => snap().url, title: async () => state, waitForTimeout: async () => {}, context: () => ({ pages: () => [page] }) };
    await runTask(page, { goal: 'open the raw README.md', supervisor: true, maxSteps: 5 }, e => events.push(e), new AbortController().signal);
    assert.equal(attempts.length, 2, 'the click is retried once against a fresh snapshot');
    assert.notEqual(attempts[1], attempts[0], 'the retry uses the re-tagged element id, not the stale one');
    const step1 = events.find(e => e.type === 'step');
    assert.doesNotMatch(step1.note ?? '', /action failed/);
    assert.match(step1.note, /re-tagged/);
    assert.equal(events.at(-1).status, 'done');
  } finally { snapFn = origSnap; clickFn = origClick; }
});

test('an "ask" pauses the run unexecuted, and the next message continues that run', async () => {
  plans = [
    { status: 'continue', next: 'open README.md' },
    { status: 'ask', question: 'which README do you mean, the root one or docs/README.md?', why: 'two files match' },
  ];
  decisions = [choice('CLICK')];
  const asked = await run(true);
  assert.equal(asked.status, 'needs_input');
  assert.equal(asked.request.type, 'user_input');
  assert.equal(asked.request.question, 'which README do you mean, the root one or docs/README.md?');
  assert.equal(executed, 1, 'the question must not carry out another action');
  assert.equal(planCalls.length, 2);

  plans = [{ status: 'done', answer: 'opened the root readme' }];
  decisions = [];
  const resumed = await run(true, 3, { goal: 'the root one', resume: asked.resumeState });
  assert.equal(resumed.status, 'done');
  // The resumed run is the same task with everything it had already read, plus the user's answer.
  assert.equal(planCalls[0].task, 'open the raw README.md');
  assert.match(planCalls[0].history[0], /supervisor said "open README.md"/);
  assert.match(planCalls[0].history.at(-1), /paused → resumed/);
  assert.equal(planCalls[0].step, 3);
});

// A high-risk action no longer pauses through its own path: the planner asks "approve" instead of
// tagging "continue" with a risk level, so it gets the same three-scope request as any other approval.
test('an "approve" status waits for the user before the action runs', async () => {
  plans = [{ status: 'approve', action: 'click the "Delete account" button', why: 'it removes the account for good' }];
  decisions = [];
  const paused = await run(true);
  assert.equal(paused.status, 'needs_input');
  assert.equal(executed, 0, 'nothing may be executed before the user answers');
  assert.equal(paused.request.type, 'approval');
  assert.match(paused.request.action, /Delete account/);

  plans = [{ status: 'done', answer: 'deleted' }];
  decisions = [];
  const resumed = await run(true, 3, { goal: 'go on', resume: paused.resumeState });
  assert.equal(resumed.status, 'done');
});

test('an unconfirmed failed step still blocks "done" after the run pauses on a request and resumes', async () => {
  const [origSnap, origClick, origType] = [snapFn, clickFn, typeTextFn];
  snapFn = () => ({ ...snap(), elements: [
    { id: 1, role: 'textbox', name: 'Condition value', kind: 'type', inViewport: true },
  ] });
  typeTextFn = async () => { throw new Error('the control is covered or not visible'); };
  try {
    // Step fails, then the very next planner call needs something only the user knows (unrelated question).
    plans = [
      { status: 'continue', next: 'type the domain into the condition value field' },
      { status: 'ask', question: 'which domain do you mean?' },
    ];
    decisions = [{ operation: { choice: 'TYPE_TEXT' }, type_target: { choice: 'el_1' } }];
    const paused = await run(true, 6);
    assert.equal(paused.status, 'needs_input');
    assert.equal(paused.resumeState.pendingFailure?.note, 'action failed: the control is covered or not visible');

    // Resuming answers the question, but the earlier failure was never confirmed, so a later "done" must
    // still be forced through the re-check guard instead of quietly reporting success.
    plans = [
      { status: 'done', answer: 'the catch-all filter was updated' },
      { status: 'done', answer: 'the catch-all filter was updated' },
    ];
    decisions = [];
    const resumed = await run(true, 6, { goal: 'gmail.com', resume: paused.resumeState });
    assert.equal(resumed.status, 'blocked', 'the pending failure must survive the pause, not reset on resume');
  } finally { snapFn = origSnap; clickFn = origClick; typeTextFn = origType; }
});

// A run's terminal message is the supervisor's own words, never a status label bolted onto them: the
// panel already turns `state.status` into its own status word, so a second one on the text is noise.
test('a run that finishes ends with the supervisor\'s own words, not a status label bolted onto them', async () => {
  plans = [{ status: 'done', answer: 'read the file', why: 'found it on the page' }];
  decisions = [];
  const result = await run(true);
  assert.equal(result.status, 'done');
  assert.equal(result.message, 'found it on the page');
});

test('a run that ends blocked reads as the reason itself, not a status label bolted onto it', async () => {
  plans = [{ status: 'blocked', why: 'this is a preview, not the raw file' }];
  decisions = [choice('CLICK')];
  const result = await run(true);
  assert.equal(result.status, 'blocked');
  assert.equal(result.message, 'this is a preview, not the raw file');
});

test('a run waiting on the user reads as the question itself, not a status label bolted onto it', async () => {
  plans = [{ status: 'ask', question: 'which README do you mean?', why: 'two files match' }];
  decisions = [];
  const result = await run(true);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.message, 'which README do you mean?');
});
