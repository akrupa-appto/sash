# todo

one line per task. do it, check the box, move on. order inside each list is the order to do them.

## fix

- [ ] compare/summarize answers come out as one giant sentence. `planner.ts:34` says "one sentence"; allow a few short lines (one per item) for compare/summarize, keep one sentence for plain confirmations. the panel already renders pre-wrap.
- [ ] a multi-line message turns the compose box into a capsule blob. `.compose-box` is `border-radius:999px` in `extension/style.css`; make it `22px` and delete the `:has(.selected-tabs)` 20px override. add a `panel.test.mjs` case that types two lines and checks the radius.
- [ ] settings page is still the old cream theme with system fonts. `cadb09e` scoped the plum tokens to `.panel-page`; move them to `:root`, put Outfit on headings, retune `.privacy` and `--acc` for the dark background.
- [ ] custom openrouter model ids show "auto" as the only reasoning option. look the id up in the cached model list before treating it as unknown.
- [ ] an element can vanish between snapshot and click on pages that re-render every second (`locator.evaluate: Timeout`). retag the page and retry once by role and name before spending a step.

## improve

- [ ] blocked or errored runs read the reason but not the outcome. put one word on the agent message itself: "done", "could not finish", or "needs you".
- [ ] tabs the run opens are mixed into the user's tabs. put them in a "checkto" tab group in `attachPopup` (needs the `tabGroups` permission). never group the user's own tab.

## implement

- [ ] the agent cannot ask a question. add a planner status that ends the run with a question, render it in the panel as waiting for an answer, and continue from the user's next message.
- [ ] the agent never pauses before something irreversible (payment, send, delete, public post). ask first unless the task text authorizes it. builds on the question status above.

## verify

- [ ] openai, gemini, and custom-server planner paths have only ever run against mocked fetch. run each once with a real key and fix what breaks.
- [ ] the google sign-in popup ends control with an unknown chrome detach reason. capture the real reason and fix the wording in `detachMessage` if it reads badly.

## done

- [x] step logs stay with the message that produced them; each message renders its own "n actions" block.
