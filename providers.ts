import { env } from "./env.ts";
// Chat providers for the planner and the text model. OpenRouter is the default and takes plain model
// IDs; the official OpenAI and Gemini APIs are selected with an "openai:" or "gemini:" prefix, so the
// model spec stays one string everywhere (env, settings, requests). Jev has its own client in jev.ts.

export type ProviderId = "openrouter" | "openai" | "gemini" | "custom";
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Same shape OpenRouter publishes per model in GET /api/v1/models. OpenAI and Gemini do not publish
// this, so listModels derives it from documented model families.
export type ReasoningMeta = {
  supported_efforts?: Effort[] | null; // descending; null = every effort; missing = no effort selection
  default_effort?: Effort;
  default_enabled?: boolean;
  mandatory?: boolean; // cannot be turned off
};
export type ModelInfo = { id: string; name: string; reasoning?: ReasoningMeta; context?: number; price?: { input: number; output: number } }; // USD per 1M tokens

export const PROVIDERS: Record<ProviderId, { label: string; keyEnv: "OPENROUTER_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY" | "CUSTOM_API_KEY"; keysUrl: string; prefix: string }> = {
  openrouter: { label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", keysUrl: "https://openrouter.ai/settings/keys", prefix: "" },
  openai: { label: "OpenAI", keyEnv: "OPENAI_API_KEY", keysUrl: "https://platform.openai.com/api-keys", prefix: "openai:" },
  gemini: { label: "Gemini", keyEnv: "GEMINI_API_KEY", keysUrl: "https://aistudio.google.com/apikey", prefix: "gemini:" },
  // Any OpenAI-compatible chat-completions server (Groq, Together, vLLM, LM Studio, a proxy). CUSTOM_API_BASE is
  // the URL up to and including /v1; models are listed from its /models endpoint.
  custom: { label: "Custom", keyEnv: "CUSTOM_API_KEY", keysUrl: "", prefix: "custom:" },
};

export function parseModel(spec: string): { provider: ProviderId; model: string } {
  const m = spec.match(/^(openai|gemini|custom):(.+)$/);
  return m ? { provider: m[1] as ProviderId, model: m[2] } : { provider: "openrouter", model: spec };
}
// The custom provider's base URL, without a trailing slash, or undefined when unset or not https/http.
export function customBase(): string | undefined {
  const base = (env.CUSTOM_API_BASE || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/.test(base) ? base : undefined;
}
export function providerKey(provider: ProviderId): string | undefined {
  if (provider === "custom" && !customBase()) return undefined;
  return env[PROVIDERS[provider].keyEnv] || undefined;
}
export function providerLabel(provider: ProviderId): string {
  if (provider === "custom") { try { return `Custom · ${new URL(customBase() || "").hostname}`; } catch { return "Custom"; } }
  return PROVIDERS[provider].label;
}
export function configuredProviders(): ProviderId[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => providerKey(p));
}

export class ProviderError extends Error {
  provider: ProviderId;
  status: number;
  body: string;
  constructor(provider: ProviderId, status: number, body: string) {
    super(`${PROVIDERS[provider].label} ${status}: ${body.slice(0, 300)}`);
    this.provider = provider; this.status = status; this.body = body;
  }
}

export type ChatRequest = {
  spec: string; // model spec, see parseModel
  system: string;
  user: string;
  effort: Effort | "auto"; // auto = the fastest setting the model accepts
  maxTokens: number | ((effort: Effort) => number); // may depend on the effort the provider ends up using
  json?: boolean; // ask for a JSON object reply
  prefill?: boolean; // start the assistant turn with "{" (OpenRouter Anthropic models only)
  temperature?: number;
  signal?: AbortSignal;
};
export type ChatResult = {
  content: string;
  finish: "stop" | "length" | "content_filter" | "other";
  refusal: boolean;
  cost_usd: number; // 0 when the provider does not report cost (OpenAI, Gemini)
  prefilled: boolean; // the reply continues a "{" prefill
};

// Per-process memory of what each model rejected, so a task pays for at most one failed probe.
const noPrefill = new Set<string>();
const noJsonMode = new Set<string>();
const mandatoryReasoning = new Set<string>(["z-ai/glm-5.3-flash"]);
const noEffortOff = new Set<string>(); // OpenAI/Gemini models that reject turning reasoning off
const noReasoningField = new Set<string>(); // OpenRouter models that reject the reasoning parameter itself
export const _memo = { noPrefill, noJsonMode, mandatoryReasoning, noEffortOff, noReasoningField };

const fetchJson = async (provider: ProviderId, url: string, init: RequestInit) => {
  const res = await fetch(url, init);
  if (!res.ok) throw new ProviderError(provider, res.status, await res.text());
  return res.json();
};

const budget = (req: ChatRequest, effort: Effort | undefined) => (typeof req.maxTokens === "function" ? req.maxTokens(effort ?? "medium") : req.maxTokens);

export async function chat(req: ChatRequest): Promise<ChatResult> {
  // JSON mode on OpenAI-style endpoints requires the word "json" somewhere in the messages.
  if (req.json && !/json/i.test(req.system)) req = { ...req, system: `${req.system}\nReply with a single JSON object.` };
  const { provider, model } = parseModel(req.spec);
  const key = providerKey(provider);
  if (!key) throw new Error(`${PROVIDERS[provider].keyEnv} needed for ${PROVIDERS[provider].label} models`);
  if (provider === "openai") return openaiChat(req, model, key, "https://api.openai.com/v1", true);
  if (provider === "custom") return openaiChat(req, model, key, customBase()!, false);
  if (provider === "gemini") return geminiChat(req, model, key);
  return openrouterChat(req, model, key);
}

async function openrouterChat(req: ChatRequest, model: string, key: string, retry = 0): Promise<ChatResult> {
  const prefill = !!req.prefill && model.startsWith("anthropic/") && !noPrefill.has(model);
  const effort = req.effort === "auto" ? (mandatoryReasoning.has(model) ? "low" : "none") : req.effort;
  if (effort === "none" && mandatoryReasoning.has(model)) throw new Error("this model requires reasoning; choose auto, low, high, or maximum");
  const body = {
    model,
    max_tokens: budget(req, effort),
    ...(req.json && !noJsonMode.has(model) ? { response_format: { type: "json_object" } } : {}),
    ...(noReasoningField.has(model) && effort === "none" ? {} : { reasoning: effort !== "none" ? { effort } : { enabled: false } }),
    temperature: req.temperature ?? 0,
    usage: { include: true },
    messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }, ...(prefill ? [{ role: "assistant", content: "{" }] : [])],
  };
  let json: any;
  try {
    json = await fetchJson("openrouter", "https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: req.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://checkto.local", "X-Title": "checkto" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof ProviderError && retry < 3) {
      // Learn what this model rejects once, then retry the same request with that feature off.
      if (req.effort === "auto" && effort === "none" && err.status === 400 && /reasoning.*(?:mandatory|required|cannot be disabled)/i.test(err.body)) { mandatoryReasoning.add(model); return openrouterChat(req, model, key, retry + 1); }
      // Some endpoints reject the reasoning field outright. On auto, where off carries nothing, drop the field and retry.
      // An explicit "off" is never retried without it: the server default could be reasoning on.
      if (req.effort === "auto" && effort === "none" && !noReasoningField.has(model) && err.status === 400 && /reasoning/i.test(err.body)) { noReasoningField.add(model); return openrouterChat(req, model, key, retry + 1); }
      if (prefill && err.status === 400 && /prefill/i.test(err.body)) { noPrefill.add(model); return openrouterChat(req, model, key, retry + 1); }
      if (req.json && !noJsonMode.has(model) && [400, 404, 422].includes(err.status) && /response_format|json[_ ](?:object|mode)/i.test(err.body)) { noJsonMode.add(model); return openrouterChat(req, model, key, retry + 1); }
    }
    throw err;
  }
  if (json.error) throw new Error(`planner request failed: ${String(json.error.message || json.error.code || "provider error").slice(0, 300)}`);
  const choice = json.choices?.[0];
  const raw = choice?.message?.content;
  const content = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p: any) => p.text || "").join("") : "";
  return {
    content,
    finish: choice?.finish_reason === "length" ? "length" : choice?.finish_reason === "content_filter" ? "content_filter" : choice?.finish_reason === "stop" ? "stop" : "other",
    refusal: !!choice?.message?.refusal,
    cost_usd: Number(json.usage?.cost ?? 0),
    prefilled: prefill,
  };
}

