# sash for Chrome

A local Chrome extension with the same fast (Jev) and careful (planner + Jev) modes as the Sash app. It can work across your open website tabs, using your existing browser sessions. No Sash server or Anchor account is needed.

## Install

1. Unzip `sash-extension.zip`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and choose the `sash-extension` folder containing `manifest.json`.
4. In the settings tab, save your OpenRouter key. Optionally add an OpenAI or Gemini key to plan with those APIs directly, or a custom OpenAI-compatible server (base URL plus key; Chrome asks once to allow that site), and choose a direct TypeSafe connection for Jev. The planner model picker lists the models your keys unlock and the reasoning levels each model accepts.
5. Pin Sash in Chrome's extensions menu. Open a website, click Sash, and enter a task. Type `@` to search tabs across all windows and add the ones you mean.

Requires Chrome 118 or later. Chrome shows its debugger control banner during a task. **Stop**, closing the controlled tab, or cancelling Chrome's banner ends control. The agent can switch to existing website tabs and follow pages opened by the task. It attaches to tabs as needed and detaches when the task ends. Browser settings, the Chrome Web Store, extension pages, and controls inside embedded frames are not supported.

## Local data

Keys, settings, and a short chat history stay in `chrome.storage.local` in this Chrome profile. They are not synced, and there is no Sash backend in this flow. During a task, instructions, open website tab titles and URLs, and visible content from visited tabs are sent directly to the selected model providers using your keys. Local extension storage is not an encrypted vault. The settings page can remove keys, and **new chat** clears the stored conversation. Uninstalling removes the extension's local data.

The planner runs on the provider its model names: OpenRouter by default, or the official OpenAI or Gemini API for models chosen from those tabs. Text generation uses OpenRouter when that key is present, otherwise the planner's provider. With direct TypeSafe and no other key, fast mode can still click, select, and type text quoted in your task. OpenAI and Gemini do not report per-request cost, so the cost counter stays at zero for those planners. Model access and billing depend on your provider account.

## Build

From the repository root:

```sh
npm ci
npm run build:extension
npm test
npm run test:extension
npm run package:extension
```

Load `dist/sash-extension` unpacked. `dist/sash-extension.zip` is the distributable. All scripts are bundled locally; the extension downloads no executable code. `scripts/build-extension.mjs` replaces the Node browser/environment adapters with Chrome adapters while reusing the agent, Jev, planner, and DOM reader.

`npm run test:extension` loads the built extension in a disposable Chromium profile and uses deterministic provider replies to verify real Chrome APIs, settings persistence, both agent modes, new-tab navigation, and stopping. Install the Playwright Chromium binary first with `npx playwright install chromium` if it is missing. Screenshots are written to `runs/extension-qa/`.
