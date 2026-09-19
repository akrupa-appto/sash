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
