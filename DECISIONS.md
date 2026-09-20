# checkto reliability work

## Core reliability verification (2026-09-20)

- Unattached headless Chromium suspended the idle extension service worker at 30.6s after startup. A DevTools/Playwright worker attachment kept it alive beyond 120s, so attached-worker labs are not valid suspension evidence. Do not add alarms or keepalive machinery from that result: no active run was observed dying, and the installed-extension fixture's real tasks completed normally.
- Chrome host match patterns do not accept ports. Per-origin prompts still name the exact origin, but the permission requested for a non-default-port site is necessarily scheme + hostname across ports (for example `http://127.0.0.1/*`).

## Priorities resumed (2026-09-20)

- Adam approved working through the priorities in sequence: approval/site-access settings, tick-track design, voice verification/settings, core reliability verification, then the cursor overlay. Changes start in `/tmp/checkto-priorities` on `adam/access-settings`, based on `origin/main` at `57cf90e`. No merge or live-service restart is authorized.
- Re-read source instead of trusting the handoff: `extension/settings.html` and `extension/options.js` already contain voice enable, provider, and mode controls. Verify those rather than building a duplicate surface. Approval and site-access settings remain absent at this checkpoint.
- Tick-track source screenshots must be resent before that design pass. Real microphone/provider and user-device behavior remain unverified; mocked browser APIs are not evidence of those paths.

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

## Panel redesign, voice, and approval scopes (2026-09-20)

Handoff. Four PRs are open and none are merged. Read this before touching any of them.

### The design is a file, not a description

Adam picked **design 4, palette 4** from a comp. The comp is the spec:

    git show origin/prototype/panel-directions:public/panel-prototype.html
    # serve it, open ?design=4&palette=4&state=1..6

Two implementation attempts failed the same way and both were rejected. Attempt one changed 2 lines of `panel.html` and 335 of `style.css`: a reskin. Attempt two converted more surfaces but still applied the comp's *tokens* onto checkto's *existing composition*. Adam: "it's not even fucking close."

The rule that came out of it: **do not implement this design from prose, including prose in this file.** Render the comp, render the build, put them side by side, list the differences, fix, repeat. Anyone working from a description will produce a third reskin.

Known deltas still being closed on `adam/panel-match-comp`: no framed panel or logo topbar; tick track rendered green when palette 4 specifies neutral ticks (green is reserved for the per-step done check); composer is checkto's old `@` pill plus three chrome rows the comp does not have (model/mode row, run-status strip, tab-context caption) instead of the comp's "Do anything" + `+` + model chip + circular send; tool-output block unlabelled and cramped; type and spacing smaller than the comp.

Open decision that the comp does not answer: mode, cost, run status and tab-context have no home in it. They are live functionality. They must not be dropped and must not remain as extra rows.

### Approval scopes were decorative (fixed, PR #36)

`state.grants` was written at `background.js:472` and read nowhere. `grep -c` returned 1. All three scopes permitted exactly one action, so "always allow" asked again next time. A control that misreports its own scope, where scope means authorising irreversible actions, is worse than not offering the choice.

It shipped past a cloud review, CodeRabbit, and 175 tests because every check verified the button rendered and resolved the request. None asserted the scope changed future behaviour. **Test the consequence, not the render.**

`grantKey` is deliberately not `denialKey`: the latter folds origin into the subject only when action text is absent, which is right for a refusal tally and wrong for authorising a repeat, since two identically-worded approvals on different origins would collide into one grant.

Settings UI should consume `grants:list` and `grants:revoke`.

### Voice (PR #37)

Three modes, all distinct: `dictate`, `prewarm` (default), `eager`. `eager` cannot be word-by-word here because true mid-sentence streaming needs OpenAI Realtime or Gemini Live, neither implemented. It is built on chunk partials and every surface says so. **Do not silently downgrade it to `prewarm`** — that repeats the approval-scopes lie.

A registered `chrome.commands` shortcut is intercepted before keydown reaches the page, so true hold-then-release is impossible for a global key. `M` is handled in the panel document; the global `Ctrl+Shift+Comma` toggles, with a fast second press latching hands-free.

