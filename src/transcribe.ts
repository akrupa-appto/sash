// Audio transcription for voice dictation. Mirrors providers.ts: OpenRouter is the default and
// takes a plain model id, "openai:"/"gemini:"/"custom:" prefixes pick the official/custom APIs, and
// the provider is chosen by whichever key the user already configured for chat. BYOK end to end —
// audio goes straight to that provider, never to a checkto server or to Google's free Web Speech API.
import { env } from "./env.ts";
import { PROVIDERS, customBase, configuredProviders, parseModel, providerKey } from "./providers.ts";
import type { ProviderId } from "./providers.ts";

// The provider dictation resolves to when the caller doesn't name one explicitly: the provider
// backing the user's configured planner model (BYOK — the same provider chat already uses), not
// whichever provider happens to have a key first. The extension sets env.PLANNER_MODEL from
// settings.model before every transcribe call (see extension/config.js configure()), so this is
// the same resolution planner.ts's plannerModel() uses for chat. Falls back to
// configuredProviders()[0] only when no planner model is set at all (no PLANNER_MODEL env, e.g.
// outside the extension), which is the only case where there is no configured provider to defer to.
function defaultProvider(): ProviderId | undefined {
  if (env.PLANNER_MODEL) return parseModel(env.PLANNER_MODEL).provider;
  return configuredProviders()[0];
}

export type AudioInput = Blob | ArrayBuffer | Uint8Array;
export type TranscribeRequest = {
  spec?: string; // model spec, see providers.ts parseModel; defaults to this provider's transcription model
  audio: AudioInput;
  mimeType: string; // e.g. "audio/webm;codecs=opus", as produced by MediaRecorder
  filename?: string;
};
export type TranscribeResult = { text: string };

// A provider that cannot transcribe at all (no key) or that this build has never seen transcribe
// audio successfully (a custom server missing the endpoint). Distinct from a plain network/HTTP
// error so callers can show "add a key" or "this server can't do voice" instead of a raw fetch failure.
export class TranscribeUnsupportedError extends Error {
  provider: ProviderId;
  constructor(provider: ProviderId, message: string) {
    super(message);
    this.provider = provider;
  }
}

// Whole-file model used when the caller does not name one. These are documented as accepting the
// webm/opus output MediaRecorder produces natively, with no client-side PCM conversion needed.
const DEFAULT_MODEL: Record<ProviderId, string> = {
  // Current as of 2026-09-20. OpenAI's own deprecation notice (2026-08-26) replaces whisper-1,
  // gpt-4o-transcribe and gpt-4o-mini-transcribe with gpt-transcribe (file/whole-utterance) or
  // gpt-live-transcribe (microphone streams); gemini-3.5-transcribe is Gemini's speech-to-text
  // model. A custom OpenAI-compatible server is the one case with no shared answer: whisper-1 is
  // still the id such servers most often implement, so it stays the custom default.
  openrouter: "openai/gpt-transcribe",
  openai: "gpt-transcribe",
  gemini: "gemini-3.5-transcribe",
  custom: "whisper-1",
};

// A provider-only voice choice still needs to become a real model spec before it crosses the
// extension boundary. Keep that resolution here, beside the defaults used by transcribe(), so UI
// capability probes and actual audio requests cannot drift or substitute a sentinel as a model.
export function defaultTranscriptionSpec(provider: ProviderId): string {
  return `${PROVIDERS[provider].prefix}${DEFAULT_MODEL[provider]}`;
}

// What the UI can ask, cheaply and synchronously, to decide whether to offer voice dictation at
// all and which eagerness modes to allow. Derived entirely from which provider is configured; no
// network round trip. `streaming` is always false in this stage: true mid-sentence partials need
// OpenAI Realtime or Gemini Live, which this build does not implement (see transcribe.ts header).
// This build instead supports periodic whole-chunk re-transcription for incremental partials, which
// every transcribe-capable provider below can already do.
export type TranscribeCapability = {
  provider?: ProviderId;
  canTranscribe: boolean;
  streaming: boolean;
  reason?: string;
};

export function transcribeCapability(spec?: string): TranscribeCapability {
  const provider: ProviderId | undefined = spec ? parseModel(spec).provider : defaultProvider();
  if (!provider) return { canTranscribe: false, streaming: false, reason: "no provider configured; add an API key in settings" };
  const key = providerKey(provider);
  if (!key) return { provider, canTranscribe: false, streaming: false, reason: `${PROVIDERS[provider].label} needs an API key to transcribe audio` };
  if (provider === "custom") {
    return { provider, canTranscribe: true, streaming: false, reason: "a custom server is not guaranteed to implement /v1/audio/transcriptions; this is a best guess until it is tried" };
  }
  return { provider, canTranscribe: true, streaming: false };
}

function extFromMime(mimeType: string): string {
  const m = /audio\/([a-z0-9-]+)/i.exec(mimeType || "");
  const type = (m?.[1] || "webm").toLowerCase().split(";")[0];
  return ({ mpeg: "mp3", "x-m4a": "m4a" } as Record<string, string>)[type] || type;
}

async function toBytes(audio: AudioInput): Promise<Uint8Array> {
  if (audio instanceof Uint8Array) return audio;
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (typeof Blob !== "undefined" && audio instanceof Blob) return new Uint8Array(await audio.arrayBuffer());
  throw new Error("unsupported audio input: expected a Blob, ArrayBuffer, or Uint8Array");
}

