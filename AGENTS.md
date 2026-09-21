# sash: agent instructions

Precedence: the user's message wins, then this file, then any global defaults.

The product is sash. The GitHub repository is still `akrupa-appto/checkto` until it is renamed on GitHub.

## Start here

- Read `DECISIONS.md` before working. Append a dated entry when you decide something that a later session must not undo.
- Repo owner is the `akrupa-appto` GitHub account. Run `gh auth switch --user akrupa-appto` before any push or `gh` write; the `pc-style` account cannot see this repo.
- Dependent work goes on a stack (`gh stack add <branch>`), each layer a real PR on the layer below.

## Stack and layout

- Node 24 runs `.ts` files directly with type stripping. No `tsc`, no build for the server. Type-only syntax only: no parameter properties, no enums, no `any`.
- `npm ci` before anything else in a fresh worktree. `npm test` builds the extension first (esbuild) and runs every `tests/*.test.mjs` and `tests/*.test.ts` with `--experimental-test-module-mocks`.
- `src/agent.ts` is the loop, `src/planner.ts` the supervisor prompt, `src/jev.ts` the executor client, `src/providers.ts` the chat and model-list clients (OpenRouter default, `openai:` and `gemini:` prefixes for the official APIs), `src/browser.ts` the Playwright and Anchor adapter. The extension in `extension/` bundles the same agent, planner, and providers with `extension/browser.js` and `extension/config.js` swapped in for `src/browser.ts` and `src/env.ts`.
- `public/` is served as-is. `public/model-picker.js` is shared with the extension settings page; keep it dependency-free browser ESM.
- `tests/` holds every test (`*.test.mjs` and `*.test.ts`) plus `tests/fixtures/`. There is no separate `test/` directory or root-level test files; a new test always goes in `tests/`.
- `runs/` and `data/` are gitignored. Put lab scripts, screenshots, logs, and test-server pids there.

## Verification

- Unit tests are necessary, not sufficient. A change to the planner prompt, the agent loop, or a provider request must also be run against the real planner at least once. `runs/onboarding-lab/lab.mjs` (local Chromium plus the real OpenRouter planner, about $0.25 and two minutes) is the reference lab for the onboarding critique; reuse it or build a fixture the same way.
- Mocked provider replies are not evidence that a real task succeeds. Say plainly which paths ran live and which did not. OpenAI and Gemini keys are not on this machine; those providers are mocked-fetch only until someone runs them.
- Never run `npm test` unbounded in the foreground if it stalls; run files one at a time with `timeout 90 node --experimental-test-module-mocks --test <file>` to find the hang. Server tests need `OPENROUTER_API_KEY` set to any value.
- The live service is `checkto.service` on port 8791 and runs the main checkout. Do not restart it without an explicit request. Test a branch on a free port: `PORT=879x node --env-file=/home/exedev/checkto/.env src/server.ts`, save the pid under `runs/`, and kill that exact pid when done.
- Anchor Browser sessions cost credits and need `ANCHOR_API_KEY`. For labs and screenshots use local Playwright Chromium (`~/.cache/ms-playwright`) instead.
- Extension changes: `npm test` covers the bundle and the manifest; the manifest test asserts the exact `host_permissions` list, so update it when adding a provider host. `npm run test:extension` loads the built extension in a disposable Chromium for real Chrome API checks.

## Rules that came from real failures

- The agent must never claim a result it did not read. History records what each step revealed; a final answer quotes that, never the plan.
- Repeated actions from the same page state are reported to the models before the run stops. Do not lower the warn or stop thresholds without a new lab run.
- Reasoning levels are per model: read them from OpenRouter's `reasoning` metadata or the documented families in `src/providers.ts`. Do not hardcode preset model lists in the server or the UI again.
- Keys live only in `.env` (server) or `chrome.storage.local` (extension). Never log, echo, or commit them; the background worker redacts every stored key from error text and that list must include any new key.
- Same-page link clicks (fragment hrefs, prevented navigation) must not wait for a document navigation. Check `src/browser.ts` `click` before changing wait logic.

## Reviews

- The CodeRabbit GitHub app is not installed here. Review with the CLI from a checkout of the PR branch: `coderabbit review --committed --base <base-branch> --agent`. Use a temporary `git worktree` per branch when reviewing a stack.
- Fix real findings on the same branch, reply to false ones with a reason, and put the CLI output summary in the PR receipt.

## Do not

- Do not add a provider, mode, or setting nobody asked for. Extras are one-line proposals.
- Do not switch fast mode to a planner silently, and do not change a user's explicit model or reasoning choice.
- Do not touch `/home/exedev/checkto` (the live checkout) from a worktree except to read `.env`.
