import { env, debugLog } from "./env.ts";
import { chat, type Effort } from "./providers.ts";
// The supervisor: a small chat LLM that watches the run and turns the user's task into one concrete
// action at a time. Jev then grounds that action to a page element. The supervisor also decides when
// the task is done or cannot be finished, and writes the one-line reply the user sees.

export type Plan = {
  status: "continue" | "done" | "blocked" | "ask" | "approve" | "credential";
  blocked_reason?: string; // when blocked by the page itself: one of types.js BlockedReason
  question?: string; // status "ask": what the user is being asked
  options?: string[]; // status "ask": the choices, when the question is a choice
  action?: string; // status "approve": the action permission is being asked for
  origin?: string; // status "approve": the site the permission covers, "*" for every site
  sign_in_options?: string[]; // status "credential": named alternatives ("continue with Google")
  next?: string; // one single action, e.g. "click the last story link in the list"
  completes_task?: boolean; // true when this action, if it works, finishes the task
  text?: string; // exact text to type, when the action types
  why?: string;
  answer?: string; // final reply for the user when done/blocked
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
{"status":"continue"|"done"|"blocked","next":"one concrete action","completes_task":true|false,"text":"exact text to type, only if the action types","why":"one short sentence","answer":"when done: one sentence confirming the result or answering the user's question from the page; when blocked: what is missing. Use one sentence for a plain confirmation or single-fact answer. For a comparison or summary across multiple items, answer with one short line per item, newline-separated, no more than 10 lines."}
completes_task is true when this action, if it works, is the final thing the task needs (e.g. clicking the story the user asked to open). When completes_task is true, also fill "answer" with the one-line reply to show the user once it works.

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
- Say blocked only when the browser genuinely cannot go further: login walls, captchas, missing content, no sensible options left. Never say blocked just to ask a question. If earlier work in this chat already satisfies the task, say done and explain what was already done.
- When the page itself stopped the run rather than the task running out of road, say blocked and add "blocked_reason": one of "captcha_failed", "access_denied", "challenge_loop", "unexpected_bot_error". Use no other value.
- Instead of blocked, hand the turn back to the user when a human can unstick it:
  {"status":"ask","question":"one question","options":["choice a","choice b"],"why":"…"} when the task is ambiguous and you need a decision ("options" only when it really is a choice; leave it out for an open question).
  {"status":"approve","action":"what you are about to do","origin":"https://site.example","why":"…"} before something the user would want to authorise (an action that moves money, sends or posts something, deletes data or an account, submits an order or application, or changes an irreversible setting); use "*" as origin only when the action needs every site.
  {"status":"credential","why":"…","sign_in_options":["continue with Google"]} at a sign-in wall. The user fills the form in the panel; never type a password yourself and never read one off the page.`;

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

/**
 * The user's approval setting, expressed as a prompt instruction.
 *
 * The planner is what raises an approval (see the "approve" status above), so "ask before every
 * action" has to live here: there is no per-op gate in the executor, and a second one would be a
 * second source of truth for the same decision. `env.APPROVAL_MODE` is set by the extension from
 * settings (extension/config.js); unset means the server's original behaviour, which is the middle
 * setting.
 */
export function approvalInstruction(mode: string | undefined): string {
  if (mode === "every")
    return '\nThe user chose "ask before every action": before every action that changes the page or sends anything (clicking a control, typing, submitting, choosing an option, deleting, uploading), reply with {"status":"approve","action":"what you are about to do","origin":"the current site","why":"one short sentence"} and take no other action in that step. Reading, scrolling, waiting, and switching tabs need no approval. Ask again for each new action unless the user already allowed this exact action for this conversation or always; a longer step is cheaper than an unasked-for click. The only exception is a history line of the form "paused → approved <action> (<scope>)": the user has already answered for that one action, so when the action you are about to take is the one named there, answer {"status":"continue"} and do it — asking again would throw the user\'s answer away, whatever the scope. Any other action still needs its own approval, including the next one after this.';
  if (mode === "none")
    return '\nThe user chose "never ask": never reply with status "approve" and never with "ask". Decide from the page and act.';
  return "";
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
    system:
      SYSTEM +
      (ctx.tabs ? '\nYou can also switch to an existing browser tab. open_tabs lists every available website tab across windows. To switch, return {"status":"continue","tabId":<numeric id>,"why":"reason"}; this uses one step and performs no page action. Read each relevant tab before comparing or summarizing multiple tabs. Tab references in the task identify exact IDs. Remember observed facts in your history when switching tabs. Never claim you read an unvisited tab.' : '') +
      approvalInstruction(env.APPROVAL_MODE),
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
    if (!p || !["continue", "done", "blocked", "ask", "approve", "credential"].includes(p.status)) throw new Error('invalid plan status');
    if (p.status === 'ask' && !(typeof p.question === 'string' && p.question.trim()) && !(typeof p.why === 'string' && p.why.trim())) throw new Error('missing question');
    // "never ask — just do it" covers the planner's own questions too, not only the approval card: a
    // run that stops for an answer is exactly the wait the user turned off. The instruction above
    // already asks the model not to, so this is the floor under it — refused, retried once by the
    // recovery path below, and if the model asks again the run reports it rather than pausing.
    if (p.status === 'ask' && env.APPROVAL_MODE === 'none') throw new Error('questions are turned off');
    if (p.options !== undefined && !(Array.isArray(p.options) && p.options.every(o => typeof o === 'string'))) throw new Error('invalid options');
    if (p.tabId == null) delete p.tabId;
    if (p.tabId != null && !Number.isInteger(p.tabId)) throw new Error('invalid tab ID');
    if (p.tabId !== undefined && !ctx.tabs?.some(tab => tab.id === p.tabId)) throw new Error('tab ID is not in the open tabs');
    if (p.tabId !== undefined && p.tabId === ctx.currentTabId) throw new Error('already on the requested tab');
    if (p.status === 'continue' && !(typeof p.next === 'string' && p.next.trim()) && !(ctx.tabs && Number.isInteger(p.tabId))) throw new Error('missing next action');
  } catch (err) {
    if (!recovery) {
      const retry = await plan(ctx, signal, model, reasoning, 1);
      return { ...retry, ms: retry.ms + ms, cost_usd: retry.cost_usd + reply.cost_usd };
    }
    // Asking a question twice under "never ask — just do it" is not a broken model, it is the setting
    // working as asked, so say that instead of sending the user off to change their planner model.
    if (err instanceof Error && err.message === 'questions are turned off')
      throw new Error('this task needs an answer, and questions are turned off in settings ("never ask — just do it"). turn approvals back on to be asked, or reword the task so it needs no answer.');
    throw new Error(`the planner (${model}) returned ${reply.finish === 'length' ? 'an incomplete reply after reaching its output limit' : content.trim() ? 'an invalid reply' : 'an empty reply'} twice. no further action was taken. try again or choose another planner model in settings.`);
  }
  return { ...p, ms, cost_usd: reply.cost_usd };
}
