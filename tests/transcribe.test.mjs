import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultTranscriptionSpec, transcribe, transcribeCapability, TranscribeUnsupportedError } from '../src/transcribe.ts';

// Always starts from every provider key cleared, then applies the overrides given, so a test that
// only names the keys it cares about is not at the mercy of whatever else happens to be in the
// ambient environment (e.g. a real .env) — configuredProviders() only ever sees what was asked for.
const PROVIDER_ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'CUSTOM_API_KEY', 'CUSTOM_API_BASE'];
const withKeys = async (keys, fn) => {
  const merged = { ...Object.fromEntries(PROVIDER_ENV_KEYS.map(k => [k, undefined])), ...keys };
  const saved = {};
  for (const [k, v] of Object.entries(merged)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const clip = { audio: new Uint8Array([1, 2, 3, 4]), mimeType: 'audio/webm;codecs=opus' };
const ok = (body, init) => new Response(JSON.stringify(body), init);

test('provider-only voice choices resolve to stock transcription model specs', () => {
  assert.equal(defaultTranscriptionSpec('openrouter'), 'openai/whisper-1');
  assert.equal(defaultTranscriptionSpec('openai'), 'openai:whisper-1');
  assert.equal(defaultTranscriptionSpec('gemini'), 'gemini:gemini-2.5-flash');
  assert.equal(defaultTranscriptionSpec('custom'), 'custom:whisper-1');
});

test('OpenRouter transcribes with the default whisper model, multipart, at its own endpoint', async () => {
  let call;
  const fetchMock = { restore: () => {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { call = { url, init }; return ok({ text: 'buy oat milk' }); };
  try {
    const result = await withKeys({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined }, () => transcribe(clip));
    assert.equal(result.text, 'buy oat milk');
    assert.equal(call.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
    assert.equal(call.init.headers.Authorization, 'Bearer or-key');
    assert.ok(call.init.body instanceof FormData);
    assert.equal(call.init.body.get('model'), 'openai/whisper-1');
    const file = call.init.body.get('file');
    assert.equal(file.type, 'audio/webm;codecs=opus');
  } finally { globalThis.fetch = realFetch; fetchMock.restore(); }
});

test('an explicit spec picks the provider and model, same prefix convention as chat', async () => {
  const realFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, init) => { call = { url, init }; return ok({ text: 'hello' }); };
  try {
    await withKeys({ OPENAI_API_KEY: 'oa-key' }, () => transcribe({ ...clip, spec: 'openai:gpt-4o-mini-transcribe' }));
    assert.equal(call.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(call.init.headers.Authorization, 'Bearer oa-key');
    assert.equal(call.init.body.get('model'), 'gpt-4o-mini-transcribe');
  } finally { globalThis.fetch = realFetch; }
});

test('Gemini sends the audio inline as base64 in a generateContent call', async () => {
  const realFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, init) => { call = { url, init: { ...init, body: JSON.parse(init.body) } }; return ok({ candidates: [{ content: { parts: [{ text: 'buy oat milk' }] } }] }); };
  try {
    const result = await withKeys({ GEMINI_API_KEY: 'g-key' }, () => transcribe({ ...clip, spec: 'gemini:gemini-2.5-flash' }));
    assert.equal(result.text, 'buy oat milk');
    assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(call.init.headers['x-goog-api-key'], 'g-key');
    const part = call.init.body.contents[0].parts.find(p => p.inlineData);
    assert.equal(part.inlineData.mimeType, 'audio/webm');
    assert.equal(Buffer.from(part.inlineData.data, 'base64').join(','), '1,2,3,4');
  } finally { globalThis.fetch = realFetch; }
});

test('a custom server without the transcription endpoint produces a clear, actionable error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  try {
    await withKeys({ CUSTOM_API_BASE: 'https://api.groq.com/openai/v1', CUSTOM_API_KEY: 'gsk-test' }, async () => {
      await assert.rejects(
        transcribe(clip),
        err => {
          assert.ok(err instanceof TranscribeUnsupportedError, 'a missing endpoint is a distinct, recognizable error, not a raw HTTP failure');
          assert.match(err.message, /doesn't support audio transcription/);
          assert.match(err.message, /\/v1\/audio\/transcriptions/);
          assert.equal(err.provider, 'custom');
          return true;
        },
      );
    });
  } finally { globalThis.fetch = realFetch; }
});

test('a custom server that does implement the endpoint transcribes normally', async () => {
  const realFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, init) => { call = { url, init }; return ok({ text: 'it works' }); };
  try {
    const result = await withKeys({ CUSTOM_API_BASE: 'https://api.groq.com/openai/v1', CUSTOM_API_KEY: 'gsk-test' }, () => transcribe(clip));
    assert.equal(result.text, 'it works');
    assert.equal(call.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(call.init.body.get('model'), 'whisper-1');
  } finally { globalThis.fetch = realFetch; }
});

test('no key configured for the chosen provider fails before any request, same shape as chat', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return ok({}); };
  try {
    await withKeys({ OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, CUSTOM_API_KEY: undefined, CUSTOM_API_BASE: undefined }, () =>
      assert.rejects(transcribe(clip), /no transcription provider configured/));
    await withKeys({ OPENAI_API_KEY: undefined }, () => assert.rejects(transcribe({ ...clip, spec: 'openai:whisper-1' }), /OpenAI needs an API key/));
    assert.equal(called, false);
  } finally { globalThis.fetch = realFetch; }
});

test('dictation with no explicit spec routes to the provider backing the configured planner model (PLANNER_MODEL), not the first key in priority order', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(url); return ok({ text: 'ok' }); };
  try {
    // Both an OpenAI key AND an OpenRouter key are present — Jev commonly runs through OpenRouter
    // even when the planner model itself is on OpenAI or Gemini. configuredProviders()'s fixed
    // priority order (openrouter, openai, gemini, custom) would pick OpenRouter here and silently
    // send the mic audio to the wrong vendor. The planner model must win instead.
    await withKeys({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key', PLANNER_MODEL: 'openai:gpt-4o' }, () => transcribe(clip));
    assert.equal(calls[0], 'https://api.openai.com/v1/audio/transcriptions', 'audio went to the configured planner provider (OpenAI), not OpenRouter');

    calls.length = 0;
    await withKeys({ OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'g-key', PLANNER_MODEL: 'gemini:gemini-2.5-flash' }, () => transcribe(clip));
    assert.equal(calls[0], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', 'audio went to the configured planner provider (Gemini), not OpenRouter');
  } finally { globalThis.fetch = realFetch; delete process.env.PLANNER_MODEL; }
});

test('dictation still resolves the planner provider (not the priority order) even when that provider cannot transcribe: it fails clearly rather than silently falling back to a different vendor', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return ok({}); };
  try {
    // Planner is on OpenAI, but only an OpenRouter key is configured (e.g. for Jev). The old
    // configuredProviders()[0] fallback would silently use OpenRouter's key here; the fix must
    // instead name the actual problem — OpenAI needs a key — never fall back to OpenRouter.
    await withKeys({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: undefined, PLANNER_MODEL: 'openai:gpt-4o' }, () =>
      assert.rejects(transcribe(clip), /OpenAI needs an API key/));
    assert.equal(called, false, 'no request is sent to any provider, including the one with a key, once the planner provider is unusable');
  } finally { globalThis.fetch = realFetch; delete process.env.PLANNER_MODEL; }
});

