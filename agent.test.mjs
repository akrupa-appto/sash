import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let state, decisions, plans, executed, lastQuestions, clickDestination = 'file-preview';
const snap = () => ({
  url: `https://example.test/${state}`, title: state, text: state,
  fingerprint: state, scroll: { y: 0, max: 0 },
  elements: [{ id: 1, role: 'link', name: 'README.md', kind: 'click', inViewport: true }],
});
mock.module('./browser.ts', { namedExports: {
  snapshot: async () => snap(), screenshot: async () => '', settle: async () => {},
  describe: e => `[${e.id}] ${e.role} "${e.name}"`,
  click: async () => { executed++; state = clickDestination === 'progress' ? `record-${executed}` : clickDestination; },
  typeText: async () => {}, selectOption: async () => {}, scroll: async () => {},
}});
mock.module('./jev.ts', { namedExports: {
  decide: async (_state, questions) => { lastQuestions = questions; return { answers: decisions.shift(), ms: 1, cost_usd: 0 }; },
  writeText: async () => '',
}});
mock.module('./planner.ts', { namedExports: {
  plannerModel: () => 'fixture',
  plan: async () => ({ ...plans.shift(), ms: 1, cost_usd: 0 }),
}});
const { runTask } = await import('./agent.ts');
const choice = (operation, achieved = 0) => ({
  operation: { choice: operation }, goal_achieved: { noul: achieved },
  click_target: { choice: 'el_1' },
});
async function run(supervisor, maxSteps = 3) {
  state = 'repository'; executed = 0;
  const page = { url: () => snap().url, title: async () => state, context: () => ({ pages: () => [page] }) };
  const events = [];
  await runTask(page, { goal: 'open the raw README.md', supervisor, ...(maxSteps === null ? {} : {maxSteps}) }, e => events.push(e), new AbortController().signal);
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
  decisions = [choice('CLICK'), choice('CLICK'), choice('CLICK')];
  const result = await run(false);
  assert.equal(result.status, 'blocked');
  assert.match(result.message, /repeating the same action/);
  assert.doesNotMatch(result.message, /page stopped responding/);
  clickDestination = 'file-preview';
});
