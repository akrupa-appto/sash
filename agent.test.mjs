import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let state, decisions, plans, executed, lastQuestions, planCalls = [], clickDestination = 'file-preview';
const snap = () => ({
  url: `https://example.test/${state}`, title: state, text: state,
  fingerprint: state, scroll: { y: 0, max: 0 },
  elements: [{ id: 1, role: 'link', name: 'README.md', kind: 'click', inViewport: true }],
});
let snapFn = () => snap();
let clickFn = async () => { executed++; state = clickDestination === 'progress' ? `record-${executed}` : clickDestination; };
let typeTextFn = async () => {};
mock.module('./browser.ts', { namedExports: {
  snapshot: async () => snapFn(), screenshot: async () => '', settle: async () => {},
  describe: e => `[${e.id}] ${e.role} "${e.name}"`,
  click: async (p, id) => clickFn(p, id),
  typeText: async (...a) => typeTextFn(...a), selectOption: async () => {}, scroll: async () => {},
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

test('a planner question stops the run unexecuted, and the next message continues that run', async () => {
  plans = [
    { status: 'continue', next: 'open README.md' },
    { status: 'question', question: 'which README do you mean, the root one or docs/README.md?', why: 'two files match' },
  ];
  decisions = [choice('CLICK')];
  const asked = await run(true);
  assert.equal(asked.status, 'question');
  assert.equal(asked.question, 'which README do you mean, the root one or docs/README.md?');
  assert.equal(executed, 1, 'the question must not carry out another action');
  assert.equal(planCalls.length, 2);

  plans = [{ status: 'done', answer: 'opened the root readme' }];
  decisions = [];
  const resumed = await run(true, 3, { goal: 'the root one', resume: asked.pending });
  assert.equal(resumed.status, 'done');
  // The resumed run is the same task with everything it had already read, plus the user's answer.
  assert.equal(planCalls[0].task, 'open the raw README.md');
  assert.match(planCalls[0].history[0], /supervisor said "open README.md"/);
  assert.match(planCalls[0].history.at(-1), /which README do you mean.*they replied "the root one"/);
  assert.equal(planCalls[0].step, 3);
});

test('a high-risk action waits for the user before it runs, a low-risk one does not', async () => {
  plans = [{ status: 'continue', next: 'click the "Delete account" button', risk: 'high', why: 'it removes the account for good' }];
  decisions = [choice('CLICK')];
  const paused = await run(true);
  assert.equal(paused.status, 'question');
  assert.equal(executed, 0, 'nothing may be executed before the user answers');
  assert.match(paused.question, /Delete account/);
  assert.equal(paused.pending.action, 'click the "Delete account" button');

  plans = [{ status: 'continue', next: 'click the "Delete account" button', risk: 'high' }, { status: 'done', answer: 'deleted' }];
  decisions = [choice('CLICK')];
  const resumed = await run(true, 3, { goal: 'yes, go ahead', resume: paused.pending });
  assert.equal(resumed.status, 'done');
  assert.equal(executed, 1, 'the answer lets exactly that action through');

  plans = [{ status: 'continue', next: 'open README.md', risk: 'low' }, { status: 'done', answer: 'ok' }];
  decisions = [choice('CLICK')];
  const low = await run(true);
  assert.equal(low.status, 'done');
  assert.equal(executed, 1);
});

// A run that ends blocked or errored explains its reason but never names its outcome in plain terms, so a
// one-word tag goes on the message itself: the panel shows the agent's own text verbatim.
test('a run that finishes surfaces "done" on its own message', async () => {
  plans = [{ status: 'done', answer: 'read the file' }];
  decisions = [choice('DONE')];
  const result = await run(true);
  assert.equal(result.status, 'done');
  assert.match(result.message, /^done: /);
});

test('a run that ends blocked surfaces "could not finish" on its own message', async () => {
  plans = [{ status: 'blocked', why: 'this is a preview, not the raw file' }];
  decisions = [choice('CLICK')];
  const result = await run(true);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /^could not finish: /);
});

test('a run that pauses for the user surfaces "needs you" on its own message', async () => {
  plans = [{ status: 'question', question: 'which README do you mean?', why: 'two files match' }];
  decisions = [];
  const result = await run(true);
  assert.equal(result.status, 'question');
  assert.match(result.message, /^needs you: /);
  // The question itself stays clean for the prompt the panel shows.
  assert.equal(result.question, 'which README do you mean?');
});