// The fastest effort a model is documented to accept: "none" where allowed, otherwise its lowest level.
// Unknown models try "none" once and fall back to the server default.
export function fastestEffort(provider: ProviderId, model: string): Effort | undefined {
  const meta = inferReasoning(provider, model);
  if (!meta) return undefined;
  if (!meta.mandatory) return "none";
  const efforts = meta.supported_efforts ?? EFFORTS.filter((e) => e !== "none");
  return [...efforts].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}

// OpenAI chat completions, also used for any OpenAI-compatible server. reasoning_effort values are
// model-dependent (none/minimal/low/medium/high/xhigh/max). On OpenAI, "auto" asks for the fastest documented
// setting; a model that still rejects "none" (o-series, GPT-5 before 5.1, GPT-6) falls back to its default.
// A custom server gets no reasoning field on auto, since many do not accept it at all.
async function openaiChat(req: ChatRequest, model: string, key: string, base: string, autoOff: boolean, retry = 0): Promise<ChatResult> {
  const known = inferReasoning("openai", model);
  const effort = req.effort === "auto" ? (!autoOff || noEffortOff.has(model) ? undefined : known ? fastestEffort("openai", model) : "none") : req.effort;
  if (effort === "none" && noEffortOff.has(model) && req.effort !== "auto") throw new Error("this model cannot turn reasoning off; choose auto or a reasoning level");
  const body = {
    model,
    max_completion_tokens: budget(req, effort),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(req.json && !noJsonMode.has(model) ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
  };
  let json: any;
  try {
    json = await fetchJson(autoOff ? "openai" : "custom", `${base}/chat/completions`, {
      method: "POST", signal: req.signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof ProviderError && [400, 422].includes(err.status) && retry < 2) {
      if (effort === "none" && /reasoning/i.test(err.body)) { noEffortOff.add(model); if (req.effort === "auto") return openaiChat(req, model, key, base, autoOff, retry + 1); throw new Error("this model cannot turn reasoning off; choose auto or a reasoning level"); }
      if (req.json && !noJsonMode.has(model) && /response_format|json/i.test(err.body)) { noJsonMode.add(model); return openaiChat(req, model, key, base, autoOff, retry + 1); }
    }
    throw err;
  }
  if (json.error) throw new Error(`planner request failed: ${String(json.error.message || json.error.code || "provider error").slice(0, 300)}`);
  const choice = json.choices?.[0];
  return {
    content: typeof choice?.message?.content === "string" ? choice.message.content : "",
    finish: choice?.finish_reason === "length" ? "length" : choice?.finish_reason === "content_filter" ? "content_filter" : choice?.finish_reason === "stop" ? "stop" : "other",
    refusal: !!choice?.message?.refusal,
    cost_usd: 0,
    prefilled: false,
  };
}

// Gemini 3 takes thinkingLevel; Gemini 2.5 takes a thinkingBudget in tokens (0 = off, -1 = dynamic).
export function geminiThinking(model: string, effort: Effort | "auto"): Record<string, unknown> | undefined {
  const gen3 = /gemini-(?:[3-9]|\d{2})/.test(model);
  const meta = inferReasoning("gemini", model);
  if (effort === "none" && meta?.mandatory) throw new Error("this model cannot turn reasoning off; choose auto or a reasoning level");
  if (effort === "auto") {
    if (noEffortOff.has(model)) return undefined;
    // Lowest documented level: minimal on Gemini 3 Flash, low on Gemini 3 Pro, off on 2.5 Flash, low on 2.5 Pro.
    effort = fastestEffort("gemini", model) ?? (gen3 ? "low" : "none");
  }
  if (gen3) return { thinkingLevel: { none: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" }[effort] };
  return { thinkingBudget: { none: 0, minimal: 512, low: 1024, medium: 4096, high: 8192, xhigh: 24576, max: 24576 }[effort] };
}

async function geminiChat(req: ChatRequest, model: string, key: string, retry = 0): Promise<ChatResult> {
  const thinking = geminiThinking(model, req.effort);
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: {
      // Auto with thinking off is the small budget; once a model is known to always think, keep room for it.
      maxOutputTokens: budget(req, req.effort === "auto" ? (thinking?.thinkingBudget === 0 ? "none" : thinking ? "low" : "medium") : req.effort),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), // Gemini 3 wants its own default otherwise
      ...(req.json ? { responseMimeType: "application/json" } : {}),
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  };
  let json: any;
  try {
    json = await fetchJson("gemini", `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST", signal: req.signal, headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 400 && retry < 1 && thinking && /think/i.test(err.body)) {
      // The model rejects that thinking setting (for example 2.5 Pro cannot be turned off). Use its default.
      noEffortOff.add(model);
      if (req.effort === "auto") return geminiChat(req, model, key, retry + 1);
      throw new Error("this model does not support that reasoning level; choose auto or another level");
    }
    throw err;
  }
  const candidate = json.candidates?.[0];
  const content = (candidate?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
  const reason = candidate?.finishReason ?? json.promptFeedback?.blockReason;
  return {
    content,
    finish: reason === "MAX_TOKENS" ? "length" : reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || json.promptFeedback?.blockReason ? "content_filter" : reason === "STOP" ? "stop" : "other",
    refusal: false,
    cost_usd: 0,
    prefilled: false,
  };
}

const prettify = (id: string) => id.replace(/[-_]/g, " ").replace(/\b(gpt|o)(\d)/i, (_m, a, b) => `${a.toUpperCase()}${a.toLowerCase() === "gpt" ? "-" : ""}${b}`).replace(/\bgemini\b/i, "Gemini");

// Documented reasoning behaviour per model family. OpenAI: reasoning_effort supported by o-series and
// GPT-5+; "none" only from GPT-5.1 on; GPT-5 Pro is high only; GPT-6 has no "none". Gemini: 3.x uses
// thinking levels (Pro has no minimal); 2.5 Pro cannot turn thinking off; 2.5 Flash can; Flash Lite is off by default.
export function inferReasoning(provider: ProviderId, id: string): ReasoningMeta | undefined {
  if (provider === "openai") {
    if (/^o\d/.test(id)) return { supported_efforts: ["high", "medium", "low"], default_effort: "medium", mandatory: true };
    if (/^gpt-5-pro/.test(id)) return { supported_efforts: ["high"], default_effort: "high", mandatory: true };
    if (/^gpt-5-chat/.test(id)) return undefined;
    if (/^gpt-5(?:-|$)/.test(id)) return { supported_efforts: ["high", "medium", "low", "minimal"], default_effort: "medium", mandatory: true };
    if (/^gpt-5\./.test(id)) return { supported_efforts: ["xhigh", "high", "medium", "low", "none"], default_effort: "none", default_enabled: false, mandatory: false };
    if (/^gpt-(?:[6-9]|\d{2})/.test(id)) return { supported_efforts: ["xhigh", "high", "medium", "low"], default_effort: "medium", mandatory: true };
    return undefined;
  }
  if (provider === "gemini") {
    if (/gemini-(?:[3-9]|\d{2})[.-]/.test(id) || /gemini-(?:[3-9]|\d{2})$/.test(id)) {
      return /pro/.test(id)
        ? { supported_efforts: ["high", "medium", "low"], default_effort: "high", mandatory: true }
        : { supported_efforts: ["high", "medium", "low", "minimal"], default_effort: "high", mandatory: true };
    }
    if (/gemini-2\.5-pro/.test(id)) return { supported_efforts: ["high", "medium", "low"], default_effort: "medium", mandatory: true };
    if (/gemini-2\.5-flash-lite/.test(id)) return { supported_efforts: ["high", "medium", "low", "none"], default_effort: "none", default_enabled: false, mandatory: false };
    if (/gemini-2\.5-flash/.test(id)) return { supported_efforts: ["high", "medium", "low", "none"], default_effort: "medium", default_enabled: true, mandatory: false };
    return undefined;
  }
  return undefined;
}

export async function listModels(provider: ProviderId, signal?: AbortSignal): Promise<ModelInfo[]> {
  const key = providerKey(provider);
  if (provider === "openrouter") {
    const json = await fetchJson("openrouter", "https://openrouter.ai/api/v1/models", { signal, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    return (json.data ?? []).map((m: any) => ({
      id: m.id, name: m.name ?? m.id, reasoning: m.reasoning ?? undefined, context: m.context_length ?? undefined,
      price: m.pricing ? { input: Number(m.pricing.prompt) * 1e6, output: Number(m.pricing.completion) * 1e6 } : undefined,
    }));
  }
  if (!key) throw new Error(provider === "custom" ? "CUSTOM_API_BASE and CUSTOM_API_KEY needed to list custom models" : `${PROVIDERS[provider].keyEnv} needed to list ${PROVIDERS[provider].label} models`);
  if (provider === "custom") {
    const json = await fetchJson("custom", `${customBase()}/models`, { signal, headers: { Authorization: `Bearer ${key}` } });
    // No reasoning metadata exists for an arbitrary server; every level stays selectable and the server decides.
    return (json.data ?? []).map((m: any) => String(m.id)).sort().map((id: string) => ({ id: `custom:${id}`, name: id, reasoning: { supported_efforts: null, mandatory: false } }));
  }
  if (provider === "openai") {
    const json = await fetchJson("openai", "https://api.openai.com/v1/models", { signal, headers: { Authorization: `Bearer ${key}` } });
    return (json.data ?? [])
      .map((m: any) => String(m.id))
      .filter((id: string) => /^(?:gpt-\d|o\d)/.test(id) && !/realtime|audio|tts|transcribe|embedding|image|moderation|search|instruct|codex|-\d{4}-\d{2}-\d{2}$|\d{4}$/.test(id))
      .sort()
      .map((id: string) => ({ id: `openai:${id}`, name: prettify(id), reasoning: inferReasoning("openai", id) }));
  }
  const json = await fetchJson("gemini", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { signal, headers: { "x-goog-api-key": key } });
  return (json.models ?? [])
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent") && /^models\/gemini-/.test(m.name) && !/tts|image|embedding|live|audio|computer-use|robotics/.test(m.name))
    .map((m: any) => {
      const id = String(m.name).replace(/^models\//, "");
      return { id: `gemini:${id}`, name: m.displayName ?? prettify(id), reasoning: inferReasoning("gemini", id), context: m.inputTokenLimit ?? undefined };
    });
}
