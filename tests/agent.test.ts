import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let elements: any[] = [];
let decideImpl: any;
let planImpl: any;
let snapshots = 0;
let clicks = 0;
let selected: number[] = [];
let fingerprint = 'same';
mock.module('../src/browser.ts', { namedExports: {
  snapshot: async () => { snapshots++; return { url: 'https://example.org', title: 'test', text: '', elements, scroll: { y: 0, max: 0 }, fingerprint }; },
  screenshot: async () => '', settle: async () => {}, describe: (e: any) => `[${e.id}] ${e.name}`,
  click: async () => { clicks++; }, selectOption: async (_: any, id: number, idx: number) => { selected = [id, idx]; },
} });
mock.module('../src/jev.ts', { namedExports: { decide: (...args: any[]) => decideImpl(...args), writeText: async () => '' } });
mock.module('../src/planner.ts', { namedExports: { plan: (...args: any[]) => planImpl(...args), plannerModel: () => 'test' } });
const { runTask } = await import('../src/agent.ts');
const page: any = { url: () => 'https://example.org', title: async () => 'test', context: () => ({ pages: () => [page] }) };
const response = (answers: any) => ({ answers, ms: 1, cost_usd: 0.01 });
const choice = (choice: string) => ({ type: 'choice', choice });
async function run(supervisor = false, maxSteps = 1) {
  const events: any[] = [];
  await runTask(page, { goal: 'test', supervisor, maxSteps }, e => events.push(e), new AbortController().signal);
  return events;
}

test('large dropdown pages keep questions bounded and later options reachable', async () => {
  elements = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `select ${i}`, kind: 'select', options: Array.from({ length: 40 }, (_, j) => `option ${j}`) }));
  selected = [];
  decideImpl = async (_: any, questions: any) => {
    for (const q of Object.values(questions) as any[]) if (q.type === 'choice') assert.ok(Object.keys(q.criteria).length <= 255, 'choice exceeds API limit');
    return questions.operation
      ? response({ operation: choice('SELECT'), select_target: choice('el_10'), goal_achieved: { noul: 0 } })
      : response({ select_option: choice('opt_39') });
  };
  const events = await run();
  assert.deepEqual(selected, [10, 39]);
  assert.equal(events.at(-1).totalCostUsd, 0.02);
});

test('planned completion does not add an extra snapshot', async () => {
  elements = [{ id: 1, kind: 'click', name: 'button' }];
  snapshots = 0;
  planImpl = async ({ step }: any) => step === 1
    ? { status: 'continue', next: 'click button', completes_task: true, ms: 0, cost_usd: 0 }
    : { status: 'done', ms: 0, cost_usd: 0 };
  decideImpl = async () => response({ operation: choice('CLICK'), click_target: choice('el_1') });
  const events = await run(true, 2);
  assert.equal(events.at(-1).status, 'done');
  assert.equal(snapshots, 2);
});


test('small dropdowns still select in a single request', async () => {
  elements = [{ id: 1, kind: 'select', name: 'small', options: ['a', 'b'] }];
  let requests = 0;
  decideImpl = async () => { requests++; return response({ operation: choice('SELECT'), select_target: choice('el_1_opt_1') }); };
  await run();
  assert.deepEqual(selected, [1, 1]);
  assert.equal(requests, 1);
});

test('aborting an in-flight model request ends stopped', async () => {
  const controller = new AbortController();
  const events: any[] = [];
  decideImpl = async (_: any, __: any, signal: AbortSignal) => {
    controller.abort();
    signal.throwIfAborted();
  };
  await runTask(page, { goal: 'test', supervisor: false }, e => events.push(e), controller.signal);
  assert.equal(events.at(-1).status, 'stopped');
  assert.equal(events.filter(e => e.type === 'step').length, 0);
});
