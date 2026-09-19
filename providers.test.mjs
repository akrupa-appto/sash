import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chat, listModels, inferReasoning, geminiThinking, providerKey, providerLabel, _memo } from './providers.ts';

const withKeys = async (keys, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(keys)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const req = { system: 'sys', user: 'usr', effort: 'auto', maxTokens: 500, json: true, prefill: true };
const ok = body => new Response(JSON.stringify(body));

test('OpenAI models use the official endpoint, reasoning_effort, and fall back when reasoning cannot be turned off', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length === 1) return new Response("Unsupported value: 'none' is not supported with this model. reasoning_effort", { status: 400 });
    return ok({ choices: [{ message: { content: '{"status":"done"}' }, finish_reason: 'stop' }] });
  });
  try {
    const reply = await withKeys({ OPENAI_API_KEY: 'oa-key', OPENROUTER_API_KEY: undefined }, () => chat({ ...req, spec: 'openai:gpt-x-unknown' }));
    assert.equal(reply.content, '{"status":"done"}');
    assert.equal(reply.prefilled, false);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization, 'Bearer oa-key');
    assert.equal(calls[0].body.reasoning_effort, 'none', 'unknown model tries none first');
    assert.equal(calls[0].body.max_completion_tokens, 500);
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
    assert.equal(calls[0].body.temperature, undefined);
    assert.equal(calls[0].body.messages.length, 2, 'no assistant prefill for OpenAI');
    assert.equal(calls[1].body.reasoning_effort, undefined, 'second try lets the model use its default effort');
    assert.ok(_memo.noEffortOff.has('gpt-x-unknown'));
    // an explicit level goes through unchanged
    await withKeys({ OPENAI_API_KEY: 'oa-key' }, () => chat({ ...req, spec: 'openai:gpt-x-unknown', effort: 'high' }));
    assert.equal(calls[2].body.reasoning_effort, 'high');
    // documented families go straight to their fastest setting
    await withKeys({ OPENAI_API_KEY: 'oa-key' }, () => chat({ ...req, spec: 'openai:gpt-5-mini' }));
    assert.equal(calls[3].body.reasoning_effort, 'minimal');
    await withKeys({ OPENAI_API_KEY: 'oa-key' }, () => chat({ ...req, spec: 'openai:gpt-5.2' }));
    assert.equal(calls[4].body.reasoning_effort, 'none');
  } finally { fetchMock.mock.restore(); }
});

test('Gemini models use generateContent with an API key header, JSON mime type, and thinking config', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return ok({ candidates: [{ content: { parts: [{ text: '{"status":', thought: false }, { text: 'hidden', thought: true }, { text: '"done"}' }] }, finishReason: 'STOP' }] });
  });
  try {
    const reply = await withKeys({ GEMINI_API_KEY: 'g-key' }, () => chat({ ...req, spec: 'gemini:gemini-3.1-pro-preview', effort: 'max' }));
    assert.equal(reply.content, '{"status":"done"}');
    assert.equal(reply.finish, 'stop');
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent');
    assert.equal(calls[0].headers['x-goog-api-key'], 'g-key');
    assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
    assert.match(calls[0].body.systemInstruction.parts[0].text, /^sys\n/);
    await withKeys({ GEMINI_API_KEY: 'g-key' }, () => chat({ ...req, spec: 'gemini:gemini-2.5-flash' }));
    assert.deepEqual(calls[1].body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, 'auto turns 2.5 Flash thinking off');
    // A model that refuses to turn thinking off keeps a budget large enough for its hidden thinking on later auto calls.
    _memo.noEffortOff.add('gemini-2.5-pro');
    await withKeys({ GEMINI_API_KEY: 'g-key' }, () => chat({ ...req, spec: 'gemini:gemini-2.5-pro', maxTokens: e => ({ none: 1200, low: 4096, medium: 8192 })[e] ?? 16384 }));
    assert.equal(calls[2].body.generationConfig.thinkingConfig, undefined);
    assert.equal(calls[2].body.generationConfig.maxOutputTokens, 8192);
  } finally { fetchMock.mock.restore(); }
});

