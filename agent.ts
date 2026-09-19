import type { Page } from "playwright";
import { decide, writeText, type ChoiceAnswer, type Question } from "./jev.ts";
import { plan, plannerModel, type ReasoningLevel } from "./planner.ts";
import * as b from "./browser.ts";

export type RunInput = {
  url?: string; // omit to continue on the page the browser is already on
  goal: string;
  values?: string[]; // texts the user says may need typing
  maxSteps?: number;
  previousTasks?: string[]; // earlier messages in this chat, oldest first, so "go on" has context
  supervisor?: boolean; // default true: a chat LLM thinks (one action at a time), Jev executes (grounds it to an element)
  reasoning?: ReasoningLevel;
  model?: string; // planner model for this task; fast mode still uses Jev
  liveView?: boolean; // Anchor streams the browser directly; skip screenshot work
  browserTabs?: {
    list: () => Promise<{ id: number; title: string; url: string }[]>;
    select: (id: number) => Promise<Page>;
    currentId: () => number;
  };
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
  jevMs: number;
  planMs: number;
  execMs: number;
  costUsd: number;
  note?: string;
};

export type EndEvent = {
  type: "end";
  status: "done" | "blocked" | "max_steps" | "error" | "stopped";
  message: string;
  answer?: string; // supervisor's one-line reply for the user
  totalCostUsd: number;
  steps: number;
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

function quotedStrings(goal: string): string[] {
  const out: string[] = [];
  for (const m of goal.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) out.push(m[1].trim());
  return out;
}

export async function runTask(page: Page, input: RunInput, emit: (e: Event) => void, signal: AbortSignal) {
  const maxSteps = Math.min(Math.max(input.maxSteps ?? 60, 1), 60);
  const useSupervisor = input.supervisor !== false;
  const history: string[] = [];
  const typedSoFar: string[] = [];
  const baseCandidates = Array.from(new Set([...(input.values ?? []), ...quotedStrings(input.goal)].map((s) => s.trim()).filter(Boolean)));
  let totalCost = 0;
  let step = 0;
  const actionCounts = new Map<string, number>();
  let lastFingerprint = "";
  let lastUrl = "";
  const seenPages = new Set(page.context().pages());

  const end = (status: EndEvent["status"], message: string, answer?: string) =>
    emit({ type: "end", status, message, answer, totalCostUsd: totalCost, steps: step });

  try {
    if (input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await b.settle(page);
      history.push(`step 0: opened ${input.url} → now on "${await page.title().catch(() => "")}" (${page.url()})`);
    }
    emit({ type: "screenshot", screenshot: input.liveView ? "" : await b.screenshot(page), url: page.url(), title: await page.title() });

    while (step < maxSteps) {
      if (signal.aborted) return end("stopped", "stopped");
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
      const currentTabId = input.browserTabs?.currentId();
      // Tell the models whether the previous action changed anything.
      if (history.length && lastFingerprint) {
        history[history.length - 1] +=
          snap.fingerprint === lastFingerprint
            ? " → page did not change"
            : snap.url !== lastUrl
              ? ` → now on "${snap.title}" (${snap.url})`
              : " → page changed";
      }
      lastFingerprint = snap.fingerprint;
      lastUrl = snap.url;

      const scrollPos =
        snap.scroll.max === 0
          ? "whole page fits on screen"
          : snap.scroll.y >= snap.scroll.max - 4
            ? "at the bottom of the page: nothing more below, scrolling down does nothing"
            : snap.scroll.y <= 4
              ? "at the top of the page, more below"
              : `${Math.round((snap.scroll.y / snap.scroll.max) * 100)}% down the page, more below`;
      const elementLines = snap.elements.map((e) => b.describe(e) + (e.inViewport ? "" : e.pos === "above" ? " (above the viewport, scroll up)" : " (below the viewport, scroll down)"));

      // ---- 1. supervisor thinks: one concrete action, or done/blocked
      let stepGoal = input.goal;
      let planText: string | undefined;
      let planWhy: string | undefined;
      let planCompletes = false;
      let planMs = 0;
      const candidates = [...baseCandidates];
      if (useSupervisor) {
        const p = await plan(
          {
            task: input.goal,
            earlierTasks: (input.previousTasks ?? []).slice(-6),
            history: history.slice(-12),
            lastResult: history.length ? history[history.length - 1].split(" → ").slice(1).join(" → ") || undefined : undefined,
            page: { url: snap.url, title: snap.title, scroll: scrollPos, text: snap.text, elements: elementLines },
            step,
            maxSteps,
            tabs,
            currentTabId,
          },
          signal,
          input.model,
          input.reasoning,
        );
        totalCost += p.cost_usd;
        planMs = Math.round(p.ms);
        if (p.status === "done") return end("done", p.why ?? "Task complete", p.answer);
        if (p.status === "blocked") return end("blocked", p.why ?? "Cannot continue", p.answer);
        if (p.tabId !== undefined && input.browserTabs) {
          if (!tabs?.some(t => t.id === p.tabId)) return end("error", "the requested tab is no longer available");
          history.push(`step ${step}: read "${snap.title}" (${snap.url}): ${snap.text.slice(0, 4000)}; switching to tab ${p.tabId}${p.why ? `: ${p.why}` : ''}`);
          page = await input.browserTabs.select(p.tabId);
          seenPages.add(page);
          lastFingerprint = "";
          emit({ type: "step", step, url: page.url(), title: await page.title(), screenshot: "", elementCount: 0, answers: {}, action: `opened tab: ${await page.title()}`, plan: p.why, jevMs: 0, planMs, execMs: 0, costUsd: p.cost_usd });
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
            action = `opened tab: ${await page.title()}`;
            lastFingerprint = '';
            break;
          }
          case "CLICK": {
            const id = elId(pick("click_target"));
            const e = snap.elements.find((x) => x.id === id);
            action = `CLICK ${e ? b.describe(e) : `[${id}]`}`;
            await b.click(page, id);
            break;
          }
          case "TYPE_TEXT":
          case "TYPE_AND_ENTER": {
            const id = elId(pick("type_target"));
            const e = snap.elements.find((x) => x.id === id);
            let text: string;
            const tv = pick("type_value");
            if (tv && tv !== "write_new_text") {
              text = candidates[Number(tv.replace("text_", ""))];
            } else if (candidates.length === 1) {
              text = candidates[0];
            } else {
              text = await writeText(
                `Task: ${input.goal}\nThis step: ${stepGoal}\nPage title: ${snap.title}\nURL: ${snap.url}\nField: ${e ? b.describe(e) : id}\nAlready typed this run: ${JSON.stringify(typedSoFar)}\nWhat exact text should be typed into this field?`,
                signal,
              );
              note = "text written by text model";
            }
            typedSoFar.push(text);
            action = `${chosen} ${JSON.stringify(text)} into ${e ? b.describe(e) : `[${id}]`}`;
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
            action = `SELECT "${e?.options?.[idx]}" in ${e ? b.describe(e) : `[${id}]`}`;
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
            await page.waitForTimeout(1500);
            break;
          case "CANNOT":
            note = "jev found no way to do this on the page";
            break;
        }
      } catch (err) {
        note = `action failed: ${(err as Error).message.split("\n")[0].slice(0, 200)}`;
      }
      signal.throwIfAborted();
      await b.settle(page);
      const execMs = performance.now() - t0;

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
        jevMs: Math.round(jevMs),
        planMs,
        execMs: Math.round(execMs),
        costUsd: stepCost,
        note,
      });

      if (chosen === "DONE") return end("done", `done, now on "${(await page.title().catch(() => "")) || page.url()}"`);
      // A changed page proves an action had an effect, not that the entire task succeeded.
      // Let the next planner pass inspect the destination before reporting completion.
      if (chosen === "BLOCKED") return end("blocked", "i could not find a way to do this on this page");

      // Repeating an action from the same state can also be a navigation cycle.
      // Stop the loop without claiming the website is unresponsive.
      const sig = `${snap.fingerprint}|${action}`;
      actionCounts.set(sig, (actionCounts.get(sig) ?? 0) + 1);
      if ((actionCounts.get(sig) ?? 0) >= 3) return end("blocked", useSupervisor
        ? "i kept repeating the same action without finishing your task, so i stopped."
        : "i kept repeating the same action without finishing your task. try careful mode to plan the steps.");
    }
    return end("max_steps", `i stopped after ${maxSteps} steps without finishing. send a more specific task, or say "go on".`);
  } catch (err) {
    if (signal.aborted) return end("stopped", "stopped");
    return end("error", (err as Error).message.slice(0, 500));
  }
}

export { plannerModel };
