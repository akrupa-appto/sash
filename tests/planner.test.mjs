import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan } from '../src/planner.ts';

const ctx = {
  task: 'read the heading', earlierTasks: [], history: [], step: 1, maxSteps: 20,
  page: { url: 'https://example.test', title: 'Example', scroll: 'whole page fits on screen', text: 'Example', elements: [] },
};
const done = model => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ status: 'done', answer: model }) } }],
  usage: { cost: 0 },
}));

test('concurrent planner calls keep their selected model IDs', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const requests = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    await new Promise(resolve => setTimeout(resolve, body.model.startsWith('deepseek') ? 10 : 1));
    return done(body.model);
  });
  try {
    const models = ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k3', 'provider/custom-model:free'];
    const results = await Promise.all(models.map(model => plan(ctx, undefined, model)));
    assert.deepEqual(results.map(p => p.answer), models);
    assert.deepEqual(requests.map(r => r.model), models);
    assert.ok(requests.every(r => r.messages.at(-1).role === 'user'));
    assert.deepEqual(requests[1].reasoning, { effort: 'low' });
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test('mandatory reasoning retry changes settings without changing the custom model', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const requests = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return requests.length === 1 ? new Response('Reasoning is mandatory for this endpoint and cannot be disabled.', { status: 400 }) : done(body.model);
  });
  try {
    const model = 'provider/reasoning-required';
    assert.equal((await plan(ctx, undefined, model)).answer, model);
    assert.deepEqual(requests.map(r => r.model), [model, model]);
    assert.deepEqual(requests[1].reasoning, { effort: 'low' });
    assert.ok(requests[1].max_tokens > 600);
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test('prefill retry preserves an explicitly selected custom model', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const requests = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return requests.length === 1 ? new Response('prefill is unsupported', { status: 400 }) : done(body.model);
  });
  try {
    const model = 'anthropic/custom-test-model';
    assert.equal((await plan(ctx, undefined, model)).answer, model);
    assert.deepEqual(requests.map(r => r.model), [model, model]);
    assert.equal(requests[0].messages.at(-1).role, 'assistant');
    assert.equal(requests[1].messages.at(-1).role, 'user');
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

 test('reasoning stays request-scoped and survives prefill retry', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const requests = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (body.messages.at(-1).role === 'assistant') return new Response('prefill unsupported', {status:400});
    return done(body.model);
  });
  try {
    await Promise.all(['low','high','max'].map(level => plan(ctx, undefined, 'provider/same-model', level)));
    assert.deepEqual(requests.map(r => r.reasoning.effort), ['low','high','max']);
    assert.ok(requests[2].max_tokens > requests[1].max_tokens);
    await plan(ctx, undefined, 'anthropic/effort-retry', 'high');
    assert.deepEqual(requests.slice(-2).map(r => r.reasoning), [{effort:'high'},{effort:'high'}]);
    await assert.rejects(plan(ctx, undefined, 'z-ai/glm-5.3-flash','none'), /requires reasoning/);
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
test('system prompt allows a multi-line answer for compare/summarize tasks', () => {
  const source = readFileSync(new URL('../src/planner.ts', import.meta.url), 'utf8');
  assert.match(source, /one short line per item, newline-separated/);
  assert.match(source, /one sentence for a plain confirmation/);
});

test('planner accepts a multi-line answer from a comparison-shaped reply', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const multiLine = 'Tab 1: price $10\nTab 2: price $12\nTab 3: price $9';
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ status: 'done', answer: multiLine }) } }],
    usage: { cost: 0 },
  })));
  try {
    const result = await plan(ctx, undefined, 'provider/compare-model');
    assert.equal(result.answer, multiLine);
    assert.equal(result.answer.split('\n').length, 3);
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

 test('explicit off is not silently changed on a mandatory reasoning error', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('reasoning is mandatory', {status:400}));
  try {
    await assert.rejects(plan(ctx, undefined, 'provider/explicit-off', 'none'), /mandatory/);
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});
