import { env, debugLog } from "./env.ts";
import { chat, type Effort } from "./providers.ts";
// The supervisor: a small chat LLM that watches the run and turns the user's task into one concrete
// action at a time. Jev then grounds that action to a page element. The supervisor also decides when
// the task is done or cannot be finished, and writes the one-line reply the user sees.

export type Plan = {
  status: "continue" | "done" | "blocked" | "question";
  next?: string; // one single action, e.g. "click the last story link in the list"
  completes_task?: boolean; // true when this action, if it works, finishes the task
  text?: string; // exact text to type, when the action types
  why?: string;
  answer?: string; // final reply for the user when done/blocked
  question?: string; // when status is "question": what to ask the user before going further
  risk?: "low" | "high"; // how hard the proposed action is to undo; "high" pauses for the user
  tabId?: number; // extension only: switch to an existing tab before the next step
};

export type PlanContext = {
  task: string;
  earlierTasks: string[];
  history: string[];
  lastResult?: string; // what the previous action led to
  page: { url: string; title: string; scroll: string; text: string; elements: string[] };
  step: number;
  maxSteps: number;
  tabs?: { id: number; title: string; url: string }[];
  currentTabId?: number;
  warnings?: string[]; // from the agent loop: repeated actions and wait caps the next action must respect
};

const SYSTEM = `You supervise a browser agent for a user who sends tasks in a chat.
The executor can do exactly ONE primitive per step: click a listed element, type text into a listed field (optionally pressing Enter), pick a native dropdown option, scroll down or up, go back, or wait. It only sees the page's element list and your instruction, so name the element the way it appears in the list (its text or role), or say "scroll down".

Reply with JSON only, no prose, shaped like:
{"status":"continue"|"done"|"blocked"|"question","next":"one concrete action","risk":"low"|"high","completes_task":true|false,"text":"exact text to type, only if the action types","why":"one short sentence","answer":"when done: one sentence confirming the result or answering the user's question from the page; when blocked: what is missing","question":"when status is question: the one thing you need the user to tell you"}
completes_task is true when this action, if it works, is the final thing the task needs (e.g. clicking the story the user asked to open). When completes_task is true, also fill "answer" with the one-line reply to show the user once it works.
"risk" describes the action in "next": "high" when carrying it out would commit something the user cannot simply undo in the browser (money moving, a message or post going out, data or an account being deleted, an order or application submitted, an irreversible setting changed), "low" otherwise. Judge the actual consequence on this page, not the wording of the button. A high-risk action is not executed until the user confirms it, so keep "why" specific enough for them to answer.
"question" ends the run and shows the user your question; the run continues from their reply with everything you have read so far. Use it when the task cannot be carried out correctly without something only the user knows (which account, which of two matching items, a value they never gave). Ask at most one thing, and only when guessing would be wrong rather than merely slower.

Rules:
- First check result_of_previous_action and the current page against every requirement in the task. "Expected to complete the task" is a prediction, not proof. A new page can be the wrong destination or an intermediate step. Say done only when the observed result satisfies the whole task.
- One action per step. Never combine actions.
- If the page says a save, submission, or load is still in progress, wait for its result. Do not click Save again or open another form while that operation is pending.
- Read the task together with the earlier tasks in this chat: it may be a follow-up like "go on", "the last one", or a correction. Follow-ups refer to the earlier task's site and list, not to whatever page happens to be open now. If the earlier task already achieved what the follow-up asks, say done and explain what was already done. If the earlier task's page was left, go back to it first.
- If the task is already achieved on the current page, say done immediately. Do not go back to repeat work that the history already confirms. Opening a repository or file preview does not satisfy a request for the raw file. Use the raw-file control and verify the destination.
- For a request for the most, least, highest, or lowest item, use the site's sort/filter controls or compare the relevant values before choosing. Default order and the first visible item are not evidence of rank. Preserve that choice in later steps rather than repeating the search.
- Elements marked (above/below the viewport) are off-screen but the executor can still click them directly: prefer clicking a listed element over scrolling. Scroll only when the element you need is not listed. Never scroll down when the page says it is at the bottom.
- The element list is complete for the page (up to 180 entries); "the last item" means the last matching element in the list.
- The history lists what was tried and whether the page changed. Never repeat an action that did not change the page; try another element or say blocked. If "warnings" is present, obey it before anything else: it names actions already repeated from this exact page state and wait limits. Choose something different.
- Go through what the task names. If the task says to go through onboarding, setup, a wizard, or a form, complete each step for real: never take a "skip", "demo mode", "later", or sample-data shortcut around it unless the task asks for that. When the task allows making answers up, fill every required field with plausible invented values (names, emails, company names, choices) and continue.
- Waiting is for an operation the page says is in progress. After a wait, read the page for the result instead of waiting again. Starting a run, job, analysis, or submission does not finish the task: the task is finished only once its result is visible on the page and you have read it.
- For an open-ended "test the app", "try it out", or "explore" task, cover the app the way a tester would: visit each main section, fill and submit at least one form, open settings, and try one invalid or empty input to see the error handling. Say done only when that coverage is reached or the step budget is nearly used, and let "answer" list what was covered and what was not. A "done" on such a task after only a navigation or two is refused by the runner and handed back to you as a warning, so keep exercising the app instead.
- If the task asks a question, say done with the answer taken from the page text.
- "answer" reports only what the history and page text show. Name items, tabs, runs, and results exactly as they appear on the page, and never mix up two similar items. Never state the outcome of an operation whose result you have not read: say it was started and its result was not observed. Never call a task done that was skipped or only partly done.
- Cookie or consent banners are not blockers: click the accept/consent/close button and continue.
- Say blocked only when the browser genuinely cannot go further: login walls, captchas, missing content, no sensible options left. Never say blocked just to ask a question: use status "question" for that. If earlier work in this chat already satisfies the task, say done and explain what was already done.`;

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
  return env.PLANNER_MODEL ?? "anthropic/claude-sonnet-5";
}

