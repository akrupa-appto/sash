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
  if (process.env.TYPESAFE_API_KEY) {
    return {
      url: "https://api.typesafe.ai/v1/systemone",
      key: process.env.TYPESAFE_API_KEY,
      model: process.env.JEV_MODEL ?? "jev-latest",
      via: "typesafe",
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      url: "https://openrouter.ai/api/alpha/decisions",
      key: process.env.OPENROUTER_API_KEY,
      model: process.env.JEV_MODEL ?? "typesafe/jev-1.13",
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
export async function writeText(prompt: string, signal?: AbortSignal): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY needed for text generation");
  const model = process.env.TEXT_MODEL ?? "anthropic/claude-haiku-4.5";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content:
            "You fill one form field for a browser agent. Reply with ONLY the exact text to type. No quotes, no explanation.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`text model ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return String(json.choices?.[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
}
