# todo

one line per task. do it, tick it, move on.

numbers in brackets are adam's item numbers from the 2026-09-19 list, so a line here maps back to what he actually complained about.

---

## fix: ui

every one of these is visible in adam's 2026-09-19 screenshots.

- [ ] [17] compare/summarize answers come out as one giant run-on sentence. `planner.ts:34` asks for "one sentence"; allow a few short newline-separated lines (one per item) for compare/summarize, keep one sentence for plain confirmations. the panel already renders pre-wrap.
- [ ] [18] a multi-line message turns the compose box into a pill blob. keep the pill on one line and step to a large finite radius once the box grows, switched with `:has()` on the textarea being multi-line. the existing `:has(.selected-tabs)` override is the right technique on the wrong trigger. chatgpt does exactly this: pill by default, `--radius-3xl` via `:has(footer[data-composer-rows=stacked])`.
- [ ] the @ and the send button float in the middle of a tall compose box. `.compose-row` is `align-items:center`; pin both to the last line so they sit next to the caret like every other chat app.
- [ ] when a run ends the "n actions" toggle is half hidden under the status strip. the transcript scrolls to the bottom before the steps block mounts; scroll again after it renders and leave room above the strip.
- [ ] after "new" the status strip still reads "finished" from the last run. reset the status to ready when a chat is cleared.
- [ ] [16] settings page never got the redesign. `cadb09e` scoped the plum tokens to `.panel-page`, so `settings.html` still renders the cream `:root` theme in system fonts. move the tokens to `:root` and let each surface pick a variant with a data attribute instead of owning the tokens. that is how chatgpt does it: tokens on `:root,:host` in every chunk, surfaces varied by `data-composer-surface-variant`. it should look like the panel, not like a different product.

## fix: agent

- [ ] custom openrouter model ids offer "auto" as the only reasoning choice, because an unknown id has no metadata. look the id up in the cached model list before treating it as unknown.
- [ ] an element can vanish between snapshot and click on a page that re-renders every second (`locator.evaluate: Timeout`). retag the page and retry once by role and name instead of burning a step.

## implement

- [ ] [14] the agent cannot ask a question. add a planner status that ends the run with a question, render it in the panel as waiting for an answer, and resume from the user's next message.
- [ ] [14] the agent never pauses before something irreversible (payment, send, delete, public post). ask first unless the task text already authorizes it. builds on the question status above.
- [ ] [15] tabs the run opens are mixed in with the user's own. put them in a "checkto" chrome tab group in `attachPopup` (needs the `tabGroups` permission). never group the tab the user started from.
- [ ] [12] a run that ends blocked or errored explains its reason but never names its outcome. put one word on the agent message itself: "done", "could not finish", or "needs you".

## verify

these are the claims nothing on this machine has actually proven.

- [ ] openai, gemini and custom-server planner paths have only ever run against mocked fetch. run each once with a real key and fix what breaks.
- [ ] [9] the google sign-in popup ends browser control with a chrome detach reason nobody has read. capture the real reason and fix the wording in `detachMessage` if it reads badly.
- [ ] [7] no run has ever exercised forms, settings pages or error paths. do one deliberate run against each and write down what broke.
- [ ] find out whether a long wait lets chrome suspend the service worker mid-run. `background.js` persists run state and recovers with "the browser restarted, so the task stopped", which is the right floor, but a run that dies at step 20 and asks the user to start over is still a bad outcome. chatgpt keeps `alarms` for exactly this. measure it before building anything.

---

## take from the chatgpt extension

adam handed over the unpacked ChatGPT/Codex extension (build 1.26.901.11451) on 2026-09-19. every line below names the evidence in that build. these are new scope, not bugs.

### the whole in-page feedback layer is missing

checkto ships no content scripts at all. every permission it has is `debugger` and `tabs`, so all feedback lives in the side panel. when the agent works in a tab the user is not looking at, the page itself says nothing.

- [ ] draw an agent cursor on the controlled page. a content script animates a pointer to the element and reports arrival before the click lands, so the user sees what is about to be clicked. chatgpt: `content-scripts/codex.js`, `images/cursor-chat.png`, messages `AGENT_CURSOR_STATE` out and `AGENT_CURSOR_ARRIVED` back carrying `sessionId`, `turnId`, `moveSequence`.
- [ ] badge the favicon of every tab the run touches, with three states: active (working here), deliverable (finished, something for you), handoff (your turn, it is waiting on you). chatgpt: `TAB_FAVICON_BADGE`. this is the cheapest answer to both "which tabs does it control" [15] and "it never tells me it finished" [12], and it works while the panel is closed.
- [ ] ping a content script before reinjecting it, rather than assuming the last injection survived. chatgpt: `CONTENT_PING` answered with `{ok: true}`.

