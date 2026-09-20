import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, transcribeCapability, TranscribeUnsupportedError } from '../src/transcribe.ts';

const withKeys = async (keys, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(keys)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const clip = { audio: new Uint8Array([1, 2, 3, 4]), mimeType: 'audio/webm;codecs=opus' };
const ok = (body, init) => new Response(JSON.stringify(body), init);

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