test('OpenRouter drops the reasoning field for a model that rejects it, and JSON mode always names JSON in the prompt', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
    calls.push(JSON.parse(init.body));
    if (calls.length === 1) return new Response('Unrecognized request argument supplied: reasoning', { status: 400 });
    return ok({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { cost: 0 } });
  });
  try {
    await withKeys({ OPENROUTER_API_KEY: 'or' }, () => chat({ ...req, spec: 'vendor/plain-model', system: 'fill the field' }));
    assert.deepEqual(calls[0].reasoning, { enabled: false });
    assert.equal(calls[1].reasoning, undefined, 'retried without the reasoning field');
    assert.match(calls[1].messages[0].content, /JSON object/, 'json mode named JSON in the system prompt');
    await withKeys({ OPENROUTER_API_KEY: 'or' }, () => chat({ ...req, spec: 'vendor/plain-model', effort: 'high' }));
    assert.deepEqual(calls[2].reasoning, { effort: 'high' }, 'an explicit level is still sent');
  } finally { fetchMock.mock.restore(); }
});

test('Gemini gets a temperature only when one was supplied', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => { calls.push(JSON.parse(init.body)); return ok({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }); });
  try {
    await withKeys({ GEMINI_API_KEY: 'g' }, () => chat({ ...req, spec: 'gemini:gemini-3-flash-preview' }));
    assert.equal(calls[0].generationConfig.temperature, undefined);
    await withKeys({ GEMINI_API_KEY: 'g' }, () => chat({ ...req, spec: 'gemini:gemini-3-flash-preview', temperature: 0 }));
    assert.equal(calls[1].generationConfig.temperature, 0);
  } finally { fetchMock.mock.restore(); }
});

test('a provider without its key fails before any request', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('must not be called'); });
  try {
    await withKeys({ OPENAI_API_KEY: undefined }, () => assert.rejects(chat({ ...req, spec: 'openai:gpt-5.2' }), /OPENAI_API_KEY/));
    await withKeys({ GEMINI_API_KEY: undefined }, () => assert.rejects(chat({ ...req, spec: 'gemini:gemini-2.5-flash' }), /GEMINI_API_KEY/));
  } finally { fetchMock.mock.restore(); }
});

test('model lists carry reasoning metadata: OpenRouter as published, OpenAI and Gemini from documented families', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://openrouter.ai/api/v1/models')) return ok({ data: [{ id: 'x/y', name: 'X Y', reasoning: { mandatory: true, supported_efforts: ['high', 'low'] }, context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002' } }, { id: 'plain/model', name: 'Plain' }] });
    if (String(url).startsWith('https://api.openai.com/v1/models')) return ok({ data: [{ id: 'gpt-5.2' }, { id: 'gpt-4o-realtime-preview' }, { id: 'o3' }, { id: 'text-embedding-3-small' }, { id: 'gpt-5-pro' }, { id: 'gpt-4.1' }] });
    return ok({ models: [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
      { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'TTS', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
    ] });
  });
  try {
    const or = await listModels('openrouter');
    assert.deepEqual(or[0], { id: 'x/y', name: 'X Y', reasoning: { mandatory: true, supported_efforts: ['high', 'low'] }, context: 1000, price: { input: 1, output: 2 } });
    assert.equal(or[1].reasoning, undefined);
    const oa = await withKeys({ OPENAI_API_KEY: 'k' }, () => listModels('openai'));
    assert.deepEqual(oa.map(m => m.id), ['openai:gpt-4.1', 'openai:gpt-5-pro', 'openai:gpt-5.2', 'openai:o3']);
    assert.equal(oa.find(m => m.id === 'openai:gpt-4.1').reasoning, undefined);
    assert.deepEqual(oa.find(m => m.id === 'openai:gpt-5.2').reasoning.supported_efforts, ['xhigh', 'high', 'medium', 'low', 'none']);
    assert.equal(oa.find(m => m.id === 'openai:o3').reasoning.mandatory, true);
    const g = await withKeys({ GEMINI_API_KEY: 'k' }, () => listModels('gemini'));
    assert.deepEqual(g.map(m => m.id), ['gemini:gemini-2.5-flash', 'gemini:gemini-3.1-pro-preview']);
    assert.equal(g[0].context, 1048576);
    assert.equal(g[0].reasoning.mandatory, false);
    assert.deepEqual(g[1].reasoning.supported_efforts, ['high', 'medium', 'low']);
    await withKeys({ OPENAI_API_KEY: undefined }, () => assert.rejects(listModels('openai'), /OPENAI_API_KEY/));
  } finally { fetchMock.mock.restore(); }
});