test('transcribeCapability with no explicit spec also reports the planner provider, not the first configured key', async () => {
  await withKeys({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key', PLANNER_MODEL: 'openai:gpt-4o' }, () => {
    const capability = transcribeCapability();
    assert.equal(capability.provider, 'openai');
    assert.equal(capability.canTranscribe, true);
  });
  delete process.env.PLANNER_MODEL;
});

test('capability probe is cheap and synchronous: reports whether the configured provider can transcribe, and never claims live streaming yet', async () => {
  await withKeys({ OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, CUSTOM_API_KEY: undefined, CUSTOM_API_BASE: undefined }, () => {
    const capability = transcribeCapability();
    assert.equal(capability.canTranscribe, false);
    assert.equal(capability.streaming, false);
    assert.match(capability.reason, /no provider configured/);
  });
  await withKeys({ OPENROUTER_API_KEY: 'or-key' }, () => {
    const capability = transcribeCapability();
    assert.equal(capability.provider, 'openrouter');
    assert.equal(capability.canTranscribe, true);
    assert.equal(capability.streaming, false, 'true mid-sentence partials are out of scope for this build');
  });
  await withKeys({ OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: 'oa-key' }, () => {
    const capability = transcribeCapability('openai:gpt-4o-mini-transcribe');
    assert.equal(capability.provider, 'openai');
    assert.equal(capability.canTranscribe, true);
  });
  await withKeys({ CUSTOM_API_BASE: 'https://api.groq.com/openai/v1', CUSTOM_API_KEY: 'gsk-test', OPENROUTER_API_KEY: undefined }, () => {
    const capability = transcribeCapability();
    assert.equal(capability.provider, 'custom');
    assert.equal(capability.canTranscribe, true, 'a custom server is assumed capable until it is tried');
    assert.match(capability.reason, /not guaranteed/);
  });
});
