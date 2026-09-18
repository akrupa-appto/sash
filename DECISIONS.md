# checkto reliability work

- Branch adam/unslop-copy, based on local main 1886b8c. No remote.
- Preserve fast (jev only) and careful (planner + jev). Do not silently switch modes.
- User reported GitHub most-starred/raw README task failing in fast mode.
- Original handoff requests fresh UI checks in both modes and commit pending agent.ts, planner.ts, public/index.html changes.
- Two deterministic agent.test.mjs regressions failed before changes and pass after: navigation is not completion proof; independent completion score must not override requested action.
- Correct loop message: repeated state/action is an agent loop, not evidence the site is broken.
- Live checkto.service has NOT been restarted. Use separate test server for new backend code. Ask before restarting the user service.
- Baseline QA launched through agy universal-qa, exec session 36611, PID 1463413. Await result; no output yet.
