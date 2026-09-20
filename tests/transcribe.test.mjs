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
  assert.equal(defaultTranscriptionSpec('openrouter'), 'openai/gpt-transcribe');
  assert.equal(defaultTranscriptionSpec('openai'), 'openai:gpt-transcribe');
  assert.equal(defaultTranscriptionSpec('gemini'), 'gemini:gemini-3.5-transcribe');
  assert.equal(defaultTranscriptionSpec('custom'), 'custom:whisper-1');
});

test('OpenRouter transcribes with the default speech-to-text model, multipart, at its own endpoint', async () => {
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
    assert.equal(call.init.body.get('model'), 'openai/gpt-transcribe');
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

// Google's recommended path for speech is the Interactions API: upload the bytes with the Files API,
// then name the uploaded file's uri. The generatedContent transcription page is the legacy one.
const uploadOk = (uri = 'https://generativelanguage.googleapis.com/v1beta/files/abc', name = 'files/abc') =>
  new Response(JSON.stringify({ file: { name, uri } }), { status: 200 });

test('Gemini uploads the audio through the Files API, then transcribes it with the Interactions API', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example.test/session' } });
    if (String(url) === 'https://upload.example.test/session') return uploadOk();
    return ok({ output_text: 'buy oat milk' });
  };
  try {
    const result = await withKeys({ GEMINI_API_KEY: 'g-key' }, () => transcribe({ ...clip, spec: 'gemini:gemini-2.5-flash' }));
    assert.equal(result.text, 'buy oat milk');

    // 1. the upload is declared first: resumable, with the audio's real length and type
    const start = calls[0];
    assert.equal(start.url, 'https://generativelanguage.googleapis.com/upload/v1beta/files', 'the documented upload URI: /upload goes before the version, not after the api host');
    assert.equal(start.init.headers['x-goog-api-key'], 'g-key');
    assert.equal(start.init.headers['X-Goog-Upload-Protocol'], 'resumable');
    assert.equal(start.init.headers['X-Goog-Upload-Command'], 'start');
    assert.equal(start.init.headers['X-Goog-Upload-Header-Content-Length'], '4');
    assert.equal(start.init.headers['X-Goog-Upload-Header-Content-Type'], 'audio/webm');

    // 2. the bytes go to the session URL the first call handed back, and finalize the upload
    assert.equal(calls[1].url, 'https://upload.example.test/session');
    assert.equal(calls[1].init.headers['X-Goog-Upload-Command'], 'upload, finalize');
    assert.deepEqual([...calls[1].init.body], [1, 2, 3, 4]);

    // 3. the interaction names the uploaded file, and a plain multimodal model still needs the
    // instruction in words — it is not a speech model and knows nothing about being one
    const interaction = calls.find(c => c.url.endsWith('/interactions'));
    const body = JSON.parse(interaction.init.body);
    assert.equal(body.model, 'gemini-2.5-flash');
    assert.deepEqual(body.input.map(p => p.type), ['text', 'audio']);
    assert.equal(body.input[1].uri, 'https://generativelanguage.googleapis.com/v1beta/files/abc');
    assert.equal(body.input[1].mime_type, 'audio/webm');
    assert.equal(body.generation_config, undefined);

    // 4. the uploaded recording does not stay in Google's file store for its full 48 hours
    const cleanup = calls.find(c => c.init.method === 'DELETE');
    assert.equal(cleanup.url, 'https://generativelanguage.googleapis.com/v1beta/files/abc');
  } finally { globalThis.fetch = realFetch; }
});

// gemini-3.5-transcribe is a dedicated speech model: the interaction carries the audio and its
// transcription config and nothing else, and the transcript is read from every shape Google
// documents for the answer.
test('the Gemini speech model asks for a transcription config, and its answer is read from every documented shape', async () => {
  const realFetch = globalThis.fetch;
  let body, reply;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example.test/session' } });
    if (String(url) === 'https://upload.example.test/session') return uploadOk();
    if (init.method === 'DELETE') return new Response('{}', { status: 200 });
    body = JSON.parse(init.body);
    return ok(reply);
  };
  try {
    const run = () => withKeys({ GEMINI_API_KEY: 'g-key' }, () => transcribe({ ...clip, spec: 'gemini:gemini-3.5-transcribe' }));

    reply = { output_text: 'buy oat milk' };
    assert.equal((await run()).text, 'buy oat milk', 'output_text is the documented answer');
    assert.deepEqual(body.generation_config, { transcription_config: {} });
    assert.deepEqual(body.input.map(p => p.type), ['audio'], 'the audio is the whole request; a speech model needs no instruction');
    assert.equal(body.input[0].mime_type, 'audio/webm');

    // The REST envelope the Files API guide shows on its own page.
    reply = { outputs: [{ type: 'text', text: 'buy oat milk' }] };
    assert.equal((await run()).text, 'buy oat milk');
    // And the word-annotation shape: no plain text part at all, one entry per recognized word.
    reply = { steps: [{ type: 'model_output', content: [{ type: 'text', text: '', annotations: [{ type: 'word_info', text: 'buy' }, { type: 'word_info', text: 'oat' }, { type: 'word_info', text: 'milk' }] }] }] };
    assert.equal((await run()).text, 'buy oat milk');
  } finally { globalThis.fetch = realFetch; }
});