export type ReasoningLevel = "auto" | Effort;

// Output budget per effort level; reasoning tokens share it on most providers.
const BUDGET: Record<Effort, number> = { none: 1200, minimal: 4096, low: 4096, medium: 8192, high: 16384, xhigh: 32768, max: 32768 };

export async function plan(ctx: PlanContext, signal?: AbortSignal, model = plannerModel(), reasoning: ReasoningLevel = "auto", recovery = 0): Promise<Plan & { ms: number; cost_usd: number }> {
  const user = JSON.stringify(
    {
      task: ctx.task,
      earlier_tasks_in_this_chat: ctx.earlierTasks,
      step: `${ctx.step} of ${ctx.maxSteps}`,
      history: ctx.history,
      result_of_previous_action: ctx.lastResult ?? "none, this is the first step",
      ...(ctx.warnings?.length ? { warnings: ctx.warnings } : {}),
      page: ctx.page,
      ...(ctx.tabs ? { open_tabs: ctx.tabs, current_tab_id: ctx.currentTabId } : {}),
    },
  );
  debugLog( `\n=== step ${ctx.step}\n${user}\n`);
  const t0 = performance.now();
  const reply = await chat({
    spec: model,
    system: SYSTEM + (ctx.tabs ? '\nYou can also switch to an existing browser tab. open_tabs lists every available website tab across windows. To switch, return {"status":"continue","tabId":<numeric id>,"why":"reason"}; this uses one step and performs no page action. Read each relevant tab before comparing or summarizing multiple tabs. Tab references in the task identify exact IDs. Remember observed facts in your history when switching tabs. Never claim you read an unvisited tab.' : ''),
    user,
    effort: reasoning,
    maxTokens: (effort) => Math.min(32768, BUDGET[effort] * (recovery ? 2 : 1)),
    json: true,
    prefill: true, // forces a JSON reply, no prose, where the provider allows it
    temperature: 0,
    signal,
  });
  const ms = performance.now() - t0;
  if (reply.refusal || reply.finish === 'content_filter') throw new Error('the planner declined this request. edit the task and try again.');
  let content = reply.content;
  if (reply.prefilled && !content.trimStart().startsWith("{")) content = "{" + content;
  debugLog( `--- reply\n${content}\n`);
  let p: Plan;
  try {
    if (reply.finish === 'length') throw new Error('output limit reached');
    p = extractJson(content) as Plan;
    if (!p || !["continue", "done", "blocked", "question"].includes(p.status)) throw new Error('invalid plan status');
    if (p.status === 'question' && !(typeof p.question === 'string' && p.question.trim())) throw new Error('missing question');
    if (p.risk !== 'high' && p.risk !== 'low') delete p.risk; // anything else is not a verdict, treat it as no verdict
    if (p.tabId == null) delete p.tabId;
    if (p.tabId != null && !Number.isInteger(p.tabId)) throw new Error('invalid tab ID');
    if (p.tabId !== undefined && !ctx.tabs?.some(tab => tab.id === p.tabId)) throw new Error('tab ID is not in the open tabs');
    if (p.tabId !== undefined && p.tabId === ctx.currentTabId) throw new Error('already on the requested tab');
    if (p.status === 'continue' && !(typeof p.next === 'string' && p.next.trim()) && !(ctx.tabs && Number.isInteger(p.tabId))) throw new Error('missing next action');
  } catch {
    if (!recovery) {
      const retry = await plan(ctx, signal, model, reasoning, 1);
      return { ...retry, ms: retry.ms + ms, cost_usd: retry.cost_usd + reply.cost_usd };
    }
    throw new Error(`the planner (${model}) returned ${reply.finish === 'length' ? 'an incomplete reply after reaching its output limit' : content.trim() ? 'an invalid reply' : 'an empty reply'} twice. no further action was taken. try again or choose another planner model in settings.`);
  }
  return { ...p, ms, cost_usd: reply.cost_usd };
}