Nothing mic-related is verified. This VM cannot load an unpacked extension (`--load-extension` is inert; driving "Load unpacked" through the GTK picker closes cleanly without registering). The permission prompt, `getUserMedia` from the offscreen document, and live audio reaching a provider all need a real machine.

### The cursor is a receiver with no sender (NOT built)

PR #22 shipped the drawing half only. `background.js` handles a `setCursor` message that **nothing sends**; every other write sets `cursor: undefined`. `content.js` contains no motion code at all — no transition, no rAF, no tween. `snapshot.js` exposes no x/y, only `above`/`below` for offscreen elements and `top`.

So building the Codex-style cursor needs three things that do not exist: coordinates out of the snapshot, a sender driving `setCursor` per action from the agent loop, and interpolated motion in the content script. Adam deferred this and stage-2 polish on 2026-09-20.

### Still open

- Settings surface for grants, per-origin access, voice, and the tab-group/badge/cursor toggles. Settings currently stores seven keys: four provider keys plus `mode`, `model`, `reasoning`.
- The four `verify` items in `todo.md`, which need real keys or a real browser.

### The tick track does not survive a real multi-step workflow (found 2026-09-20, not fixed)

Adam sent four real screenshots of the currently-installed extension running actual multi-step tasks (an X/Twitter archive workflow, ~20 actions; a search/bookmark/pagination workflow, ~40 actions). The tick track — the signature move of design 4, a row of small squares that fills in per step — was designed and only ever tested against the 2-4 step demo task used throughout this whole redesign effort ("upload the quarterly report..."). It does not degrade gracefully:

- At ~40 steps the dot row is one unbroken flex row with no wrap and no cap, so it overflows its container width. In the captured screenshots this pushes the sibling "Worked for 3m" duration text into a squeezed vertical single-character-per-line stack down the right edge of the panel — Adam's words, "it moves the whole dome around and breaks it."
- At ~20 steps (narrower panel) the row wraps onto a second line instead, which reads better but the dots are still individually meaningless at that count — nobody is going to count 20 identical green squares to know which step failed.
- Every real screenshot Adam sent was a genuine multi-step browser workflow: multiple tabs, retries, an explicit `action failed: Error: the control is covered or not visible` recovering mid-run. This is not an edge case; ordinary tasks on real sites regularly run 15-40+ actions. The demo task the whole design process was built and screenshotted against only ever had 2-3.

Not fixed. Adam explicitly said not to fix it now — capture it for later. Whoever picks this up needs a real design pass, not a patch: the tick track needs either a cap with an overflow affordance (a count past N, e.g. "12 more"), a different visual unit at high counts (a progress bar/percentage instead of discrete dots), or grouping (collapse consecutive same-kind actions). Screenshots referenced above are not preserved in the repo; ask Adam to resend if needed when this is picked up.
## Panel-match-comp (2026-09-20, branch adam/panel-match-comp, stacked on adam/panel-surfaces / PR #35)

- Two prior passes at matching `public/panel-prototype.html` design 4 / palette 4 failed the same way: they retokened checkto's *existing* composition instead of adopting the comp's own composition (topbar, composer, tick track). This pass method was comparison-driven: render the comp and the built extension side by side at the same states/width, diff visually, fix, re-render, repeat — not implement-from-a-checklist-and-declare-done.
- Full rationale, the exact per-delta fix, and what happened to the run-status/model/mode/tab-context functionality that used to live in three bolted-on composer rows is recorded in `DESIGN.md`'s Changelog (2026-09-20, panel-match-comp entry). Read that before touching `extension/panel.html`, `panel.js`, or `style.css`'s composer/topbar sections again.
- Short version: run status + cost now live in the trace header (`#steps-label`, shown from the instant a run starts, not only once a step lands); model + mode are one visual chip (`.model-cluster`); the tab-context caption is a screen-reader-only live region, not a visible row. The tick track (`.tick.is-done`) reads `--accent` (neutral), not `--status-success` (green) — that was a real bug from the first pass, now covered by a test.
- The pill-to-rounded-rect composer-field radius morph (a deliberate ChatGPT-style decision from an earlier session, `todo.md`) was removed to match the comp's `.composer-field` exactly, which is a fixed rounded rect in every state it renders. If a future session wants that morph back, it is a new decision against the approved comp, not a revert.
- Mic button (voice-stage-2, parallel branch): goes beside "+" in `.composer-left` as a second `.icon-btn`. Do not restructure the composer to add it; the row is already built for a second icon button there.
- Tests: 178, up from 177 on `adam/panel-surfaces`. `npm test` runs `node scripts/build-extension.mjs` first (via `pretest`); `panel.test.mjs` serves the built `dist/checkto-extension` over a local HTTP server, never `file://`.

