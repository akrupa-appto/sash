# checkto reliability work

- Branch adam/unslop-copy, based on local main 1886b8c. Remote: https://github.com/akrupa-appto/checkto (private).
- Preserve fast (jev only) and careful (planner + jev). Do not silently switch modes.
- User reported GitHub most-starred/raw README task failing in fast mode.
- Original handoff requests fresh UI checks in both modes and commit pending agent.ts, planner.ts, public/index.html changes.
- Two deterministic agent.test.mjs regressions failed before changes and pass after: navigation is not completion proof; independent completion score must not override requested action.
- Correct loop message: repeated state/action is an agent loop, not evidence the site is broken.
- Live checkto.service has NOT been restarted. Use separate test server for new backend code. Ask before restarting the user service.
- Baseline QA launched through agy universal-qa, exec session 36611, PID 1463413. Await result; no output yet.

- Adam reaffirmed both modes on 2026-09-18. Priorities in order: ease of use for non-technical people, speed, accuracy. Never silently escalate fast to a planner.
- Add per-task careful-mode model selection: DeepSeek V4.1 Flash, GLM 5.3 Flash, Kimi K3, custom OpenRouter ID. Keep IDs scoped to each request; remember UI preference locally.
- agy QA failed before execution with RESOURCE_EXHAUSTED 429; stopped PID 1463413. Direct dedicated QA browser fallback is in use.
- Baseline GitHub fast task reached correct x-md raw README but skipped sorting and repeated a tab click. Modified careful run sorted by stars and reached raw README in 59.455s / $0.1802, with stale-control retries.
- Fixed delayed-fetch settling order (wait250ms before networkidle); regression failed before and passed after. Earlier recording checkto-fast-revised used OLD backend because test server had not exited; do not treat it as validation of latest code.

- Adam requested Anchor Browser as the backend. Replaced local Chromium launch with documented Anchor sessions + CDP, and embed Anchor live_view_url. No local fallback. Jev-only and assisted modes remain.
- Anchor agent-access trial key (1 credit) obtained through documented flow and stored only in gitignored .env as ANCHOR_API_KEY. Remote sessions capped at 60 minutes, idle3; explicit DELETE on close/failure/shutdown.
- Preview layout regression reproduced: 1000px viewport expanded document to1090px; 390px expanded to650px. Fixed grid minimum widths/wrapping, retained fixed live iframe.
- Exact preset model calls verified; GLM requires reasoning enabled (low), unlike DeepSeek and Kimi. UI HN task passed for all three on prior local backend (8.38s,11.13s,38.36s).
- Anchor fast UI HN task passed,9.29s,$0.0012 model cost,live browser rendered. Anchor careful GitHub task currently running.
- Main checkto.service still running OLD backend. Restart requires Adam approval under his global instructions. Test server8792 PID in runs/test-server.pid.

- Anchor careful GitHub task PASS: sorted by Stars, x-md raw README,47.15s,$0.0069 model cost.
- Anchor fast GitHub task PASS: sorted by Stars, x-md raw README,30.21s,$0.0026 model cost. No planner in request.
- Anchor custom GLM changelog task PASS: docs/changelog.md,51.38s,$0.0020 model cost. Custom selection survives reload.
- Width assertions passed at390,900,1000px with live iframe.13 deterministic tests pass including per-request routing, no local Chromium fallback, Anchor cleanup, canceled-task abort, click/navigation timing, completion guards.

- Adam approved production restart. checkto.service restarted successfully on 2026-09-18; /api/health reports browser=anchor. Fresh main-service UI checks passed: Jev-only HN comments9.61s, DeepSeek-assisted15.07s.13 regression tests passed again.
- Adam requested a GitHub repo under akrupa-appto. Created private akrupa-appto/checkto; initial upload targets main. Secrets and runs remain gitignored. External HTTPS could not be reached from this VM during final checks; service and browser checks used localhost8791.

- Reasoning selector added in isolated worktree /home/exedev/checkto-reasoning on adam/reasoning-level. Per-task effort, persisted preference, supported preset choices, explicit off never silently enabled.15 tests pass; exact provider calls DeepSeek high, GLM low, Kimi max pass. UI high HN task passed17.81s with preference reload and fast-mode/GLM controls verified. Main service unchanged pending merge/restart approval.