async function toBase64(bytes: Uint8Array): Promise<string> {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

// OpenRouter documents this endpoint's own upstream timeout at 60s; a client-side timeout on top of
// that keeps a stalled request from leaving dictation:stop (and a hot mic) hanging indefinitely.
const REQUEST_TIMEOUT_MS = 60_000;
const requestTimeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

// OpenRouter's whole-file endpoint (shipped 2026-05-01). Accepts multipart or base64 JSON; multipart
// is used here since it needs no client-side base64 expansion for what's usually the larger payload.
async function openrouterTranscribe(model: string, key: string, bytes: Uint8Array, mimeType: string, filename: string): Promise<string> {
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: requestTimeout() });
  if (!res.ok) throw new Error(`OpenRouter transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  return String(json.text ?? "");
}

// Shared by OpenAI and any OpenAI-compatible server: POST .../audio/transcriptions, multipart.
// A 404/405 means the endpoint just doesn't exist on this server — that is the "not guaranteed"
// case the custom provider warns about, so it gets its own clear error rather than a raw HTTP one.
async function openaiStyleTranscribe(provider: ProviderId, model: string, key: string, bytes: Uint8Array, mimeType: string, filename: string, base: string): Promise<string> {
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  let res: Response;
  try {
    res = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: requestTimeout() });
  } catch (err: any) {
    if (provider === "custom") throw new TranscribeUnsupportedError(provider, `could not reach ${base}/audio/transcriptions: ${err?.message || err}`);
    throw err;
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    if (provider === "custom" && (res.status === 404 || res.status === 405)) {
      throw new TranscribeUnsupportedError("custom", `this custom server doesn't support audio transcription (no /v1/audio/transcriptions endpoint at ${base}). configure OpenRouter, OpenAI, or Gemini for voice dictation instead.`);
    }
    throw new Error(`${PROVIDERS[provider].label} transcription failed (${res.status}): ${body}`);
  }
  const json: any = await res.json();
  return String(json.text ?? "");
}

// Gemini's transcription model answers through generateContent too (it has no separate endpoint),
// so the audio still goes inline as base64, same as the chat path in providers.ts. 20MB inline cap.
//
// Two shapes, because the model decides: a dedicated speech-to-text model (gemini-3.5-transcribe)
// takes the audio and a `generationConfig.audioTranscriptionConfig` and hands back the transcript,
// while a general multimodal model (which is what older settings named) needs to be told what to
// do in words. The response is read both ways: the transcript normally arrives as text parts, and
// with word-level annotations enabled it arrives as `audioTranscription.words` instead.
// Documented at ai.google.dev/gemini-api/docs/generate-content/transcribe (checked 2026-09-20).
// Only the model-plus-instruction shape has been exercised on this machine: there is no Gemini key
// here, so the dedicated shape is documentation-verified, not live-verified.
async function geminiTranscribe(model: string, key: string, bytes: Uint8Array, mimeType: string): Promise<string> {
  const data = await toBase64(bytes);
  const audio = { inlineData: { mimeType: mimeType.split(";")[0], data } };
  const body = /transcribe/i.test(model)
    ? { contents: [{ role: "user", parts: [audio] }], generationConfig: { audioTranscriptionConfig: {} } }
    : {
        contents: [{
          role: "user",
          parts: [
            { text: "Transcribe the spoken audio exactly as spoken. Reply with only the transcript text and no other commentary." },
            audio,
          ],
        }],
      };
  // The 20MB inline cap is on the serialized request, not the raw audio: base64 alone inflates the
  // clip by ~4/3, on top of the JSON wrapper. Check the actual encoded payload, not the raw bytes.
  const encodedSize = new TextEncoder().encode(JSON.stringify(body)).byteLength;
  if (encodedSize > 20 * 1024 * 1024) throw new Error("audio clip is too large for Gemini's inline 20MB limit; use OpenRouter or OpenAI instead");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: requestTimeout(),
  });
  if (!res.ok) throw new Error(`Gemini transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p: any) => p.text ?? "").join("").trim();
  if (text) return text;
  // Word-level annotation shape: one entry per recognized word, no text part at all.
  const words = parts.flatMap((p: any) => (p.audioTranscription?.words ?? []).map((w: any) => String(w.word ?? "")));
  return words.join(" ").trim();
}

export async function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  const { provider, model } = req.spec ? parseModel(req.spec) : { provider: defaultProvider(), model: undefined };
  if (!provider) throw new Error("no transcription provider configured; add an API key in settings");
  const key = providerKey(provider);
  if (!key) throw new Error(`${PROVIDERS[provider].label} needs an API key to transcribe audio`);
  const bytes = await toBytes(req.audio);
  const filename = req.filename || `dictation.${extFromMime(req.mimeType)}`;
  if (provider === "gemini") return { text: await geminiTranscribe(model || DEFAULT_MODEL.gemini, key, bytes, req.mimeType) };
  if (provider === "openrouter") return { text: await openrouterTranscribe(model || DEFAULT_MODEL.openrouter, key, bytes, req.mimeType, filename) };
  if (provider === "openai") return { text: await openaiStyleTranscribe("openai", model || DEFAULT_MODEL.openai, key, bytes, req.mimeType, filename, "https://api.openai.com/v1") };
  if (provider === "custom") {
    const base = customBase();
    if (!base) throw new Error("CUSTOM_API_BASE needed to transcribe with the custom provider");
    return { text: await openaiStyleTranscribe("custom", model || DEFAULT_MODEL.custom, key, bytes, req.mimeType, filename, base) };
  }
  throw new Error(`unknown provider ${provider}`);
}