## Cloud Agent environment (2026-09-20, branch cursor/setup-cloud-agent-environment-with-chrome-harness-dc5c)
- First `.cursor/environment.json` for the repo (repository-managed; committed config wins over any dashboard env). Default Cursor base image — it already ships Google Chrome 148 (`/usr/bin/google-chrome-stable`, used by the QA harness and computer use) and nvm. No custom Dockerfile.
- Node 24 is mandatory (the server and tests execute `.ts` directly via type stripping, which Node 22 does not do unflagged). The base image pins an infra `node` v22 early on PATH (`/exec-daemon/node`) that shadows nvm. `.cursor/install.sh` installs Node 24 via nvm, sets it default, prepends its bin to PATH for the install itself, and appends a guarded `# checkto-node24` block to `~/.bashrc` so interactive agent terminals also get Node 24 as bare `node` (the bashrc prepend beats the infra node). Do not remove that block or bare `node`/`npm test`/`npm start` fall back to v22 and fail on type stripping.
- `install`: `bash .cursor/install.sh` → Node 24, `npm ci`, `npx playwright install chromium` (panel/content/extension tests drive Playwright's own Chromium; Google Chrome is separate). Idempotent; runs twice cleanly.
- `start`: `bash .cursor/start.sh` (idempotent, returns after readiness). It launches `.cursor/qa-chrome.sh` in the background — headless Google Chrome with a CDP endpoint on `127.0.0.1:9223`, `--no-sandbox` (unprivileged container), `--headless=new` — and waits until the CDP endpoint answers. `scripts/verify-extension-browser.mjs` (now `npm run test:browser`) connects to that and drives `extension/browser.js` against a real tab: this is the "browser harness auto-connected to a Chrome instance" the environment provides. `start.sh` also starts the dev server (`npm start`) but only when `OPENROUTER_API_KEY` is set, since without a planner key the server is inert. (Started as `start` rather than `terminals` so the environment panel's Start field is populated; logs go to `/tmp/qa-chrome.log` and `/tmp/checkto-server.log`.)
- Secrets are requested (optional, not hard blockers — the extension and its full test suite + harness pass without them): `OPENROUTER_API_KEY` (planner/provider; also gates the dev server in `start.sh`) and `ANCHOR_API_KEY` (the server's remote-browser backend, required by `src/browser.ts` for live sessions). `/api/health` works with no secrets. OpenAI/Gemini keys are intentionally not requested (mocked-only per AGENTS.md).
- Fixed as part of enabling the harness: `scripts/verify-extension-browser.mjs`'s `chrome` mock was stale — `extension/browser.js` `attach()` now calls `chrome.tabs.get`/`chrome.windows.update`, which the mock did not stub. Added `tabs.get` and a `windows.update` stub. Harness passes: snapshot/redaction/type/select/click/navigation/back/abort.
- Pre-existing debt found, NOT fixed here (out of env-setup scope, app code): (1) `src/server.ts` computes its static root as `src/public` but `public/` is at the repo root, so any static route (`/`, `/app`, `/playground`, `/gallery`, `/img/*`) throws ENOENT and, being unhandled in the request handler, crashes the server process. Only `/api/*` (except `/app`) is safe without secrets. (2) `scripts/verify-extension-installed.mjs` (`npm run test:extension`) still drives the old panel via `#status-text`, removed in the panel redesign, so it fails against current `extension/panel.html`; it needs a rewrite to the new `#steps-label`/`#live-duration` status model.
- Verified live: `npm test` 213/213 pass, 0 skipped (Playwright browser tests run, not skipped); `npm run test:browser` passes against the standing Chrome; fresh login shell resolves `node` to v24 and strips `.ts` types.
## Release job needs Chromium (2026-09-20, branch adam/release-chromium)
- `release-extension.yml` runs `npm test` as its gate, and since PR #43 that suite includes `tests/extension-voice-browser.test.mjs`, which loads the built extension in a real Playwright Chromium. The job never installed a browser (unlike `ci.yml`, which has run `npx playwright install --with-deps chromium` since the panel test landed), so the release job failed on the merge of #43 — no version bump, no tag, no zip, and the version on `main` stayed at 0.4.12 even though #42 and #43 both merged.
- Fixed by adding the same install step to the release job. A future session could instead give every browser suite a shared skip guard, but the release job's gate should run the same tests CI runs; skipping coverage there to save 60 seconds is the wrong trade.
- Symptom to recognise a relapse: merges land but `extension/manifest.json` on `main` stops moving and the "release extension" run on that merge is red.
## The cursor's pre-click recheck binds an element, not an index (2026-09-20, branch adam/cursor-completion, based on PR #41)

- `extension/browser.js`'s pre-click recheck used to re-query `[data-jev-idx="<id>"]` after the cursor lead. A reviewer proved in real Chromium that the attribute is not an identity: `cloneNode(true)` copies it, and a control repurposed in place keeps it, so both got pressed. The recheck now has two ops in one serialized function, `cursorControl`: `bind` reads the coordinates and parks the element plus its tag/type/role/label in `globalThis.__checktoCursorSlots` (the 'checkto' isolated world) under a per-action token; `recheck` asserts that same element is still connected and still says the same thing before anything is dispatched. Type and select act on the bound element too instead of re-querying.
- This works because Chrome keys isolated worlds by name: `Page.createIsolatedWorld(worldName: 'checkto')` returns the *same* execution context for the frame's document on every call, so a global parked in one `evaluate()` is still there in the next. Verified, and a navigation replaces both the document and the world, so the slot is gone and the rejection is exactly the old one. Do not rename that world, do not move the coordinates read into a different world, and do not go back to an attribute lookup for the recheck.
- Everything is held page-side; nothing new enters the snapshot or the planner payload (`src/snapshot.js` keeps exposing only `rect`).
- `moveCursor()` no longer returns early when the tab is unobserved or the sink rejects: any awaited delivery — recorded and pushed to the content script either way — is a window the page can change in, so the recheck runs after all of them. `observed` now only decides whether the extra wait for the 280ms tween is spent.

## Action approvals the user controls (2026-09-20, branch adam/approval-engine)

- Adam asked to be able to decide whether he is asked at all, to be asked before every action rather than only the risky ones, and to have an allow-and-save path on the approval card. `settings.approvalMode` is now that one control: `every` (default — ask before each action), `risky` (the previous behaviour), `none` (never ask, store nothing).
- `every` and `none` are carried by an instruction `approvalInstruction(mode)` appends to the planner prompt, not by a keyword list of dangerous verbs: a verb denylist is brittle and endless to maintain (see `todo.md`). `none` additionally auto-answers approvals in `extension/background.js` and stores no grant.
- The widest scope button on the approval card reads "allow & save", the wording Adam asked for. `risky` is otherwise unchanged.
- The planner prompt changed, so AGENTS.md requires one real-planner lab run before this ships. That run landed before the PR was reviewed: see "The approval modes, checked against the real planner" below, and re-run `runs/live-approval-check.mjs <mode>` on any change to `approvalInstruction` or the planner prompt.

## The approval modes, checked against the real planner (2026-09-20, branch adam/approval-engine)

- Ran `runs/live-approval-check.mjs` on the shipped `src/planner.ts` with the real planner (`deepseek/deepseek-v4.1-flash` through OpenRouter, the same model the panel's own fast path uses), task "send a message on this contact form: email jane@example.com, message \"hello there\", then send it", page `https://forms.example.test/contact`. The script sends the real prompt and prints the reply; it never fabricates one.
- `every`: `status:"approve"`, action "Type jane@example.com into the Email field", origin `https://forms.example.test`, cost $0.0000354088. So the default mode really does stop before each action rather than only before the risky ones.
- `none`: `status:"continue"`, next "type \"jane@example.com\" into the Email textbox", cost $0.0000403312 — no approval is asked for, which is what "never ask" promises.
- `risky`: `status:"continue"` for the same step, cost $0.0000334712 — unchanged from the behaviour that shipped before this branch, as intended.
- The planner named a real origin here, and `src/agent.ts` still keys the saved grant on the page rather than on that reply, so a hallucinated origin cannot park an "always" click on a site the user never approved. An opaque page has no origin at all (`originOf` answers the literal `"null"` for every `about:blank`/`data:`/error page), so that case falls back to the page's own url, capped at 512 characters because a `data:` url is megabytes, and to the snapshot fingerprint when there is no url at all — an empty origin reaches the card as "every site", which is the one thing that fallback must never produce.
- A planner that answers `status:"ask"` under `none` is now refused with a message naming the setting instead of "the planner returned an invalid reply twice": asking a question is the mode working as asked, not a broken model. Unit coverage: `tests/approval-modes.test.mjs`, `tests/agent.test.mjs`.

## Current speech-to-text models (2026-09-20, branch adam/transcribe-model)

- Adam flagged the dictation models this extension offers as badly out of date and pointed at `https://openrouter.ai/models?output_modalities=transcription` as the source of truth. He was right: `whisper-1` was still the default on every provider, and OpenAI's deprecation notice (2026-08-26) retires `whisper-1`, `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` on 2027-02-26. The shipped defaults were already dead models.
- Defaults are now `openai/gpt-transcribe` on OpenRouter, `openai:gpt-transcribe` on an OpenAI key, `gemini:gemini-3.5-transcribe` on a Gemini key. A custom OpenAI-compatible server keeps `whisper-1`: it is the id such servers most often implement, and there is no shared "current" answer for a server we do not control. Do not move these back without a newer deprecation notice.
- Gemini speech runs through the Interactions API, which Google recommends (the `generateContent` transcription page is labelled legacy as of 2026-09): the clip is uploaded with the Files API and the interaction names its `uri`. A dedicated speech model (`gemini-3.5-transcribe`) takes `generation_config.transcription_config` and no instruction; a general multimodal model still gets the instruction in words. The transcript is read from `output_text`, falling back to the `outputs`/`steps` envelopes and word annotations. The upload is deleted right after, best-effort, so the user's audio does not sit in Google's 48-hour file store.
- The model the user picks in settings (`settings.transcriptionModel`) now reaches the offscreen recorder and the background worker (`voiceSpecFor`/`voiceSettingsFor`), and the key used is that model's provider's, not the planner model's. The picker and the audio path cannot disagree.
- Settings lists the live OpenRouter transcription catalog instead of a hardcoded list (upper layer, `adam/settings-approvals`); the static rows survive only as the offline first paint. That is the stock mechanism the repo rule asks for — no hardcoded model list in the UI.
- The Files-API session is opened on `https://generativelanguage.googleapis.com/upload/v1beta/files`: `/upload` goes before the version, not after the api host (probed live 2026-09-20 — `/v1beta/upload/files` answers 404, `/upload/v1beta/files` is the documented URI). Every failure path after the session opens now removes the clip: bytes that never land cancel the session, a finalize reply that cannot be parsed cancels it, and a reply that names the file without naming its uri deletes that file by name before throwing. Before that, those last two left the user's microphone audio in Google's file store for its full 48 hours with nothing pointing at it.
- `src/transcribe.ts` and `src/snapshot.js` joined the release workflow's `paths:` list. Without them, a merge whose only bundled change was speech-to-text (or the snapshot builder that `extension/browser.js` imports) bumped no version, tagged nothing and published no zip — the same silent-release failure #49 fixed for the missing Chromium install.
- OpenAI and Gemini request shapes are covered by mocked fetch only: neither key exists on this machine.
