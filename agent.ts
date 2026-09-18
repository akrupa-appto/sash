import type { Page } from "playwright";
import { decide, writeText, type ChoiceAnswer, type Question } from "./jev.ts";
import * as b from "./browser.ts";

export type RunInput = {
  url: string;
  goal: string;
  values?: string[]; // texts the user says may need typing
  maxSteps?: number;
};

export type StepEvent = {
  type: "step";
  step: number;
  url: string;
  title: string;
  screenshot: string; // base64 jpeg
  elementCount: number;
  answers: Record<string, unknown>;
  action: string;
  jevMs: number;
  execMs: number;
  costUsd: number;
  note?: string;
};

export type Event =
  | { type: "start"; via: string; url: string }
  | { type: "screenshot"; screenshot: string; url: string; title: string }
  | StepEvent
  | { type: "end"; status: "done" | "blocked" | "max_steps" | "error" | "stopped"; message: string; totalCostUsd: number; steps: number };

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
};

function quotedStrings(goal: string): string[] {
  const out: string[] = [];
  for (const m of goal.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) out.push(m[1].trim());
  return out;
}

export async function runTask(
  page: Page,
  input: RunInput,
  emit: (e: Event) => void,
  signal: AbortSignal,
) {
  const maxSteps = Math.min(Math.max(input.maxSteps ?? 20, 1), 60);
  const history: string[] = [];
  const typedSoFar: string[] = [];
  const candidates = Array.from(new Set([...(input.values ?? []), ...quotedStrings(input.goal)].map((s) => s.trim()).filter(Boolean)));
  let totalCost = 0;
  let step = 0;
  let sameActionStreak = 0;
  let lastAction = "";

  const end = (status: Extract<Event, { type: "end" }>["status"], message: string) =>
    emit({ type: "end", status, message, totalCostUsd: totalCost, steps: step });

  try {
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await b.settle(page);
    emit({ type: "screenshot", screenshot: await b.screenshot(page), url: page.url(), title: await page.title() });

    while (step < maxSteps) {
      if (signal.aborted) return end("stopped", "Stopped by user");
      step++;

      // Follow popups / new tabs if the site opened one.
      const pages = page.context().pages();
      if (pages.length > 1 && pages[pages.length - 1] !== page) {
        page = pages[pages.length - 1];
        await b.settle(page);
      }

      const snap = await b.snapshot(page);
      const clickable = snap.elements.filter((e) => e.kind === "click" || e.kind === "type");
      const typeable = snap.elements.filter((e) => e.kind === "type");
      const selects = snap.elements.filter((e) => e.kind === "select" && e.options?.length);

      // Build the question set. Every question is asked in the same request (speculative fan-out);
      // code only reads the ones relevant to the chosen operation.
      const opCriteria: Record<string, string> = {};
      for (const [k, v] of Object.entries(OPS)) {
        if (k === "CLICK" && !clickable.length) continue;
        if ((k === "TYPE_TEXT" || k === "TYPE_AND_ENTER") && !typeable.length) continue;
        if (k === "SELECT" && !selects.length) continue;
        if (k === "GO_BACK" && step === 1) continue;
        opCriteria[k] = v;
      }
      const questions: Record<string, Question> = {
        operation: {
          type: "choice",
          instructions:
            "Given `goal`, the current `page`, the interactive `elements`, and the `history` of actions already taken, which single browser operation is the best next step toward the goal? Do not repeat an action from `history` that did not change the page. Choose DONE only when `page` already shows the goal is fully achieved.",
          criteria: opCriteria,
        },
        goal_achieved: {
          type: "noul",
          instructions: "Does the current `page` (its title, text, and elements) show that `goal` has been fully achieved?",
        },
      };
      if (clickable.length)
        questions.click_target = {
          type: "choice",
          instructions: "If the next operation is CLICK, which element in `elements` should be clicked to make progress toward `goal`?",
          criteria: Object.fromEntries(clickable.map((e) => [`el_${e.id}`, b.describe(e)])),
        };
      if (typeable.length)
        questions.type_target = {
          type: "choice",
          instructions: "If the next operation is TYPE_TEXT or TYPE_AND_ENTER, which text field in `elements` should receive the text?",
          criteria: Object.fromEntries(typeable.map((e) => [`el_${e.id}`, b.describe(e)])),
        };
      if (typeable.length && candidates.length)
        questions.type_value = {
          type: "choice",
          instructions: "If text must be typed next, which of these texts (taken from `goal` and `provided_values`) is the right one for the field? Choose write_new_text if none fits.",
          criteria: {
            ...Object.fromEntries(candidates.map((c, i) => [`text_${i}`, JSON.stringify(c)])),
            write_new_text: "None of the provided texts fit; a language model should write the text",
          },
        };
      if (selects.length) {
        const crit: Record<string, string> = {};
        for (const e of selects) e.options!.forEach((o, i) => (crit[`el_${e.id}_opt_${i}`] = `${b.describe(e)} → option "${o}"`));
        questions.select_target = {
          type: "choice",
          instructions: "If the next operation is SELECT, which dropdown option should be selected?",
          criteria: crit,
        };
      }

      const state = {
        goal: input.goal,
        provided_values: candidates,
        step: `${step} of ${maxSteps}`,
        page: { url: snap.url, title: snap.title, text: snap.text },
        elements: snap.elements.map((e) => b.describe(e) + (e.inViewport ? "" : " (below the fold)")),
        history: history.slice(-10),
      };

      const res = await decide(state, questions, signal);
      totalCost += res.cost_usd;
      const op = res.answers.operation as ChoiceAnswer;
      const achieved = (res.answers.goal_achieved as { noul: number })?.noul ?? 0;
      const pick = (q: string) => (res.answers[q] as ChoiceAnswer | undefined)?.choice;
      const elId = (key?: string) => (key ? Number(key.match(/^el_(\d+)/)?.[1]) : NaN);

      let action = op.choice;
      let note: string | undefined;
      const t0 = performance.now();
      let chosen = op.choice;
      // If Jev is confident the goal is achieved, finish even if the op head disagrees.
      if (achieved >= 0.9 && chosen !== "DONE") {
        chosen = "DONE";
        note = `goal_achieved=${achieved.toFixed(2)} overrode operation=${op.choice}`;
      }

      try {
        switch (chosen) {
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
            } else {
              text = await writeText(
                `Goal: ${input.goal}\nPage title: ${snap.title}\nURL: ${snap.url}\nField: ${e ? b.describe(e) : id}\nAlready typed this run: ${JSON.stringify(typedSoFar)}\nWhat exact text should be typed into this field?`,
                signal,
              );
              note = "text written by text model";
            }
            typedSoFar.push(text);
            action = `${chosen} ${JSON.stringify(text)} into ${e ? b.describe(e) : `[${id}]`}`;
            await b.typeText(page, id, text, chosen === "TYPE_AND_ENTER");
            break;
          }
          case "SELECT": {
            const key = pick("select_target") ?? "";
            const m = key.match(/^el_(\d+)_opt_(\d+)$/);
            const id = Number(m?.[1]);
            const idx = Number(m?.[2]);
            const e = snap.elements.find((x) => x.id === id);
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
        }
      } catch (err) {
        note = `action failed: ${(err as Error).message.split("\n")[0].slice(0, 200)}`;
      }
      await b.settle(page);
      const execMs = performance.now() - t0;

      history.push(`step ${step}: ${action}${note ? ` (${note})` : ""}`);
      emit({
        type: "step",
        step,
        url: page.url(),
        title: await page.title().catch(() => ""),
        screenshot: await b.screenshot(page),
        elementCount: snap.elements.length,
        answers: res.answers,
        action,
        jevMs: Math.round(res.ms),
        execMs: Math.round(execMs),
        costUsd: res.cost_usd,
        note,
      });

      if (chosen === "DONE") return end("done", `Goal achieved (goal_achieved=${achieved.toFixed(2)})`);
      if (chosen === "BLOCKED") return end("blocked", "Jev reports the goal cannot be reached from here");

      sameActionStreak = action === lastAction ? sameActionStreak + 1 : 0;
      lastAction = action;
      if (sameActionStreak >= 3) return end("blocked", `Stuck repeating: ${action}`);
    }
    return end("max_steps", `Reached ${maxSteps} steps`);
  } catch (err) {
    if (signal.aborted) return end("stopped", "Stopped by user");
    return end("error", (err as Error).message.slice(0, 500));
  }
}
