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
