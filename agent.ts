import type { Page } from "playwright";
import { decide, writeText, type ChoiceAnswer, type Question } from "./jev.ts";
import { plan, plannerModel, type ReasoningLevel } from "./planner.ts";
import * as b from "./browser.ts";
import {
  approvalRequest,
  askRequest,
  blockedText,
  credentialRequest,
  declineAll,
  denialCutoffMessage,
  denialsExhausted,
  isBlockedReason,
  MAX_CREDENTIAL_FIELDS,
  pickBlocking,
} from "./extension/requests.js";

// Everything a paused run needs to carry on once a request is answered: the task it was given, what
// it has read so far, and which step it stopped on. A resumed run is the same run, not a fresh task.
// This is deliberately narrower than the request itself (extension/requests.js owns what was asked and
// how it was answered) — it only carries the guards that must survive a pause regardless of *why* the
// turn paused: an unconfirmed failed step must still block "done" after resuming, and an exploratory
// task must not get a fresh, easier coverage floor just because it stopped to ask, approve, or sign in.
export type PausedRun = {
  goal: string; // the original task, not the reply that resumes it
  history: string[];
  step: number;
  realActions?: number;
  pagesSeen?: string[];
  coverageRefusals?: number;
  pendingFailure?: { step: number; action: string; note: string; elementKey?: string; op?: string };
};

export type RunInput = {
  url?: string; // omit to continue on the page the browser is already on
  goal: string; // a new task, or — with `resume` — the reply that answered the request that paused it
  resume?: PausedRun; // continue a run that paused on a request rather than starting a fresh one
  values?: string[]; // texts the user says may need typing
  maxSteps?: number;
  previousTasks?: string[]; // earlier messages in this chat, oldest first, so "go on" has context
  supervisor?: boolean; // default true: a chat LLM thinks (one action at a time), Jev executes (grounds it to an element)
  reasoning?: ReasoningLevel;
  model?: string; // planner model for this task; fast mode still uses Jev
  liveView?: boolean; // Anchor streams the browser directly; skip screenshot work
  denials?: Record<string, number>; // how often this conversation already refused each request, by denialKey
  browserTabs?: {
    list: () => Promise<{ id: number; title: string; url: string }[]>;
    select: (id: number) => Promise<Page>;
    currentId: (page: Page) => number;
  };
};

// The step log's four written forms of one action (mirrors extension/types.js's StepLogEntry).
export type StepLogEntry = {
  ticker: string; // present-tense line that scrolls by while the step runs
  expanded: string; // full sentence shown once the step is open/done
  fragment: string; // lowercase clause that reads mid-sentence
  fragmentCapitalized: string; // the same clause starting a sentence
};

export type StepEvent = {
  type: "step";
  step: number;
  url: string;
  title: string;
  screenshot: string; // base64 jpeg
  elementCount: number;
  answers: Record<string, unknown>;
  plan?: string; // the supervisor's single-action instruction for this step
  why?: string;
  action: string;
  log: StepLogEntry;
  jevMs: number;
  planMs: number;
  execMs: number;
  costUsd: number;
  note?: string;
};

export type BlockingRequest = Record<string, unknown> & { id: string; type: string };

export type EndEvent = {
  type: "end";
  status: "done" | "blocked" | "max_steps" | "error" | "stopped" | "needs_input";
  message: string;
  answer?: string; // supervisor's one-line reply for the user
  totalCostUsd: number;
  steps: number;
  blockedReason?: string; // one of types.js BlockedReason, when the page blocked the run
  requests?: BlockingRequest[]; // everything this turn is waiting on
  request?: BlockingRequest; // the one the panel shows, by RequestType priority
  declined?: Record<string, unknown>[]; // on stop: an explicit decline per pending request
  resumeState?: PausedRun; // on "needs_input": pass it back as RunInput.resume once the request is answered
};

export type Event =
  | { type: "start"; via: string; url: string; supervisor?: string }
  | { type: "screenshot"; screenshot: string; url: string; title: string }
  | StepEvent
  | EndEvent;

const OPS: Record<string, string> = {
  CLICK: "Click a link, button, checkbox, tab, or other control (`click_target` says which)",
  TYPE_TEXT: "Type text into a text field (`type_target` says which field, `type_value` which text)",
  TYPE_AND_ENTER: "Type text into a field and press Enter to submit it (search boxes, single-field forms)",
  SELECT: "Pick an option in a native dropdown (`select_target` says which)",
  SCROLL_DOWN: "Scroll down to reveal more of the page",
  SCROLL_UP: "Scroll up",
  GO_BACK: "Go back to the previous page",
  WAIT: "Wait for the page to finish loading or changing",
  DONE: "The goal is fully achieved and visible on the current page. Nothing more to do",
  BLOCKED: "The goal cannot be achieved from here (login wall, captcha, missing content, wrong site)",
  CANNOT: "The instruction in `goal` cannot be carried out on this page: no listed element matches it, or it asks to scroll further than the page goes",
};

// A repeated (page state, action) pair is reported to the models at REPEAT_WARN_AT and ends the run at REPEAT_STOP_AT.
const REPEAT_WARN_AT = 2;
const REPEAT_STOP_AT = 4;
// After this many waits in a row the next step must inspect the page instead of waiting again.
const WAIT_CAP = 3;