- 2026-09-18: PR #1 merged. Current reliability work branches from origin/main as adam/browser-reliability in the same isolated worktree. User requests passing benchmarks with lower latency and cost; no live service restart authorized for these changes.
- Baseline: eight lab runs reached correct saved state, but the 20-step UI budget reported max_steps for the 21-step full workflow. Both invoice audits failed during an eight-second navigation. Raw baseline evidence is in gitignored runs/long-bench.
- Regression tests reproduced click timeout and interrupted snapshot failures before changes. Clicks now retain Playwright's navigation waiting with a 30-second budget; only interrupted snapshot reads are retried, never side effects. The repaired fast audit passed all 12 invoices including the failed-save retry.
- Default budget is 60; explicit smaller limits and repeated-state loop detection remain. Remove the unused completion question and duplicated goal, use native fill without extra scroll/click/inspect, and compact planner JSON. Preserve both modes and all explicit model/reasoning choices. Final assisted comparisons use DeepSeek auto; prior baseline used high, so report that distinction.
- Staging benchmark workflows are available and direct create/recovery tests passed. Two browser-agent chats lacked browser tools despite configured Browser access. The adjacent appto-ai checkout contains extensive unrelated staged edits; inspect only, do not alter it as part of Checkto changes.

## Playground and recordings (2026-09-19)
- Branch adam/playground-recordings from origin/main. Live checkout is older; work runs separately on port8795 until explicitly deployed.
- Add self-contained playground scenarios and copy/use prompts, with local browser state and explicit pass checks.
- Anchor recording must be enabled on creation; resume on a disabled session falsely returns200. Pause immediately after creation, use native pause/resume. One video per chat; Anchor finalizes after browser closure.
- Persist only recording metadata in gitignored data/. Gallery scoped to random chat IDs remembered by this browser, not all account recordings.

