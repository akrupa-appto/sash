# checkto reliability work

- Branch adam/unslop-copy, based on local main 1886b8c. No remote.
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
