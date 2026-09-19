import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RequestType } from './extension/types.js';
import { declineAll, pickBlocking } from './extension/requests.js';

let state, decisions, plans, executed, lastQuestions, planCalls = [], clickDestination = 'file-preview';
const snap = () => ({
  url: `https://example.test/${state}`, title: state, text: state,
  fingerprint: state, scroll: { y: 0, max: 0 },
  elements: [{ id: 1, role: 'link', name: 'README.md', kind: 'click', inViewport: true }],
});
let snapFn = () => snap();
let clickFn = async () => { executed++; state = clickDestination === 'progress' ? `record-${executed}` : clickDestination; };
mock.module('./browser.ts', { namedExports: {
  snapshot: async () => snapFn(), screenshot: async () => '', settle: async () => {},
  describe: e => `[${e.id}] ${e.role} "${e.name}"`,
  click: async (p, id) => clickFn(p, id),
  typeText: async () => {}, selectOption: async () => {}, scroll: async () => {},
}});
mock.module('./jev.ts', { namedExports: {
  decide: async (_state, questions) => { lastQuestions = questions; return { answers: decisions.shift(), ms: 1, cost_usd: 0 }; },
  writeText: async () => '',
}});
mock.module('./planner.ts', { namedExports: {
  plannerModel: () => 'fixture',
  plan: async (ctx) => { planCalls.push(ctx); return { ...plans.shift(), ms: 1, cost_usd: 0 }; },
}});
const { runTask } = await import('./agent.ts');
const choice = (operation, achieved = 0) => ({
  operation: { choice: operation }, goal_achieved: { noul: achieved },
  click_target: { choice: 'el_1' },
});
async function run(supervisor, maxSteps = 3, extra = {}) {
  state = 'repository'; executed = 0; planCalls = [];
  const page = { url: () => snap().url, title: async () => state, waitForTimeout: async () => {}, context: () => ({ pages: () => [page] }) };
  const events = [];
  await runTask(page, { goal: 'open the raw README.md', supervisor, ...(maxSteps === null ? {} : {maxSteps}), ...extra }, e => events.push(e), new AbortController().signal);
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