test('reasoning inference follows the documented families', () => {
  assert.equal(inferReasoning('openai', 'gpt-5-chat-latest'), undefined);
  assert.deepEqual(inferReasoning('openai', 'gpt-5-mini').supported_efforts, ['high', 'medium', 'low', 'minimal']);
  assert.equal(inferReasoning('openai', 'gpt-6-astra').mandatory, true);
  assert.deepEqual(inferReasoning('gemini', 'gemini-3-flash-preview').supported_efforts, ['high', 'medium', 'low', 'minimal']);
  assert.equal(inferReasoning('gemini', 'gemini-2.5-flash-lite').default_enabled, false);
  assert.deepEqual(geminiThinking('gemini-2.5-pro', 'high'), { thinkingBudget: 8192 });
  assert.throws(() => geminiThinking('gemini-3-flash-preview', 'none'), /cannot turn reasoning off/);
  assert.deepEqual(geminiThinking('gemini-3-flash-preview', 'auto'), { thinkingLevel: 'minimal' });
  assert.deepEqual(geminiThinking('gemini-3.1-pro-preview', 'auto'), { thinkingLevel: 'low' });
  _memo.noEffortOff.delete('gemini-2.5-pro'); // an earlier test taught the memo that this model rejects a thinking change
  assert.deepEqual(geminiThinking('gemini-2.5-pro', 'auto'), { thinkingBudget: 1024 });
  assert.deepEqual(geminiThinking('gemini-2.5-flash', 'none'), { thinkingBudget: 0 });
});

test('a custom OpenAI-compatible server gets chat completions at its base URL and lists its own models', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith('/models')) return ok({ data: [{ id: 'llama-4-maverick' }, { id: 'deepseek-r1' }] });
    return ok({ choices: [{ message: { content: '{"status":"done"}' }, finish_reason: 'stop' }] });
  });
  try {
    const keys = { CUSTOM_API_BASE: 'https://api.groq.com/openai/v1/', CUSTOM_API_KEY: 'gsk-test' };
    await withKeys({ ...keys, OPENAI_API_KEY: undefined }, async () => {
      assert.equal(providerKey('custom'), 'gsk-test');
      assert.equal(providerLabel('custom'), 'Custom · api.groq.com');
      const reply = await chat({ ...req, spec: 'custom:llama-4-maverick' });
      assert.equal(reply.content, '{"status":"done"}');
      assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
      assert.equal(calls[0].headers.Authorization, 'Bearer gsk-test');
      assert.equal(calls[0].body.reasoning_effort, undefined, 'auto sends no reasoning field to an unknown server');
      await chat({ ...req, spec: 'custom:deepseek-r1', effort: 'high' });
      assert.equal(calls[1].body.reasoning_effort, 'high');
      const models = await listModels('custom');
      assert.equal(calls[2].url, 'https://api.groq.com/openai/v1/models');
      assert.deepEqual(models.map(m => m.id), ['custom:deepseek-r1', 'custom:llama-4-maverick']);
      assert.deepEqual(models[0].reasoning, { supported_efforts: null, mandatory: false });
    });
    // without a valid base URL the key alone does not connect the provider
    await withKeys({ CUSTOM_API_BASE: 'groq', CUSTOM_API_KEY: 'gsk-test' }, () => { assert.equal(providerKey('custom'), undefined); return assert.rejects(chat({ ...req, spec: 'custom:x' }), /CUSTOM_API_KEY/); });
  } finally { fetchMock.mock.restore(); }
});
