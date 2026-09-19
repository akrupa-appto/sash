# todo

from adam's extension feedback, 2026-09-19.

## extension

- [x] keep step logs per message. done: the run's steps are attached to the agent message they produced and each message renders its own "n actions" block.
- [ ] outcome word on the message. the reply is now the last thing in the transcript (the actions used to render below it, pushing the answer off screen), so a finished run reads its reason. still missing: a one-word outcome ("done", "could not finish", "needs you") on the message itself for runs that end blocked or errored, rather than only in the status strip.
- [ ] questions and approvals. the agent cannot ask the user anything or pause before an irreversible action (payment, send, delete, public post). add a planner status that ends the run with a question, show it in the panel as needing an answer, and continue from the next message. ask before irreversible actions unless the task authorizes them.
- [ ] tab groups. tabs the run opens should land in a "checkto" chrome tab group so the user sees what it controls. needs the `tabGroups` permission and grouping in `attachPopup`; do not group the user's own tab.

## agent

- [ ] stale element retry: on pages that re-render every second an element can vanish between snapshot and click (`locator.evaluate: Timeout`). retag the page and retry once by role and name instead of burning a step.
- [ ] custom openrouter ids show only "auto" for reasoning because there is no metadata for an unknown id. look the id up in the cached list before treating it as unknown.

## verification debt

- [ ] live runs on the official openai and gemini apis. no keys on this machine; only mocked-fetch tests exist.
- [ ] confirm which detach reason chrome reports when the google sign-in popup ends control, and tune the message in `detachMessage` if it reads badly.