### tab ownership

- [ ] give each controlled tab a lease bound to a session and a turn, and route debugger events and cursor state through it. chatgpt tracks tab creation, replacement, movement and grouping so its model of the browser stays correct when the user drags a tab out or chrome swaps it. checkto tracks one tab id and nothing else. this has to land before tab groups [15] mean anything.

### ways in

- [ ] add a keyboard shortcut that opens the panel. chatgpt registers `open-codex-side-panel` and binds `Ctrl+Shift+Period` (`Cmd+Shift+Period` on mac). checkto's only entry point is the toolbar icon.
- [ ] add a right-click entry that sends the selection or link to checkto. chatgpt registers one context menu, "Ask ChatGPT", across page, frame, selection, link, editable, image, video and audio.

### deliberately not copying

- their manifest takes `<all_urls>` plus history, bookmarks, topSites, downloads, sessions, webNavigation and nativeMessaging. checkto's narrow host permissions and `optional_host_permissions` are better and stay as they are. their own bundled notes argue for cutting back to `sidePanel`, `storage` and `activeTab`. the single permission worth adding is `tabGroups`.
- they strip other extensions' `chrome-extension://` iframes out of pages they control (`content-scripts/foreign-frame-monitor.js`). real problem, wrong size for us. parked with a reason, not forgotten.
- checkto already debounces its tab picker on tab events and already honours `prefers-reduced-motion` for both animations. checked, nothing to do.

---

## regression guards

adam's rule: fixed means a test fails if it comes back. one line per fixed item, naming the test that holds it.

| # | the bug | guarded by |
|---|---|---|
| 1 | looped one action then quit | `agent.test.mjs` — a repeated agent action reports a loop rather than blaming the website |
| 1 | the stop never named the loop | `agent.test.mjs` — a repeated action is reported to the planner and jev before the run stops, and the stop names it |
| 2 | clicked "skip for now (demo mode)" instead of the task | `agent.test.mjs` — jev cannot swap the control the planner named for a skip button |
| 3 | claimed success it had not achieved | `agent.test.mjs` — navigation alone does not prove a planned final action completed the task |
| 5, 6 | waited four steps in a row instead of looking | `agent.test.mjs` — after three waits in a row the next step must inspect the page instead of waiting |
| 9 | stopped at a login page saying nothing | `extension-background.test.mjs` — Chrome cancelling browser control aborts the current task and explains what ended it |
| 10 | `chrome-extension://` attach error with no explanation | `extension.test.mjs` — Chrome adapter rejects internal tabs before attaching; `extension-background.test.mjs` — a failed popup attachment produces one terminal error message |
| 11 | previous run's steps vanished on the next message | `extension-background.test.mjs` — a finished run keeps its actions on the reply it produced |
| 12 | never said it had completed the task | `agent.test.mjs` — completion uses the operation decision without buying an unused second answer |
| 13 | answer rendered off-screen above the steps | `panel.test.mjs` — a finished run shows its answer after its own actions, not before them |

### guards still missing

- [ ] [4] "read one pr, reported another pr's result" has no test. the closest is `agent.test.mjs` — an exact-name match beats a pick that only contains the planner-quoted name — but nothing asserts the run reports the thing it actually opened. write that test.
- [ ] [8] "summary stated facts the action log didn't support" is held only by prompt wording in `planner.ts`. add a test that a claim not present in the step history cannot reach the answer.
- [ ] [7] "barely tested the app" is a run-quality problem with no mechanical check at all. decide whether it is a prompt rule or a step-budget rule before writing anything.
- [ ] each ui fix above ships with a `panel.test.mjs` case in the real-chromium harness: compose radius at two lines, control alignment, actions toggle not overlapped, status reset on new chat.

---

## done

shipped and verified this session unless noted.

- [x] [19] official openai, gemini and typesafe providers.
- [x] [20] openrouter picker is a real modal with per-model reasoning controls.
- [x] [21] custom openai-compatible provider option.
- [x] [22] ci builds the extension and bumps the version on every merge that touches it.
- [x] [11] step logs stay on the message that produced them; each message renders its own "n actions" block.
- [x] [13] the answer renders after the actions, so a finished run reads its reason without scrolling.
- [x] [1, 2, 3, 5, 6, 9, 10, 12] the agent-run failures above, each with the guard test named in the table.
- [ ] [23] "took too long to hand you something installable" — noted, not a task. the release pipeline now cuts a zip on every extension merge, which is the answer to it.