// The upload session exists from the moment the start call answers. If the bytes never land, the
// session has to be cancelled: otherwise the user's microphone audio stays in Google's file store
// with nothing left to delete it.
test('an upload that fails after the session opened is cancelled, not orphaned', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example.test/session' } });
    if (init.headers?.['X-Goog-Upload-Command'] === 'cancel') return new Response('{}', { status: 200 });
    return new Response('nope', { status: 500 });
  };
  try {
    await withKeys({ GEMINI_API_KEY: 'g-key' }, () =>
      assert.rejects(transcribe({ ...clip, spec: 'gemini:gemini-3.5-transcribe' }), /Gemini transcription failed \(500\)/));
    const cancel = calls.find(c => c.init.headers?.['X-Goog-Upload-Command'] === 'cancel');
    assert.ok(cancel, 'the open session is cancelled');
    assert.equal(cancel.url, 'https://upload.example.test/session');
  } finally { globalThis.fetch = realFetch; }
});

// The bytes have landed by the time the finalize reply comes back, so a reply that cannot be read (a
// truncated body, an HTML error page) leaves a real file behind: cancel is the only thing that
// removes it, and the failure must not be silently swallowed into an empty transcript.
test('a finalize reply that cannot be read cancels the session instead of leaving the clip behind', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example.test/session' } });
    if (init.headers?.['X-Goog-Upload-Command'] === 'cancel') return new Response('{}', { status: 200 });
    if (String(url) === 'https://upload.example.test/session') return new Response('<html>gateway timed out</html>', { status: 200 });
    return ok({ output_text: 'x' });
  };
  try {
    await withKeys({ GEMINI_API_KEY: 'g-key' }, () =>
      assert.rejects(transcribe({ ...clip, spec: 'gemini:gemini-3.5-transcribe' })));
    const cancel = calls.find(c => c.init.headers?.['X-Goog-Upload-Command'] === 'cancel');
    assert.equal(cancel?.url, 'https://upload.example.test/session', 'an unreadable reply after the bytes landed still cancels the session');
  } finally { globalThis.fetch = realFetch; }
});

// The reply can name the file without naming its uri. That name is enough to delete it.
test('a reply naming a file but no uri deletes that file before reporting the failure', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example.test/session' } });
    if (String(url) === 'https://upload.example.test/session') return new Response(JSON.stringify({ file: { name: 'files/abc' } }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  try {
    await withKeys({ GEMINI_API_KEY: 'g-key' }, () =>
      assert.rejects(transcribe({ ...clip, spec: 'gemini:gemini-3.5-transcribe' }), /returned no file uri/));
    const cleanup = calls.find(c => c.init.method === 'DELETE');
    assert.equal(cleanup?.url, 'https://generativelanguage.googleapis.com/v1beta/files/abc', 'the audio it just uploaded is deleted, not left for 48 hours');
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
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    // Gemini's path is an upload followed by an interaction; answer both so the routing assertion
    // below is about which provider was chosen, not about the shape of its handshake.
    if (String(url).endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example.test/session' } });
    if (String(url) === 'https://upload.example.test/session') return uploadOk();
    return ok({ text: 'ok' });
  };
  try {
    // Both an OpenAI key AND an OpenRouter key are present — Jev commonly runs through OpenRouter
    // even when the planner model itself is on OpenAI or Gemini. configuredProviders()'s fixed
    // priority order (openrouter, openai, gemini, custom) would pick OpenRouter here and silently
    // send the mic audio to the wrong vendor. The planner model must win instead.
    await withKeys({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key', PLANNER_MODEL: 'openai:gpt-4o' }, () => transcribe(clip));
    assert.equal(calls[0], 'https://api.openai.com/v1/audio/transcriptions', 'audio went to the configured planner provider (OpenAI), not OpenRouter');

    calls.length = 0;
    await withKeys({ OPENROUTER_API_KEY: 'or-key', GEMINI_API_KEY: 'g-key', PLANNER_MODEL: 'gemini:gemini-2.5-flash' }, () => transcribe(clip));
    assert.equal(calls[0], 'https://generativelanguage.googleapis.com/upload/v1beta/files', 'audio went to the configured planner provider (Gemini), with its current speech-to-text default');
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
