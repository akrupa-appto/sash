# Sash

Sash is a Chrome extension that drives your browser with an LLM agent. Open the side panel, type a task in plain language, and the agent reads the page, clicks, types, and selects through `chrome.debugger` on your own tabs, using your own browser sessions. There is no Sash backend involved in that flow: your task text and page content go straight from the extension to the model provider you configured.

The repo also has a small Node dev server (`src/server.ts`) used to develop and test the same agent, planner, and provider code outside the browser, and an Anchor Browser adapter for running it against a remote browser session instead of a local one.

## Install the extension

1. Download `sash-extension.zip` from the latest release ([extension-v0.4.3](https://github.com/akrupa-appto/checkto/releases/tag/extension-v0.4.3) at time of writing).
2. Unzip it.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and choose the unzipped `sash-extension` folder (the one containing `manifest.json`).
4. Open the extension's settings tab and add a provider key (see below).
5. Pin Sash in Chrome's extensions menu, open a site, click the icon, and type a task. Type `@` in the task box to search and attach other open tabs.

Requires Chrome 118 or later. See `extension/README.md` for what the extension stores locally, what it sends to providers, and its exact permissions.

## Configure a provider

Sash talks to a chat/completions API to plan and act. In the settings tab:

- **OpenRouter** (default) — paste an OpenRouter key. This is the simplest path and unlocks the widest model list.
- **Official APIs** — prefix a model ID with `openai:` or `gemini:` to call OpenAI or Google's Gemini API directly with your own key for that provider, instead of routing through OpenRouter.
- **Custom OpenAI-compatible server** — point at any OpenAI-compatible chat completions endpoint (base URL plus key). Chrome will ask once to allow that site.

The model picker in settings lists whichever models your saved keys unlock, along with the reasoning levels each model accepts.

## Run the dev server

```sh
npm ci
npm start
```

`npm start` runs `src/server.ts` directly — Node 24 strips TypeScript types at runtime, so there's no build step for the server. Set `OPENROUTER_API_KEY` (and `ANCHOR_API_KEY` if you want remote browser sessions instead of local Playwright Chromium) via `.env` or the environment.

## Run the tests

```sh
npm test
```

This builds the extension bundle first (`pretest` runs `npm run build:extension`), then runs every test under `tests/` (`*.test.mjs` and `*.test.ts`) with `node --experimental-test-module-mocks`. `panel.test.mjs` and `content.test.mjs` render real HTML in a local Chromium via Playwright; install it once with `npx playwright install chromium` if it's missing.

Other useful scripts:

```sh
npm run build:extension    # esbuild bundle into dist/sash-extension
npm run package:extension  # zip it into dist/sash-extension.zip
npm run test:extension     # load the built extension in a disposable Chromium and drive real Chrome APIs
```

## Repo layout

```
src/          agent loop, planner, providers, browser adapter, dev server
extension/    the Chrome extension (self-contained; bundles src/ code via esbuild)
public/       static assets served by the dev server, shared with the extension settings page
tests/        every test (*.test.mjs, *.test.ts) and tests/fixtures/
scripts/      build, package, and QA scripts for the extension
```

`AGENTS.md` and `DECISIONS.md` at the repo root are for agents and maintainers working in this codebase, not end users.

## Contributing

There's no license file yet — that's a decision for the maintainer, not assumed here. Issues and PRs otherwise welcome.
