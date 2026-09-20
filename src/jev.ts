import { env } from "./env.ts";
import { chat, parseModel, providerKey, PROVIDERS } from "./providers.ts";
// Thin client for Jev (TypeSafe System One). Works against TypeSafe directly or via OpenRouter.

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type NoulAnswer = { type: "noul"; noul: number; confidence?: number };
export type Answer = ChoiceAnswer | NoulAnswer | { type: "score"; score: number };

export type JevResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000;

function endpoint() {
  if (env.TYPESAFE_API_KEY) {
    return {
      url: "https://api.typesafe.ai/v1/systemone",
      key: env.TYPESAFE_API_KEY,
      model: env.JEV_MODEL ?? "jev-latest",
      via: "typesafe",
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      url: "https://openrouter.ai/api/alpha/decisions",
      key: env.OPENROUTER_API_KEY,
      model: env.JEV_MODEL ?? "typesafe/jev-1.13",
      via: "openrouter",
    };
  }
  throw new Error("Set TYPESAFE_API_KEY or OPENROUTER_API_KEY in .env");
}

export function jevVia() {
  return endpoint().via;
}

export async function decide(
  state: unknown,
  questions: Record<string, Question>,
  signal?: AbortSignal,
): Promise<JevResponse & { ms: number; cost_usd: number }> {
  const ep = endpoint();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = performance.now();
    const res = await fetch(ep.url, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${ep.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://checkto.local",
        "X-Title": "checkto",
      },
      body: JSON.stringify({ model: ep.model, state, questions }),
    });
    const ms = performance.now() - t0;
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      lastErr = new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const json = (await res.json()) as JevResponse;
    return { ...json, ms, cost_usd: (json.usage as any)?.cost ?? (json.usage?.input_tokens ?? 0) * PRICE_PER_INPUT_TOKEN };
  }
  throw lastErr;
}

// Jev cannot write text. When a step needs typed text that isn't in the goal, a small LLM writes it.
// TEXT_MODEL picks the model (with the same provider prefixes as the planner). Without it, a cheap
// OpenRouter model is used, or the planner's own provider when there is no OpenRouter key.
export function textModel(): string {
  // An explicit TEXT_MODEL is honoured or refused, never silently swapped for another provider.
  if (env.TEXT_MODEL) {
    const { provider } = parseModel(env.TEXT_MODEL);
    if (!providerKey(provider)) throw new Error(`${PROVIDERS[provider].keyEnv} needed for the text model ${env.TEXT_MODEL}`);
    return env.TEXT_MODEL;
  }
  const candidates = ["anthropic/claude-haiku-4.5", env.PLANNER_MODEL].filter((m): m is string => !!m);
  const usable = candidates.find((m) => providerKey(parseModel(m).provider));
  if (!usable) throw new Error("OPENROUTER_API_KEY needed for text generation");
  return usable;
}

export async function writeText(prompt: string, signal?: AbortSignal): Promise<string> {
  const reply = await chat({
    spec: textModel(),
    system: "You fill one form field for a browser agent. Reply with ONLY the exact text to type. No quotes, no explanation.",
    user: prompt,
    effort: "auto",
    maxTokens: 80,
    signal,
  });
  return reply.content.trim().replace(/^["']|["']$/g, "");
}