// "test the app", "try it out", "explore it": open-ended tasks whose whole point is coverage. A run that
// navigates once and calls it tested is a failed run, so these tasks carry a floor: real actions taken and
// distinct page states seen before "done" is accepted. Every other task keeps its one-step path.
const EXPLORE_MIN_ACTIONS = 5;
const EXPLORE_MIN_PAGES = 3;
// A "done" refused this many times in a row without any new action in between ends the run honestly
// instead of burning the whole budget on a model that insists it is finished.
const EXPLORE_REFUSALS_BEFORE_STOP = 3;
const EXPLORE_VERB = /\b(test|tests|testing|qa|explore|exploring|exercise|try|trying|play|poke|tour)\b/i;
const EXPLORE_TARGET = /\b(app|apps|application|site|website|webapp|dashboard|product|ui|feature|features|demo|everything|it out|around)\b/i;
function isExploratoryTask(goal: string): boolean {
  return EXPLORE_VERB.test(goal) && EXPLORE_TARGET.test(goal);
}
// Actions that count as really using the app. A wait, a refusal, or a failed action is not coverage.
const REAL_ACTIONS = new Set(["CLICK", "TYPE_TEXT", "TYPE_AND_ENTER", "SELECT", "SCROLL_DOWN", "SCROLL_UP", "GO_BACK", "SWITCH_TAB"]);

// The planner sees the whole run: recent steps in full, older ones shortened. A skipped step early in
// a long task must still be visible when the final answer is written.
function compactHistory(history: string[], full = 12, older = 220): string[] {
  return history.map((h, i) => (i < history.length - full && h.length > older ? h.slice(0, older) + "…" : h));
}

// The part of the page text that was not there before, shortened: the observation the step produced.
function newText(prev: string, cur: string, max = 240): string {
  let i = 0;
  while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
  if (i < cur.length) i = cur.lastIndexOf(" ", i - 1) + 1; // back up to the start of the changed word
  const fresh = cur.slice(i).replace(/\s+/g, " ").trim();
  return fresh ? `, showing: "${fresh.slice(0, max)}${fresh.length > max ? "…" : ""}"` : "";
}

// Builds a StepLogEntry from a present-tense ticker line and its past-tense counterpart. `expanded` and
// `fragmentCapitalized` end up the same text for most steps; they exist as separate fields because the
// row that shows a finished step and the clause that opens a joined summary sentence are different jobs.
function logEntry(ticker: string, past: string): StepLogEntry {
  return { ticker, expanded: past, fragment: past.charAt(0).toLowerCase() + past.slice(1), fragmentCapitalized: past };
}

// Fallback ticker/past forms for an operation with no more specific target description yet.
const GENERIC_LOG: Record<string, { ticker: string; past: string }> = {
  CLICK: { ticker: "Clicking", past: "Clicked" },
  TYPE_TEXT: { ticker: "Typing", past: "Typed" },
  TYPE_AND_ENTER: { ticker: "Typing", past: "Typed" },
  SELECT: { ticker: "Selecting", past: "Selected" },
  SCROLL_DOWN: { ticker: "Scrolling down the page", past: "Scrolled down the page" },
  SCROLL_UP: { ticker: "Scrolling up the page", past: "Scrolled up the page" },
  GO_BACK: { ticker: "Going back a page", past: "Went back a page" },
  WAIT: { ticker: "Waiting for the page", past: "Waited for the page" },
  CANNOT: { ticker: "Checking the page", past: "Found no way to do that on the page" },
  SWITCH_TAB: { ticker: "Switching tabs", past: "Switched tabs" },
  DONE: { ticker: "Wrapping up", past: "Finished the task" },
  BLOCKED: { ticker: "Stopping", past: "Could not continue" },
};
function genericLog(chosen: string): StepLogEntry {
  const g = GENERIC_LOG[chosen];
  return logEntry(g?.ticker ?? `Doing ${chosen}`, g?.past ?? `Did ${chosen}`);
}

// A button that signs in through someone else ("continue with Google"), rather than submitting this form.
function isFederated(name: string): boolean {
  return /(continue|sign ?in|log ?in) with/i.test(name);
}

// The site a handoff form belongs to. A page with an unparseable URL still names something.
function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

// A failure that reads like the element went away between the snapshot and the action, rather than a
// real refusal by the page (navigation, dialog, disabled control).
function staleElementTimeout(message: string): boolean {
  return /timeout|not attached|element is not|no element|detached|destroyed|not visible|no node found/i.test(message);
}

// A control's own identity, stable across re-tagged snapshots where the numeric id is not.
function elementKey(e?: { role: string; name: string }): string | undefined {
  return e ? `${e.role}\u0000${e.name}` : undefined;
}

function quotedStrings(goal: string): string[] {
  const out: string[] = [];
  for (const m of goal.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) out.push(m[1].trim());
  return out;
}