## Local Chrome extension (2026-09-19)
- User wants Checkto inside their Chrome browser, with API-key setup on a separate page and local-only storage.
- Stack `adam/chrome-extension` on `adam/fix-session-and-agent-limits` (PR #4) using official `gh stack`; do not merge or deploy without a request.
- Manifest V3 side panel, native chrome.debugger transport, one selected tab/run at a time. Keys live only in chrome.storage.local with trusted-context access; provider requests go directly from the extension worker.
- Reuse the existing Jev/planner/agent loop and DOM reader through an extension browser adapter. No Anchor, server, or remote code required by the extension.
- Done: installable ZIP, settings save/clear/reload, tab click/type/select/navigation, cancellation/detach, repeatable tests, browser QA, reviewed PR.
- Extension checks: 43 Node tests pass; real QA Chrome protocol fixture passes text/number/date/rich text, select, click, scrolling, navigation/back, password redaction, and abort. Installed-extension tests pass both modes, local settings persistence/removal, popup following, and stop with deterministic provider replies.
- Native QA profile could not open the extension picker; the agy QA attempt was stopped. No service was restarted. Official Playwright disposable Chromium extension fixture provides installed-extension verification instead; the earlier restart permission question is no longer needed.
- New-tab regression: activate the selected tab before debugger attach, otherwise Chrome can report the active panel tab as the opener and the agent loses the destination.

## Extension correction (2026-09-19)
- Adam reports the extension UI is poor and real tasks do not work. Mocked provider checks are not evidence that real tasks succeed. Await concrete failure details; do not claim that failure fixed without them.
- Replace the single-tab dropdown with an @ mention menu covering all open tabs across windows. Let the agent switch among existing tabs, attaching on demand.
- Keep the side panel focused on conversation and a compact composer. Settings remain separate and local-only.
- Adam said no QA. Do not launch browser QA or run task probes for this revision. Build and code review only; disclose the verification limit.
- User supplied result.mp4 (AgentMail task waits, cannot scroll, then clicks sidebar) and image.png (planner returns no JSON after one successful click). Empty/invalid/truncated planner output now gets one retry with a larger output budget and native JSON mode, preserving model and reasoning choices.
- Extension snapshot and scroll now use the largest visible scrollable pane when the document does not scroll. The supplied recording cannot establish whether that alone resolves the AgentMail task; no claim of end-to-end success without a real run.
- v0.2.0 is this update. Build and syntax checks only per no-QA instruction. Existing verification scripts updated for the new composer but not executed.

## Onboarding run critique (2026-09-19)
- Adam's extension run ("go through the onboarding, make stuff up, test the app") looped waits twice, took the demo skip, mixed up two PRs, and claimed 8/8 without reading the result. Fixes are in agent.ts, planner.ts, browser.ts on t3code/fix-onboarding-test-verification-1.
- Repeated (page state, action) pairs are reported to the planner and jev as `warnings` at 2 and end the run at 4, naming the action. After 3 consecutive waits WAIT is withheld for one step and the planner must read the result. Waits back off 1.5s→12s.
- Jev may not swap a skip/dismiss control for the control the planner quoted; a unique exact-name match wins. Planner rules forbid demo/skip shortcuts, require observed results before done, and require the answer to name items as shown.
- Planner history keeps every step (older ones shortened) and each changed page adds a short "showing:" snippet of new text, so the final answer can quote what was actually read.
- Same-page link clicks (fragment hrefs, prevented navigation) no longer wait 30s for a URL change.
- Validation: gitignored runs/onboarding-lab fixture driven by the real planner (anthropic/claude-sonnet-5 via OpenRouter, local Chromium). Before: demo skip, 286s, answer claimed onboarding done. After: real onboarding with invented data, correct PR and 7/8 result quoted, 122s, $0.23. Known follow-up: elements re-rendered every second by a live page can go stale between snapshot and click (locator.evaluate timeout); the agent recovers on the next step.

## Model providers and picker (2026-09-19)
- Branch adam/model-providers stacked on t3code/fix-onboarding-test-verification-1 (PR #9 → PR #10). Official OpenAI and Gemini planner providers via "openai:"/"gemini:" model prefixes; TypeSafe remains the direct Jev connection. providers.ts owns chat, model listing, and per-family reasoning inference; planner.ts and writeText call it.
- Reasoning controls come from OpenRouter's per-model `reasoning` metadata (supported_efforts, default_effort, mandatory). OpenAI (reasoning_effort) and Gemini (thinkingLevel for 3.x, thinkingBudget for 2.5) have no such API, so listModels derives it from documented families and the chat path falls back once when a model rejects "off".
- Picker modal public/model-picker.js is shared by the web app (served at /model-picker.js, fed by /api/providers and /api/models) and the extension settings page (fetching lists directly with the typed keys). Server preset validation was replaced by "provider connected" validation; model-specific levels are the picker's and the provider's job.
- No OpenAI or Gemini keys on this machine: those paths have mocked-fetch tests only. Live OpenRouter list and the onboarding lab passed through the refactored path. Test server for this branch on port 8798 (runs/test-server-8798.pid); main checkto.service untouched.
- coderabbit has never commented on this repo (PRs 5, 7, 8, 9 show no bot activity), so codex review is the reviewer for #9 and #10.

## Handoff (2026-09-19, end of the provider/CI/panel session)
State of the repo when this session ended. Read this first; the rest of this file is history.

- main is `2dc5675 chore: extension v0.4.2`; release `extension-v0.4.2` is published with `checkto-extension.zip` attached. Everything opened this session is merged: #9 onboarding fixes, #13 CI, #14 providers + picker (replaces the auto-closed #10), #11 control-ended message, #12 custom provider, #15/#16 release pipeline fixes, #17 answer-under-steps.
- Release pipeline is proven on both paths: manual dispatch (v0.4.1) and the automatic main-push trigger (v0.4.2). It bumps the patch in extension/manifest.json, loops until the tag is free, pushes an annotated tag and main atomically. Workflow-file-only changes do not trigger it (paths filter); dispatch by hand with `gh workflow run "release extension" --ref main -f part=patch`.
- Tests: 68 pass with `npm test`. panel.test.mjs drives the built side panel in real Chromium; CI installs chromium for it and the test skips itself where no browser is installed.
- Reviewer: the CodeRabbit GitHub app is not installed on this repo. Use the CLI from a detached worktree: `git worktree add --detach /tmp/checkto-prN <branch>` then `coderabbit review --committed --base main --agent`. Never run two at once; it rate-limits. `gh` must be on the `akrupa-appto` account for this repo (`gh auth switch --user akrupa-appto`); the pc-style account gets "repository not found".
- Zip for Adam is also served from runs/share on https://pcstyle.exe.xyz:8799/ (python http.server, pid in runs/share-8799.pid). Refresh it with `gh release download extension-vX.Y.Z --pattern checkto-extension.zip --dir runs/share --clobber`.

Open, in the order Adam raised them (todo.md has the detail):
1. Compare/summarize answers come out as one enormous sentence because planner.ts:34 asks for "one sentence". Allow a few short newline-separated lines for compare/summarize; the panel already renders pre-wrap. Not started.
2. `.compose-box` is `border-radius:999px`, so a multi-line message becomes a capsule blob. Change to `22px` (pill at one line, rounded rectangle when taller) and drop the `:has(.selected-tabs)` 20px override. Not started. Adam wanted 1 and 2 as one small PR.
3. Settings page never got the redesign: `cadb09e` scoped the plum tokens to `.panel-page`, so settings.html still renders the old cream `:root` theme with system fonts. Move the tokens to `:root` (or a shared body class), add Outfit to headings, hand-tune `.privacy` (#edf0e9) and `--acc`. Not started; Adam noticed but did not ask for it yet.
4. todo.md items: outcome word on blocked/errored replies, questions/approval pauses, chrome tab groups, stale-element retry, reasoning metadata for custom OpenRouter ids.
5. Verification debt: OpenAI, Gemini, and custom-server planner paths have never been called with a real key on this machine; mocked-fetch tests only. The Google sign-in detach reason has not been confirmed against Chrome.

Rules learned this session that are not yet in AGENTS.md: retarget stacked PRs to main before merging their parent (GitHub closes a PR whose base branch is deleted and will not reopen it); `git push --follow-tags` skips lightweight tags.

## Blocking requests (2026-09-19, branch todo/feat-request-queue)

- Every way a turn can stop and wait for the human lives in `extension/requests.js`, keyed by `types.js` `RequestType`. Do not add a second, parallel pause mechanism next to it.
- One turn hands back exactly one request. `pickBlocking` walks `RequestType` in its declared key order and takes the most recent of the highest-priority kind; the panel renders whatever it returns. Reordering those keys reorders the product.
- Stopping declines; it never drops. `declineAll` writes an outcome for every pending request, in the agent on abort and in the worker on a stop, a cleared chat, or a restarted worker (`expired`). Only a real refusal (`declined`, `stopped`) counts towards the denial tally.
- After `DENIAL_LIMIT` (3) refusals of the same `denialKey`, the turn ends with the cutoff message instead of asking again. The count lives in the worker's run state and is cleared when that request is finally answered.
- The credential handoff describes a form; it never carries a value. Fields are rebuilt through `credentialField`, which drops whatever the page held, so the snapshot's own values cannot travel to a model or into the run state. What the user types in the panel goes straight to `submitCredentials` and nowhere else: not persisted, not logged, not passed to the agent, which verifies from the page afterwards.
- Only whole-internet approval (`origin` absent or `*`) gets the second confirm dialog. A single-origin "always" is granted on one click on purpose.
- `panel.js` keeps one additive `renderRequest` block; `render()` was not restructured. Panel changes stay that shape.
- Still owed, per AGENTS.md: this changed the planner prompt (new `blocked_reason`, `ask`, `approve`, `credential` statuses) and has only been run against mocked planners. One real lab run before this is trusted in production.

## pr4-agent-fixes done-guards (2026-09-19, folded into the request queue below)

- The three "done" guards run in a fixed order and the order is the decision, not an accident. Guards that hand the run back to work come first (the failed-step re-check, then the "test the app" coverage floor, both of which `continue`), and only then the guard that ends the run (unsupported claims in the answer). A shallow or unconfirmed run gets a chance to earn its success; a fabricated claim never does. Same order on the planner's `done` and on jev's own `DONE`.
- A retag-retry that recovers a vanished element is not a failed step. The retry runs first in the catch block and only a still-failing action sets `pendingFailure`, otherwise every re-rendering page would end runs as unconfirmed.
- The exploratory-task check and the claim corpus both read the run's `goal`, not `input.goal`; on a resume `input.goal` is only the user's reply to what paused it.

## Unifying the two pause mechanisms (2026-09-19)

- PR #23 (`pr4-agent-fixes`, merged first) independently built a second pause mechanism: a planner `status:"question"` plus a `risk:"high"` field on `continue`, with its own `PausedRun`/resume plumbing and an `outcomeWord()` prefix ("done: …", "could not finish: …", "needs you: …") on every terminal message. PR #24's own decision above forbids a second, parallel pause mechanism, so this merge folds #23's cases into the request queue instead of keeping both:
  - `status:"question"` is gone; the planner asks with `status:"ask"` (already in this branch), which becomes a `user_input`/`option_picker` request.
  - `risk:"high"` is gone; the planner asks with `status:"approve"` (already in this branch), which becomes a three-scope `approval` request with a real button click, not a free-text "yes"/AFFIRM regex. That is a strictly stronger explicit-consent gate than #23's regex ever was ("maybe" cannot be misread as approval because there is no text reply to misread — the panel only sends `SUBMITTED` on a button click).
  - `outcomeWord()` is deleted. The panel already renders `state.status` into its own status word (`extension/panel.js` `#status-text`), so prefixing the message text duplicated that and read stiffly ("could not finish: i could not confirm this worked…"). `end()` now emits the raw message everywhere, matching what this branch already did; the two `agent.test.mjs` assertions on `/^done: /` / `/^could not finish: /` were rewritten to check the raw text.
  - What #23 had and this branch did not, preserved: the exploratory-task coverage floor (`realActions`/`pagesSeen`/`coverageRefusals`), the unconfirmed-failed-step guard (`pendingFailure`), and the stale-element retag retry. These are independent of *why* a turn pauses, so they now live on a small `PausedRun`-shaped `resume` field carried on the `needs_input` `EndEvent` (`resumeState`) and threaded back into `RunInput.resume` by `extension/background.js` on every kind of answer (ask, approve, credential) — not only #23's original question/risk pauses. A pause for a credential handoff or an approval no longer loses track of an unconfirmed failed step from earlier in the same run.
  - `panel.test.mjs`'s stale "the live action list only shows while the run is in flight" test (asserting the old "2 actions" step-count label) is deleted; #24's own log-ticker replacement test a few lines later already supersedes it.

## Panel-match-comp (2026-09-20, branch adam/panel-match-comp, stacked on adam/panel-surfaces / PR #35)

- Two prior passes at matching `public/panel-prototype.html` design 4 / palette 4 failed the same way: they retokened checkto's *existing* composition instead of adopting the comp's own composition (topbar, composer, tick track). This pass method was comparison-driven: render the comp and the built extension side by side at the same states/width, diff visually, fix, re-render, repeat — not implement-from-a-checklist-and-declare-done.
- Full rationale, the exact per-delta fix, and what happened to the run-status/model/mode/tab-context functionality that used to live in three bolted-on composer rows is recorded in `DESIGN.md`'s Changelog (2026-09-20, panel-match-comp entry). Read that before touching `extension/panel.html`, `panel.js`, or `style.css`'s composer/topbar sections again.
- Short version: run status + cost now live in the trace header (`#steps-label`, shown from the instant a run starts, not only once a step lands); model + mode are one visual chip (`.model-cluster`); the tab-context caption is a screen-reader-only live region, not a visible row. The tick track (`.tick.is-done`) reads `--accent` (neutral), not `--status-success` (green) — that was a real bug from the first pass, now covered by a test.
- The pill-to-rounded-rect composer-field radius morph (a deliberate ChatGPT-style decision from an earlier session, `todo.md`) was removed to match the comp's `.composer-field` exactly, which is a fixed rounded rect in every state it renders. If a future session wants that morph back, it is a new decision against the approved comp, not a revert.
- Mic button (voice-stage-2, parallel branch): goes beside "+" in `.composer-left` as a second `.icon-btn`. Do not restructure the composer to add it; the row is already built for a second icon button there.
- Tests: 178, up from 177 on `adam/panel-surfaces`. `npm test` runs `node scripts/build-extension.mjs` first (via `pretest`); `panel.test.mjs` serves the built `dist/checkto-extension` over a local HTTP server, never `file://`.
