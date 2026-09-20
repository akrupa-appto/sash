import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../extension/settings.js';
import { approvalRequest } from '../extension/requests.js';
import { approvalInstruction, plan } from '../src/planner.ts';

const ctx = {
  task: 'read the heading', earlierTasks: [], history: [], step: 1, maxSteps: 20,
  page: { url: 'https://example.test', title: 'Example', scroll: 'whole page fits on screen', text: 'Example', elements: [] },
};

test('approval and site-access settings default, validate, and survive a round trip', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.approvalMode, 'every', 'the owner asked to be asked before every action');
  assert.equal(defaults.siteAccessMode, 'ask');
  assert.equal(defaults.transcriptionModel, '');

  assert.equal(normalizeSettings({ approvalMode: 'risky' }).approvalMode, 'risky');
  assert.equal(normalizeSettings({ approvalMode: 'none' }).approvalMode, 'none');
  assert.equal(normalizeSettings({ approvalMode: 'sometimes' }).approvalMode, 'every', 'an unknown mode falls back to asking');
  assert.equal(normalizeSettings({ approvalMode: undefined }).approvalMode, 'every');

  assert.equal(normalizeSettings({ siteAccessMode: 'all' }).siteAccessMode, 'all');
  assert.equal(normalizeSettings({ siteAccessMode: 'whatever' }).siteAccessMode, 'ask');

  assert.equal(normalizeSettings({ transcriptionModel: '  openai:gpt-transcribe ' }).transcriptionModel, 'openai:gpt-transcribe');
  assert.equal(normalizeSettings({ transcriptionModel: 42 }).transcriptionModel, '', 'a non-string is not a model spec');
});

test('the widest approval scope allows and saves, and warns before it does', () => {
  const everySite = approvalRequest({ action: 'send the message', origin: '*' });
  const always = everySite.scopes.find(s => s.id === 'always');
  assert.equal(always.label, 'allow & save');
  assert.match(always.confirm.warning, /without asking again/);

  // A single-origin approval is not the dangerous one, so it saves without a second confirm.
  const oneSite = approvalRequest({ action: 'send the message', origin: 'https://example.test' });
  assert.equal(oneSite.scopes.find(s => s.id === 'always').label, 'allow & save');
  assert.equal(oneSite.scopes.find(s => s.id === 'always').confirm, undefined);
  assert.deepEqual(oneSite.scopes.map(s => s.label), ['allow once', 'allow for this conversation', 'allow & save']);
});

test('each approval mode reaches the planner as an instruction, and the default stays silent', () => {
  assert.match(approvalInstruction('every'), /ask before every action/);
  assert.match(approvalInstruction('every'), /before every action that changes the page or sends anything/);
  // Without this sentence the resumed run asks the same approval again and the action the user just
  // allowed never runs — the card answers a question the planner then repeats. Lab-verified against
  // the real planner: with an approved line in the history it continues, without one it still asks.
  assert.match(approvalInstruction('every'), /paused → approved <action> \(<scope>\)/, 'the instruction says what an answered approval means');
  assert.match(approvalInstruction('every'), /Any other action still needs its own approval/, 'and that every other action is still asked about');
  assert.match(approvalInstruction('none'), /never ask/);
  assert.equal(approvalInstruction('risky'), '', 'the middle setting is the prompt that shipped');
  assert.equal(approvalInstruction(undefined), '', 'a server with no extension settings keeps its own behaviour');
});

test('plan() sends the approval instruction to the model it actually calls', async () => {
  const oldMode = process.env.APPROVAL_MODE;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const bodies = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'done', answer: 'ok' }) } }], usage: { cost: 0 } }));
  });
  try {
    process.env.APPROVAL_MODE = 'every';
    await plan(ctx, undefined, 'provider/custom-model');
    process.env.APPROVAL_MODE = 'none';
    await plan(ctx, undefined, 'provider/custom-model');
    delete process.env.APPROVAL_MODE;
    await plan(ctx, undefined, 'provider/custom-model');

    const systems = bodies.map(b => b.messages.find(m => m.role === 'system').content);
    assert.match(systems[0], /ask before every action/);
    assert.match(systems[1], /never ask/);
    assert.doesNotMatch(systems[2], /ask before every action|never ask/);
  } finally {
    fetchMock.mock.restore();
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldMode === undefined) delete process.env.APPROVAL_MODE; else process.env.APPROVAL_MODE = oldMode;
  }
});

// The setting says nothing waits for the user, and the planner's own question ("which folder?") is
// exactly such a wait. The instruction already forbids it; this is the floor under the instruction.
test('"never ask" refuses the planner\'s own question instead of pausing the run', async () => {
  const oldMode = process.env.APPROVAL_MODE;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const answer = content => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0 } }));
  const mocks = [];
  const stubFetch = fn => { const m = mock.method(globalThis, 'fetch', fn); mocks.push(m); return m; };
  try {
    process.env.APPROVAL_MODE = 'none';
    let calls = 0;
    stubFetch(async () => { calls++; return answer({ status: 'ask', question: 'which folder?' }); });
    await assert.rejects(() => plan(ctx, undefined, 'provider/custom-model'), /questions are turned off in settings/, 'the message names the setting, not a broken planner model');
    assert.equal(calls, 2, 'it retries once, then reports instead of waiting for an answer');
    mocks.pop()?.mock.restore();

    process.env.APPROVAL_MODE = 'risky';
    stubFetch(async () => answer({ status: 'ask', question: 'which folder?' }));
    assert.equal((await plan(ctx, undefined, 'provider/custom-model')).status, 'ask', 'the other modes still get to ask');
  } finally {
    for (const m of mocks) { try { m.mock.restore(); } catch { /* already restored */ } }
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldMode === undefined) delete process.env.APPROVAL_MODE; else process.env.APPROVAL_MODE = oldMode;
  }
});