// A final "done" answer that names something the run never actually saw (a PR/run/file number, a quoted
// title) is a prediction dressed as a fact, not proof. Pull out the answer's specific claims and check each
// one shows up somewhere in what the run actually did or read; anything that doesn't is unsupported.
function unsupportedClaims(answer: string, corpus: string): string[] {
  const lower = corpus.toLowerCase();
  const claims = new Set<string>();
  for (const q of quotedStrings(answer)) claims.add(q);
  for (const m of answer.matchAll(/#\d+|\b\d{2,}(?:\/\d+)?\b/g)) claims.add(m[0]);
  return [...claims].filter((c) => c.trim().length > 1 && !lower.includes(c.toLowerCase()));
}

export async function runTask(page: Page, input: RunInput, emit: (e: Event) => void, signal: AbortSignal) {
  const maxSteps = Math.min(Math.max(input.maxSteps ?? 60, 1), 60);
  const useSupervisor = input.supervisor !== false;
  // On a resume the task stays the one the run was started with; input.goal is only the reply that
  // answered the request which paused it.
  const goal = input.resume?.goal ?? input.goal;
  const history: string[] = [...(input.resume?.history ?? [])];
  const typedSoFar: string[] = [];
  const baseCandidates = Array.from(new Set([...(input.values ?? []), ...quotedStrings(goal), ...(input.resume ? quotedStrings(input.goal) : [])].map((s) => s.trim()).filter(Boolean)));
  let totalCost = 0;
  let step = input.resume?.step ?? 0;
  if (input.resume) history.push(`step ${step}: paused → resumed`);
  const actionCounts = new Map<string, number>();
  let consecutiveWaits = 0;
  // `goal` is the task even on a resume, where input.goal is only the reply that answered the request.
  const exploratory = isExploratoryTask(goal);
  const pagesSeen = new Set<string>(input.resume?.pagesSeen ?? []);
  let realActions = input.resume?.realActions ?? 0;
  let coverageWarning: string | undefined;
  let coverageRefusals = input.resume?.coverageRefusals ?? 0;
  let lastFingerprint = "";
  let lastUrl = "";
  let lastText = "";
  const seenPages = new Set(page.context().pages());
  // An action that threw (covered control, detached node, timeout) did not happen. Until something
  // confirms the change it was meant to make, no "done" may be reported from history text alone.
  // Carried over on resume: a pause must not make an unconfirmed failure disappear.
  let pendingFailure: { step: number; action: string; note: string; elementKey?: string; op?: string } | undefined = input.resume?.pendingFailure;
  let failureRecheckAsked = false;

  // Everything this turn is waiting on. One card is shown, but each entry is answered or declined.
  const pending: BlockingRequest[] = [];
  // Set just before a request pauses the turn: what a resumed call needs to pick this run back up
  // without losing the coverage floor or an unconfirmed failed step. Left unset on every other ending.
  let resumeState: PausedRun | undefined;

  const end = (status: EndEvent["status"], message: string, answer?: string, extra: Partial<EndEvent> = {}) =>
    emit({
      type: "end",
      status,
      message,
      answer,
      totalCostUsd: totalCost,
      steps: step,
      ...(pending.length ? { requests: [...pending], request: pickBlocking(pending) } : {}),
      ...(resumeState ? { resumeState } : {}),
      ...extra,
    });

  // Stopping is not dropping: every pending request gets an explicit decline so no card is left
  // alive in the panel waiting for an answer that is never coming.
  const stopped = () => {
    const declined = declineAll(pending, "stopped");
    pending.length = 0;
    return end("stopped", "stopped", undefined, declined.length ? { declined } : {});
  };

  // Raise one blocking request and hand the turn back. Asking the same thing after the user has
  // already refused it DENIAL_LIMIT times is worse than giving up once, so that ends the turn.
  const ask = (request: BlockingRequest) => {
    if (denialsExhausted(request, input.denials)) return end("blocked", denialCutoffMessage(request, input.denials));
    pending.push(request);
    resumeState = { goal, history: [...history], step, realActions, pagesSeen: [...pagesSeen], coverageRefusals, pendingFailure };
    return end("needs_input", String(request.question ?? request.action ?? "i need an answer to carry on."));
  };

  // On an open-ended "test the app" task, refuse a "done" that has barely touched the app. Returns the
  // reason to send back to the models, or undefined when the run may finish. The floor never outlives the
  // step budget: if there are not enough steps left to reach it, the run is allowed to report what it saw.
  const tooShallow = (): string | undefined => {
    if (!exploratory) return undefined;
    const missingActions = Math.max(EXPLORE_MIN_ACTIONS - realActions, 0);
    const missingPages = Math.max(EXPLORE_MIN_PAGES - pagesSeen.size, 0);
    const shortfall = Math.max(missingActions, missingPages);
    if (!shortfall || step + shortfall > maxSteps) return undefined;
    return `this task asks you to test the app, but so far this run took ${realActions} real action${realActions === 1 ? "" : "s"} across ${pagesSeen.size} page${pagesSeen.size === 1 ? "" : "s"}. that is not testing it. do not say done yet: keep going (at least ${EXPLORE_MIN_ACTIONS} actions across ${EXPLORE_MIN_PAGES} different pages) — visit another section, fill and submit a form, open settings, or try an invalid input, and report what you actually saw.`;
  };

  const shallowStopMessage = () =>
    `you asked me to test the app, but i only managed ${realActions} action${realActions === 1 ? "" : "s"} on ${pagesSeen.size} page${pagesSeen.size === 1 ? "" : "s"} and then kept concluding i was finished. i am not reporting that as tested. send a more specific task, or say "go on".`;

  try {
    if (input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await b.settle(page);
      history.push(`step 0: opened ${input.url} → now on "${await page.title().catch(() => "")}" (${page.url()})`);
    }
    emit({ type: "screenshot", screenshot: input.liveView ? "" : await b.screenshot(page), url: page.url(), title: await page.title() });

    while (step < maxSteps) {
      if (signal.aborted) return stopped();
      step++;

      // Follow popups / new tabs if the site opened one.
      const pages = page.context().pages();
      const newPages = pages.filter(p => !seenPages.has(p));
      pages.forEach(p => seenPages.add(p));
      if (newPages.length && newPages[newPages.length - 1] !== page) {
        page = newPages[newPages.length - 1];
        await b.settle(page);
      }

      // A transient chrome-error:// page (aborted or reset navigation) is not the site's answer. Give it a
      // moment, then reload the intended URL before asking anything.
      if (page.url().startsWith("chrome-error://")) {
        await page.waitForTimeout(1500);
        if (page.url().startsWith("chrome-error://")) await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await b.settle(page);
      }
      const snap = await b.snapshot(page);
      const tabs = await input.browserTabs?.list();
      const currentTabId = input.browserTabs?.currentId(page);
      // Tell the models whether the previous action changed anything.
      // Record what appeared, not just that something changed, so a final answer written many steps
      // later can still quote the run, item, or result that was actually observed.
      if (history.length && lastFingerprint) {
        history[history.length - 1] +=
          snap.fingerprint === lastFingerprint
            ? " → page did not change"
            : (snap.url !== lastUrl ? ` → now on "${snap.title}" (${snap.url})` : " → page changed") + newText(lastText, snap.text);
      }
      lastFingerprint = snap.fingerprint;
      lastUrl = snap.url;
      lastText = snap.text;
      pagesSeen.add(snap.fingerprint);
      if (!tooShallow()) coverageWarning = undefined;

      const scrollPos =
        snap.scroll.max === 0
          ? "whole page fits on screen"
          : snap.scroll.y >= snap.scroll.max - 4
            ? "at the bottom of the page: nothing more below, scrolling down does nothing"
            : snap.scroll.y <= 4
              ? "at the top of the page, more below"
              : `${Math.round((snap.scroll.y / snap.scroll.max) * 100)}% down the page, more below`;
      const elementLines = snap.elements.map((e) => b.describe(e) + (e.inViewport ? "" : e.pos === "above" ? " (above the viewport, scroll up)" : " (below the viewport, scroll down)"));

      // Warn both models before giving up: an action already repeated from this exact page state is
      // forbidden, and after several waits in a row the next step must inspect the page instead.
      const repeated = [...actionCounts.entries()]
        .filter(([sig, n]) => n >= REPEAT_WARN_AT && sig.startsWith(`${snap.fingerprint}|`))
        .map(([sig, n]) => `${sig.slice(snap.fingerprint.length + 1)} (done ${n} times from this exact page state without finishing the task; do not do it again, choose a different action or report what is missing)`);
      const waitCapped = consecutiveWaits >= WAIT_CAP;
      const warnings = [
        ...repeated,
        ...(coverageWarning ? [coverageWarning] : []),
        ...(waitCapped ? [`you have waited ${consecutiveWaits} times in a row. do not wait again now: read the page for the result of the pending operation and act on it (open the result, check the status, or continue the task). only wait again after a non-wait step.`] : []),
        ...(pendingFailure ? [`step ${pendingFailure.step} did not happen: ${pendingFailure.note} (${pendingFailure.action}). that change is unconfirmed, so do not report the task done from the history. re-check the exact field or control that action touched on the page now; retry it if it is reachable, and if the page still does not show the intended change, answer with status "blocked" and say what did not apply.`] : []),
      ];

      // ---- 1. supervisor thinks: one concrete action, or done/blocked
      let stepGoal = goal;
      let planText: string | undefined;
      let planWhy: string | undefined;
      let planCompletes = false;
      let planMs = 0;
      const candidates = [...baseCandidates];
      if (useSupervisor) {
        const p = await plan(
          {
            task: goal,
            earlierTasks: (input.previousTasks ?? []).slice(-6),
            history: compactHistory(history),
            lastResult: history.length ? history[history.length - 1].split(" → ").slice(1).join(" → ") || undefined : undefined,
            page: { url: snap.url, title: snap.title, scroll: scrollPos, text: snap.text, elements: elementLines },
            step,
            maxSteps,
            tabs,
            currentTabId,
            warnings: warnings.length ? warnings : undefined,
          },
          signal,
          input.model,
          input.reasoning,
        );
        totalCost += p.cost_usd;
        planMs = Math.round(p.ms);
        if (p.status === "done") {
          // A step that threw never applied its change. Force one re-check of the page before the
          // planner's success is believed, and refuse it if the re-check still shows nothing.
          if (pendingFailure) {
            if (failureRecheckAsked)
              return end("blocked", `i could not confirm this worked: step ${pendingFailure.step} failed (${pendingFailure.note}) and nothing on the page since then showed that change applied.`);
            failureRecheckAsked = true;
            history.push(`step ${step}: claimed the task was done, but step ${pendingFailure.step} failed (${pendingFailure.note}) and nothing confirmed that change; re-reading the page before reporting success`);
            continue;
          }
          // The guards that send the run back to work come before the ones that end it: a run told to keep
          // testing may still write a clean summary on a later pass.
          const shallow = tooShallow();
          if (shallow) {
            coverageWarning = shallow;
            if (++coverageRefusals >= EXPLORE_REFUSALS_BEFORE_STOP) return end("blocked", shallowStopMessage());
            history.push(`step ${step}: supervisor said done ("${p.answer ?? p.why ?? ""}") after only ${realActions} action(s) on ${pagesSeen.size} page(s); not accepted, the app still has to be tested`);
            emit({ type: "step", step, url: snap.url, title: snap.title, screenshot: "", elementCount: snap.elements.length, answers: {}, action: "held back: the app has barely been tested yet", log: logEntry("Checking coverage", "Held back: the app has barely been tested yet"), plan: p.why, jevMs: 0, planMs, execMs: 0, costUsd: p.cost_usd, note: shallow });
            continue;
          }
          if (p.answer) {
            // `goal` is the task even on a resume, where input.goal is only the reply; both count as read.
            const corpus = [goal, input.goal, ...(input.previousTasks ?? []), ...history, snap.text, snap.title].join("\n");
            const bad = unsupportedClaims(p.answer, corpus);
            if (bad.length)
              return end(
                "blocked",
                `the summary mentions ${bad.map((c) => `"${c}"`).join(", ")}, which never came up while working on this, so i'm not reporting it as done.`,
              );
          }
          return end("done", p.why ?? "Task complete", p.answer);
        }
        if (p.status === "blocked") {
          // A page that blocks the run says which of the four agreed reasons it was, so the panel
          // shows what happened instead of a generic stop.
          const reason = isBlockedReason(p.blocked_reason) ? p.blocked_reason : undefined;
          return end("blocked", blockedText(reason) ?? p.why ?? "Cannot continue", p.answer, reason ? { blockedReason: reason } : {});
        }
        // Ask the user something mid-run: a picker when the planner listed options, free text otherwise.
        if (p.status === "ask") return ask(askRequest({ question: p.question, options: p.options, why: p.why }));
        // Permission for the action itself, in three scopes. This is also where a high-risk action pauses:
        // the planner asks "approve" instead of tagging "continue" with a risk level, so the same three-scope
        // UI and explicit button click gates it — a stray "maybe" in a text reply can never be read as a yes.
        if (p.status === "approve") return ask(approvalRequest({ action: p.action ?? p.next, origin: p.origin, why: p.why }));
        // A login wall: hand the page back as a typed form. Field labels and input types travel;
        // what the user types never comes back through here, and nothing is read off the page.
        if (p.status === "credential") {
          const fields = snap.elements.filter((e) => e.kind === "type").slice(0, MAX_CREDENTIAL_FIELDS);
          // "Continue with Google" reads like a submit button to the regex below but hands the user
          // to another site. It is only ever offered as an alternative, never clicked with a password.
          const signInOptions = snap.elements.filter((e) => e.kind === "click" && isFederated(e.name)).map((e) => e.name);
          const submit = snap.elements.find((e) => e.kind === "click" && !isFederated(e.name) && /sign ?in|log ?in|continue|submit|next/i.test(e.name));
          return ask(
            credentialRequest({
              origin: originOf(snap.url),
              fields: fields.map((e) => ({ id: e.id, label: e.name, inputType: e.role, required: true })),
              signInOptions: p.sign_in_options ?? signInOptions,
              submit: submit && { id: submit.id, label: submit.name },
              // Reuse the run's own screenshot path; a live view streams the page already.
              screenshot: input.liveView ? "" : await b.screenshot(page),
              why: p.why,
            }),
          );
        }
        if (p.tabId !== undefined && input.browserTabs) {
          if (!tabs?.some(t => t.id === p.tabId)) return end("error", "the requested tab is no longer available");
          history.push(`step ${step}: read "${snap.title}" (${snap.url}): ${snap.text.slice(0, 4000)}; switching to tab ${p.tabId}${p.why ? `: ${p.why}` : ''}`);
          page = await input.browserTabs.select(p.tabId);
          seenPages.add(page);
          lastFingerprint = "";
          const switchedTitle = await page.title();
          emit({
            type: "step", step, url: page.url(), title: switchedTitle, screenshot: "", elementCount: 0, answers: {},
            action: `opened tab: ${switchedTitle}`,
            log: logEntry(`Opening tab: ${switchedTitle}`, `Opened tab: ${switchedTitle}`),
            plan: p.why, jevMs: 0, planMs, execMs: 0, costUsd: p.cost_usd,
          });
          continue;
        }
        if (!p.next) return end("error", "the planner gave no next action");
        stepGoal = p.next;
        planText = p.next;
        planWhy = p.why;
        planCompletes = p.completes_task === true;
        if (p.text) candidates.unshift(p.text);
      }

      // ---- 2. jev executes: ground the single action to elements (speculative fan-out, one request)
      const clickable = snap.elements.filter((e) => e.kind === "click" || e.kind === "type");
      const typeable = snap.elements.filter((e) => e.kind === "type");
      const selects = snap.elements.filter((e) => e.kind === "select" && e.options?.length);
      const opCriteria: Record<string, string> = {};
      for (const [k, v] of Object.entries(OPS)) {
        if (k === "CLICK" && !clickable.length) continue;
        if ((k === "TYPE_TEXT" || k === "TYPE_AND_ENTER") && !typeable.length) continue;
        if (k === "SELECT" && !selects.length) continue;
        if (k === "GO_BACK" && step === 1) continue;
        if (k === "SCROLL_DOWN" && snap.scroll.y >= snap.scroll.max - 4) continue; // already at the bottom
        if (k === "SCROLL_UP" && snap.scroll.y <= 4) continue;
        if (k === "WAIT" && waitCapped) continue; // check the page instead of waiting a fourth time
        if (useSupervisor && (k === "DONE" || k === "BLOCKED")) continue; // the supervisor owns termination
        if (!useSupervisor && k === "CANNOT") continue;
        opCriteria[k] = v;
      }
      const questions: Record<string, Question> = {
        operation: {
          type: "choice",
          instructions: useSupervisor
            ? "`goal` is one concrete instruction from a supervisor for this step. Which browser operation carries it out on the current `page`? Elements marked (above/below the viewport) need scrolling before they can be seen, but they can still be clicked directly."
            : "Given `goal` (read it together with `earlier_tasks_in_this_chat`: it may be a follow-up like \"go on\" or \"the last one\"), the current `page`, the interactive `elements`, and the `history` of actions already taken, which single browser operation is the best next step toward the goal? Elements marked (above/below the viewport) can still be clicked directly; `page.scroll_position` says how far down the page is. If `page` is an error, captcha, or bot-block page, or `history` shows the same actions not changing the page, choose BLOCKED. For a multi-part goal, choose the next unfinished part using the history. For most/least/highest/lowest, use sort controls or compare the relevant values before choosing an item; default order is not proof of rank. A file preview is not a raw file. Do not repeat navigation to a tab already open. Choose DONE only when every part of the goal is visibly achieved.",
          criteria: opCriteria,
        },
      };
      const otherTabs = tabs?.filter(t => t.id !== currentTabId) ?? [];
      if (!useSupervisor && otherTabs.length) {
        opCriteria.SWITCH_TAB = 'Switch to another existing browser tab to continue the task';
      }
      if (clickable.length)
        questions.click_target = {
          type: "choice",
          instructions: "If the operation is CLICK, use the current page and history to choose the element for the next unfinished part of `goal`. For a ranking request, choose the sort control before choosing an item unless the ranking is already established. Do not click the current navigation tab again.",
          criteria: Object.fromEntries(clickable.map((e) => [`el_${e.id}`, b.describe(e)])),
        };
      if (typeable.length)
        questions.type_target = {
          type: "choice",
          instructions: "If the operation is TYPE_TEXT or TYPE_AND_ENTER, which text field in `elements` should receive the text?",
          criteria: Object.fromEntries(typeable.map((e) => [`el_${e.id}`, b.describe(e)])),
        };
      if (typeable.length && candidates.length)
        questions.type_value = {
          type: "choice",
          instructions: "If text must be typed next, which of these texts (from `goal`, the supervisor, and `provided_values`) is the right one for the field? Choose write_new_text if none fits.",
          criteria: {
            ...Object.fromEntries(candidates.map((c, i) => [`text_${i}`, JSON.stringify(c)])),
            write_new_text: "None of the provided texts fit; a language model should write the text",
          },
        };
      const splitSelect = selects.reduce((n, e) => n + e.options!.length, 0) > 240;
      if (selects.length && splitSelect) {
        questions.select_target = { type: "choice", instructions: "If the operation is SELECT, which dropdown should be changed?", criteria: Object.fromEntries(selects.map(e => [`el_${e.id}`, b.describe(e)])) };
      } else if (selects.length) {
        const crit: Record<string, string> = {};
        for (const e of selects) e.options!.forEach((o, i) => (crit[`el_${e.id}_opt_${i}`] = `${b.describe(e)} → option "${o}"`));
        questions.select_target = { type: "choice", instructions: "If the operation is SELECT, which dropdown option should be selected?", criteria: crit };
      }

      const state = {
        goal: stepGoal,
        earlier_tasks_in_this_chat: (input.previousTasks ?? []).slice(-6),
        provided_values: candidates,
        step: `${step} of ${maxSteps}`,
        page: { url: snap.url, title: snap.title, scroll_position: scrollPos, text: snap.text },
        elements: elementLines,
        history: history.slice(-10),
        ...(warnings.length ? { warnings } : {}),
        ...(tabs ? { open_tabs: tabs, current_tab_id: currentTabId } : {}),
      };

      const res = await decide(state, questions, signal);
      totalCost += res.cost_usd;
      const op = res.answers.operation as ChoiceAnswer;
      const pick = (q: string) => (res.answers[q] as ChoiceAnswer | undefined)?.choice;
      const elId = (key?: string) => (key ? Number(key.match(/^el_(\d+)/)?.[1]) : NaN);

      let action = op.choice;
      let note: string | undefined;
      const t0 = performance.now();
      const chosen = op.choice;
      let jevMs = res.ms;
      let stepCost = res.cost_usd;
      let log = genericLog(chosen);
      // A page that re-renders while we think can drop the element between snapshot and action. The
      // element ids belong to that stale snapshot, so the retry re-tags the page and finds the same
      // control by role + name instead.
      let retry: { el: { role: string; name: string }; run: (id: number) => Promise<void> } | undefined;
      // Element ids are handed out per snapshot, so the same number can be a different control one step
      // later. What the failure is tracked by is the control's own identity: its role and name.
      let actionElementKey: string | undefined;
      let actionFailed = false;

      // ---- 3. execute
      try {
        switch (chosen) {
          case "SWITCH_TAB": {
            if (!input.browserTabs || !otherTabs.length) throw new Error('no other website tabs are available');
            let choices = otherTabs;
            while (choices.length > 240) {
              const size = Math.ceil(choices.length / 240);
              const groups = Array.from({ length: Math.ceil(choices.length / size) }, (_, i) => choices.slice(i * size, (i + 1) * size));
              const group = await decide(state, { tab_group: { type: 'choice', instructions: 'Which group contains the tab needed next for the task?', criteria: Object.fromEntries(groups.map((g, i) => [`group_${i}`, g.map(t => `${t.title} (${t.url})`).join('; ')])) } }, signal);
              totalCost += group.cost_usd; stepCost += group.cost_usd; jevMs += group.ms;
              const index = Number((group.answers.tab_group as ChoiceAnswer)?.choice?.match(/^group_(\d+)$/)?.[1]);
              if (!groups[index]) throw new Error('no matching tab group');
              choices = groups[index];
            }
            const target = await decide(state, { tab: { type: 'choice', instructions: 'Which existing tab should be read or controlled next for the task?', criteria: Object.fromEntries(choices.map(t => [`tab_${t.id}`, `${t.title} (${t.url})`])) } }, signal);
            totalCost += target.cost_usd; stepCost += target.cost_usd; jevMs += target.ms;
            const id = Number((target.answers.tab as ChoiceAnswer)?.choice?.match(/^tab_(\d+)$/)?.[1]);
            if (!choices.some(t => t.id === id)) throw new Error('no matching tab');
            history.push(`read "${snap.title}" (${snap.url}): ${snap.text.slice(0, 4000)}`);
            page = await input.browserTabs.select(id);
            seenPages.add(page);
            const switchedTitle = await page.title();
            action = `opened tab: ${switchedTitle}`;
            log = logEntry(`Opening tab: ${switchedTitle}`, `Opened tab: ${switchedTitle}`);
            lastFingerprint = '';
            break;
          }
          case "CLICK": {
            let id = elId(pick("click_target"));
            // The planner named a control in quotes. If exactly one clickable element carries that name and
            // jev picked something else (a skip, dismiss, or nearby control), use the named one.
            if (planText) {
              const wanted = quotedStrings(planText).map((q) => q.toLowerCase());
              const picked = clickable.find((x) => x.id === id);
              const pickedName = (picked?.name ?? "").toLowerCase();
              const exact = clickable.filter((x) => wanted.some((q) => x.name.toLowerCase() === q));
              // One element carries exactly the quoted name: it wins over a pick that only contains the name
              // ("Save as draft" for "Save") or does not carry it at all ("Skip" for "Continue").
              if (wanted.length && exact.length === 1 && exact[0].id !== id && !wanted.some((q) => pickedName === q)) {
                id = exact[0].id; note = `jev chose "${picked?.name ?? id}", corrected to the element the supervisor named`;
              }
            }
            const e = snap.elements.find((x) => x.id === id);
            const target = e ? b.describe(e) : `[${id}]`;
            action = `CLICK ${target}`;
            log = logEntry(`Clicking ${target}`, `Clicked ${target}`);
            actionElementKey = elementKey(e);
            if (e) retry = { el: e, run: (rid) => b.click(page, rid) };
            await b.click(page, id);
            break;
          }
          case "TYPE_TEXT":
          case "TYPE_AND_ENTER": {
            const id = elId(pick("type_target"));
            const e = snap.elements.find((x) => x.id === id);
            actionElementKey = elementKey(e);
            let text: string;
            const tv = pick("type_value");
            if (tv && tv !== "write_new_text") {
              text = candidates[Number(tv.replace("text_", ""))];
            } else if (candidates.length === 1) {
              text = candidates[0];
            } else {
              text = await writeText(
                `Task: ${goal}\nThis step: ${stepGoal}\nPage title: ${snap.title}\nURL: ${snap.url}\nField: ${e ? b.describe(e) : id}\nAlready typed this run: ${JSON.stringify(typedSoFar)}\nWhat exact text should be typed into this field?`,
                signal,
              );
              note = "text written by text model";
            }
            typedSoFar.push(text);
            const target = e ? b.describe(e) : `[${id}]`;
            action = `${chosen} ${JSON.stringify(text)} into ${target}`;
            log = logEntry(`Typing ${JSON.stringify(text)} into ${target}`, `Typed ${JSON.stringify(text)} into ${target}`);
            if (e) retry = { el: e, run: (rid) => b.typeText(page, rid, text, chosen === "TYPE_AND_ENTER", e?.contentEditable) };
            await b.typeText(page, id, text, chosen === "TYPE_AND_ENTER", e?.contentEditable);
            break;
          }
          case "SELECT": {
            const key = pick("select_target") ?? "";
            const m = key.match(/^el_(\d+)_opt_(\d+)$/);
            const id = splitSelect ? elId(key) : Number(m?.[1]);
            let idx = Number(m?.[2]);
            const e = selects.find((x) => x.id === id);
            if (splitSelect) {
              if (!e) throw new Error("No matching dropdown selected");
              const option = await decide(state, {
                select_option: { type: "choice", instructions: `Which option in ${b.describe(e)} carries out goal?`, criteria: Object.fromEntries(e.options!.map((o, i) => [`opt_${i}`, o])) },
              }, signal);
              totalCost += option.cost_usd;
              stepCost += option.cost_usd;
              jevMs += option.ms;
              res.answers.select_option = option.answers.select_option;
              idx = Number((option.answers.select_option as ChoiceAnswer)?.choice.match(/^opt_(\d+)$/)?.[1]);
            }
            if (!e || !Number.isInteger(idx) || idx < 0 || idx >= e.options!.length) throw new Error("No matching dropdown option selected");
            const target = e ? b.describe(e) : `[${id}]`;
            action = `SELECT "${e?.options?.[idx]}" in ${target}`;
            log = logEntry(`Selecting "${e?.options?.[idx]}" in ${target}`, `Selected "${e?.options?.[idx]}" in ${target}`);
            actionElementKey = elementKey(e);
            await b.selectOption(page, id, idx);
            break;
          }
          case "SCROLL_DOWN":
            await b.scroll(page, "down");
            break;
          case "SCROLL_UP":
            await b.scroll(page, "up");
            break;
          case "GO_BACK":
            await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
            break;
          case "WAIT":
            // Each consecutive wait is longer, so a slow operation gets real time instead of a burst of short polls.
            await page.waitForTimeout(Math.min(1500 * 2 ** consecutiveWaits, 12000));
            break;
          case "CANNOT":
            note = "jev found no way to do this on the page";
            break;
        }
      } catch (err) {
        const first = (err as Error).message.split("\n")[0];
        let recovered = false;
        // A page that re-renders every second can drop the element between snapshot and action, which
        // shows up as a locator timeout. Re-tag the page and try the same action once more against the
        // element that now carries the same role and name, instead of burning the step.
        if (retry && staleElementTimeout(first)) {
          try {
            const fresh = await b.snapshot(page);
            // Only an unambiguous match is safe to act on: two controls with the same role and name mean
            // the retry could hit the wrong one, so report the stale action and let the planner look again.
            const matches = fresh.elements.filter((x) => x.role === retry!.el.role && x.name === retry!.el.name);
            const match = matches.length === 1 ? matches[0] : undefined;
            if (match) {
              await retry.run(match.id);
              recovered = true;
              note = "element vanished before the action; re-tagged the page and retried by name";
            }
          } catch { /* the retry failed too: fall through and report the original failure */ }
        }
        // A recovered retry did carry out the action, so it is not an unconfirmed failure.
        if (!recovered) {
          note = `action failed: ${first.slice(0, 200)}`;
          actionFailed = true;
        }
      }
      if (actionFailed) {
        pendingFailure = { step, action, note: note!, elementKey: actionElementKey, op: chosen };
        failureRecheckAsked = false;
      } else if (pendingFailure && actionElementKey !== undefined && actionElementKey === pendingFailure.elementKey && chosen === pendingFailure.op) {
        // The same operation on the same control worked this time: the earlier failure is settled. Matching
        // on role and name, not on the snapshot's element id, which another control can inherit.
        pendingFailure = undefined;
        failureRecheckAsked = false;
      }
      signal.throwIfAborted();
      await b.settle(page);
      const execMs = performance.now() - t0;
      consecutiveWaits = chosen === "WAIT" ? consecutiveWaits + 1 : 0;
      if (REAL_ACTIONS.has(chosen) && !note?.startsWith("action failed")) { realActions++; coverageRefusals = 0; }

      history.push(`step ${step}: ${planText ? `supervisor said "${planText}"${planCompletes ? " (expected to complete the task)" : ""}; ` : ""}did ${action}${note ? ` (${note})` : ""}`);
      emit({
        type: "step",
        step,
        url: page.url(),
        title: await page.title().catch(() => ""),
        screenshot: input.liveView ? "" : await b.screenshot(page),
        elementCount: snap.elements.length,
        answers: res.answers,
        plan: planText,
        why: planWhy,
        action,
        log,
        jevMs: Math.round(jevMs),
        planMs,
        execMs: Math.round(execMs),
        costUsd: stepCost,
        note,
      });

      if (chosen === "DONE") {
        // Send the run back to work before refusing it outright: a shallow "test the app" run can still
        // earn its coverage, while an unconfirmed failed step has nothing left to prove.
        const shallow = tooShallow();
        if (shallow) {
          coverageWarning = shallow;
          if (++coverageRefusals >= EXPLORE_REFUSALS_BEFORE_STOP) return end("blocked", shallowStopMessage());
          history[history.length - 1] += " (not accepted: the app has barely been tested yet)";
          continue;
        }
        if (pendingFailure)
          return end("blocked", `i could not confirm this worked: step ${pendingFailure.step} failed (${pendingFailure.note}) and nothing on the page since then showed that change applied.`);
        return end("done", `done, now on "${(await page.title().catch(() => "")) || page.url()}"`);
      }
      // A changed page proves an action had an effect, not that the entire task succeeded.
      // Let the next planner pass inspect the destination before reporting completion.
      if (chosen === "BLOCKED") return end("blocked", "i could not find a way to do this on this page");

      // Repeating an action from the same state can also be a navigation cycle. The models were warned
      // once the repeat started; if they still repeat it, stop and name the action rather than blaming the site.
      const sig = `${snap.fingerprint}|${action}`;
      actionCounts.set(sig, (actionCounts.get(sig) ?? 0) + 1);
      if ((actionCounts.get(sig) ?? 0) >= REPEAT_STOP_AT) return end("blocked", useSupervisor
        ? `i kept repeating "${action}" without finishing your task, even after being told not to, so i stopped.`
        : `i kept repeating "${action}" without finishing your task. try careful mode to plan the steps.`);
    }
    return end("max_steps", `i stopped after ${maxSteps} steps without finishing. send a more specific task, or say "go on".`);
  } catch (err) {
    if (signal.aborted) return stopped();
    return end("error", (err as Error).message.slice(0, 500));
  }
}

export { plannerModel };
