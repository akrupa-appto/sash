// Audio transcription for voice dictation. Mirrors providers.ts: OpenRouter is the default and
// takes a plain model id, "openai:"/"gemini:"/"custom:" prefixes pick the official/custom APIs, and
// the provider is chosen by whichever key the user already configured for chat. BYOK end to end —
// audio goes straight to that provider, never to a sash server or to Google's free Web Speech API.
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

// Gemini runs speech through the Interactions API, which is the path Google recommends (the
// generateContent transcription page is marked legacy): upload the bytes with the Files API, then
// create an interaction that names the uploaded file's uri. A dedicated speech model
// (gemini-3.5-transcribe) needs no instruction — `generation_config.transcription_config` is the
// whole request — while a general multimodal model, which is what older settings named, still has
// to be told what to do in words.
// Documented at ai.google.dev/gemini-api/docs/transcribe and /docs/files (checked 2026-09-20).
// There is no Gemini key on this machine: this shape is documentation-verified and covered by a
// mocked fetch, not live-verified.
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
// The Files API upload lives on the /upload host path, with /upload BEFORE the version — the plain
// api host 404s for it (checked live 2026-09-20). The session PUT then goes to whatever
// x-goog-upload-url the start call returns.
const GEMINI_UPLOAD = "https://generativelanguage.googleapis.com/upload/v1beta";

// The transcript arrives in `output_text`. The older shapes are still read so a change in the
// response envelope cannot silently turn into an empty dictation: an `outputs` array with text
// entries, steps[] content parts carrying the text, and word-level annotations (word_info) when
// timestamps are on and no plain text part comes back at all.
function geminiTranscript(json: any): string {
  if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
  const parts = [...(json?.outputs ?? []), ...((json?.steps ?? []).flatMap((s: any) => s?.content ?? []))];
  const text = parts.filter((p: any) => typeof p?.text === "string").map((p: any) => p.text).join("").trim();
  if (text) return text;
  return parts
    .flatMap((p: any) => (p?.annotations ?? []).filter((a: any) => a?.type === "word_info").map((a: any) => String(a.text ?? "")))
    .join(" ")
    .trim();
}

// Files API resumable upload, the documented way to hand audio to the Interactions API. The first
// call only declares the upload and hands back the session URL in a header; the bytes go to that URL.
// Cleanup has to be promised, not fired and forgotten: the caller (extension/offscreen.js, driven by
// background.js) closes the offscreen document as soon as transcribe() resolves, and closing it
// aborts every request that document still has in flight — so a DELETE or cancel that was only
// kicked off is the same as one never sent, and the user's microphone clip stays in Google's file
// store for its full 48 hours. Every cleanup below is therefore awaited to completion before
// transcribe() can resolve. Losing the cleanup is not losing the transcript, though: it is reported
// and not thrown, so it can neither turn a successful dictation into a user-facing error nor replace
// the upload failure already on its way out of a failing one.
async function cleanupStep(what: string, request: () => Promise<Response>): Promise<void> {
  try {
    const res = await request();
    if (!res.ok) console.warn(`Gemini cleanup failed (${res.status}) for ${what}; the dictation clip may stay in Google's file store for up to 48 hours`);
  } catch (err: any) {
    console.warn(`Gemini cleanup failed for ${what} (${err?.message || err}); the dictation clip may stay in Google's file store for up to 48 hours`);
  }
}

// The uploaded file itself, deleted by the name the Files API gave it.
const deleteUploadedFile = (key: string, name: string) =>
  cleanupStep(name, () => fetch(`${GEMINI_API}/${name}`, { method: "DELETE", headers: { "x-goog-api-key": key }, signal: requestTimeout() }));

async function geminiUpload(key: string, bytes: Uint8Array, mimeType: string): Promise<{ uri: string; name: string }> {
  const mime = mimeType.split(";")[0];
  const start = await fetch(`${GEMINI_UPLOAD}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mime,
    },
    body: JSON.stringify({ file: { display_name: "dictation" } }),
    signal: requestTimeout(),
  });
  if (!start.ok) throw new Error(`Gemini transcription failed (${start.status}): ${(await start.text()).slice(0, 300)}`);
  const session = start.headers.get("x-goog-upload-url");
  if (!session) throw new Error("Gemini accepted the audio but returned no upload URL for it");
  // The session exists from the moment the start call returns, so a failure here has to cancel it:
  // otherwise the clip sits in Google's file store for its full 48 hours with nothing to delete it.
  const cancel = () => cleanupStep("the open upload session", () => fetch(session, { method: "POST", headers: { "X-Goog-Upload-Command": "cancel" }, signal: requestTimeout() }));
  let upload: Response;
  try {
    upload = await fetch(session, {
      method: "POST",
      headers: {
        "Content-Length": String(bytes.byteLength),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: bytes,
      signal: requestTimeout(),
    });
  } catch (err) {
    await cancel();
    throw err;
  }
  if (!upload.ok) {
    await cancel();
    throw new Error(`Gemini transcription failed (${upload.status}): ${(await upload.text()).slice(0, 300)}`);
  }
  // The bytes have landed, so the file now exists whether or not its reply is readable: a truncation
  // here would otherwise leave the clip in Google's store for its full 48 hours with nothing pointing
  // at it. Cancel the session on an unreadable reply, and delete a file whose name the reply did give.
  let json: any;
  try {
    json = await upload.json();
  } catch (err) {
    await cancel();
    throw err;
  }
  if (!json?.file?.uri) {
    if (json?.file?.name) await deleteUploadedFile(key, json.file.name);
    throw new Error("Gemini accepted the audio but returned no file uri for it");
  }
  return { uri: json.file.uri, name: json.file.name ?? "" };
}

async function geminiTranscribe(model: string, key: string, bytes: Uint8Array, mimeType: string): Promise<string> {
  const speech = /transcribe/i.test(model);
  const { uri, name } = await geminiUpload(key, bytes, mimeType);
  try {
    const input: any[] = [{ type: "audio", uri, mime_type: mimeType.split(";")[0] }];
    if (!speech) input.unshift({ type: "text", text: "Transcribe the spoken audio exactly as spoken. Reply with only the transcript text and no other commentary." });
    const res = await fetch(`${GEMINI_API}/interactions`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input, ...(speech ? { generation_config: { transcription_config: {} } } : {}) }),
      signal: requestTimeout(),
    });
    if (!res.ok) throw new Error(`Gemini transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return geminiTranscript(await res.json());
  } finally {
    // The clip is the user's own microphone audio. Uploaded files otherwise stay in Google's file
    // store for 48 hours, so drop it as soon as the transcript is in hand — and before returning,
    // because the caller closes the offscreen document the moment transcribe() resolves and that
    // would abort this request. Failing to delete is not an error; it is reported (cleanupStep).
    if (name) await deleteUploadedFile(key, name);
  }
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
