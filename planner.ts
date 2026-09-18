// The supervisor: a small chat LLM that watches the run and turns the user's task into one concrete
// action at a time. Jev then grounds that action to a page element. The supervisor also decides when
// the task is done or cannot be finished, and writes the one-line reply the user sees.

export type Plan = {
  status: "continue" | "done" | "blocked";
  next?: string; // one single action, e.g. "click the last story link in the list"
  completes_task?: boolean; // true when this action, if it works, finishes the task
  text?: string; // exact text to type, when the action types
  why?: string;
  answer?: string; // final reply for the user when done/blocked
};

export type PlanContext = {
  task: string;
  earlierTasks: string[];
  history: string[];
  lastResult?: string; // what the previous action led to
  page: { url: string; title: string; scroll: string; text: string; elements: string[] };
  step: number;
  maxSteps: number;
};

const SYSTEM = `You supervise a browser agent for a user who sends tasks in a chat.
The executor can do exactly ONE primitive per step: click a listed element, type text into a listed field (optionally pressing Enter), pick a native dropdown option, scroll down or up, go back, or wait. It only sees the page's element list and your instruction, so name the element the way it appears in the list (its text or role), or say "scroll down".

Reply with JSON only, no prose, shaped like:
{"status":"continue"|"done"|"blocked","next":"one concrete action","completes_task":true|false,"text":"exact text to type, only if the action types","why":"one short sentence","answer":"when done: one sentence confirming the result or answering the user's question from the page; when blocked: what is missing"}
completes_task is true when this action, if it works, is the final thing the task needs (e.g. clicking the story the user asked to open). When completes_task is true, also fill "answer" with the one-line reply to show the user once it works.

Rules:
- First check result_of_previous_action and the current page against every requirement in the task. "Expected to complete the task" is a prediction, not proof. A new page can be the wrong destination or an intermediate step. Say done only when the observed result satisfies the whole task.
- One action per step. Never combine actions.
- Read the task together with the earlier tasks in this chat: it may be a follow-up like "go on", "the last one", or a correction. Follow-ups refer to the earlier task's site and list, not to whatever page happens to be open now. If the earlier task already achieved what the follow-up asks, say done and explain what was already done. If the earlier task's page was left, go back to it first.
- If the task is already achieved on the current page, say done immediately. Do not go back to repeat work that the history already confirms. Opening a repository or file preview does not satisfy a request for the raw file. Use the raw-file control and verify the destination.
- For a request for the most, least, highest, or lowest item, use the site's sort/filter controls or compare the relevant values before choosing. Default order and the first visible item are not evidence of rank. Preserve that choice in later steps rather than repeating the search.
- Elements marked (above/below the viewport) are off-screen but the executor can still click them directly: prefer clicking a listed element over scrolling. Scroll only when the element you need is not listed. Never scroll down when the page says it is at the bottom.
- The element list is complete for the page (up to 180 entries); "the last item" means the last matching element in the list.
- The history lists what was tried and whether the page changed. Never repeat an action that did not change the page; try another element or say blocked.
- If the task asks a question, say done with the answer taken from the page text.
- Cookie or consent banners are not blockers: click the accept/consent/close button and continue.
- Say blocked only when the browser genuinely cannot go further: login walls, captchas, missing content, no sensible options left. Never say blocked just to ask a question. If earlier work in this chat already satisfies the task, say done and explain what was already done.`;

// Take the first complete top-level {...} object, ignoring anything the model appends after it.
function extractJson(s: string): any {
  const start = s.indexOf("{");
  if (start < 0) throw new Error(`supervisor returned no JSON: ${s.slice(0, 200)}`);
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error(`supervisor returned unterminated JSON: ${s.slice(0, 200)}`);
}

export function plannerModel() {
  return process.env.PLANNER_MODEL ?? "anthropic/claude-sonnet-5";
}

// Some models (e.g. Sonnet 5) reject assistant prefill; remembered per process after the first 400.
const noPrefill = new Set<string>();
// GLM requires reasoning. Other custom models can report that requirement too.
const mandatoryReasoning = new Set<string>(["z-ai/glm-5.3-flash"]);

export type ReasoningLevel = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export async function plan(ctx: PlanContext, signal?: AbortSignal, model = plannerModel(), reasoning: ReasoningLevel = "auto"): Promise<Plan & { ms: number; cost_usd: number }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY needed for the supervisor");
  const user = JSON.stringify(
    {
      task: ctx.task,
      earlier_tasks_in_this_chat: ctx.earlierTasks,
      step: `${ctx.step} of ${ctx.maxSteps}`,
      history: ctx.history,
      result_of_previous_action: ctx.lastResult ?? "none, this is the first step",
      page: ctx.page,
    },
  );
  if (process.env.PLANNER_DEBUG) (await import("node:fs")).appendFileSync(process.env.PLANNER_DEBUG, `\n=== step ${ctx.step}\n${user}\n`);
  const t0 = performance.now();
  const prefill = model.startsWith("anthropic/") && !noPrefill.has(model);
  const effort = reasoning === "auto" ? (mandatoryReasoning.has(model) ? "low" : "none") : reasoning;
  const needsReasoning = effort !== "none";
  if (!needsReasoning && mandatoryReasoning.has(model)) throw new Error("this model requires reasoning; choose auto, low, high, or maximum");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://checkto.local", "X-Title": "checkto" },
    body: JSON.stringify({
      model,
      max_tokens: { none: 600, minimal: 2048, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 16384 }[effort],
      reasoning: needsReasoning ? { effort } : { enabled: false },
      temperature: 0,
      usage: { include: true },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
        ...(prefill ? [{ role: "assistant", content: "{" }] : []), // prefill: forces a JSON reply, no prose
      ],
    }),
  });
  const ms = performance.now() - t0;
  if (!res.ok) {
    const body = await res.text();
    if (reasoning === "auto" && !needsReasoning && res.status === 400 && /reasoning.*(?:mandatory|required|cannot be disabled)/i.test(body)) {
      mandatoryReasoning.add(model);
      return plan(ctx, signal, model, reasoning);
    }
    if (prefill && res.status === 400 && /prefill/i.test(body)) {
      noPrefill.add(model);
      return plan(ctx, signal, model, reasoning);
    }
    throw new Error(`supervisor ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  let content = String(json.choices?.[0]?.message?.content ?? "");
  if (prefill && !content.trimStart().startsWith("{")) content = "{" + content;
  if (process.env.PLANNER_DEBUG) (await import("node:fs")).appendFileSync(process.env.PLANNER_DEBUG, `--- reply\n${content}\n`);
  const p = extractJson(content) as Plan;
  if (!["continue", "done", "blocked"].includes(p.status)) p.status = "continue";
  return { ...p, ms, cost_usd: Number(json.usage?.cost ?? 0) };
}
