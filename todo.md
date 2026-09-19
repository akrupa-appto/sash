# todo

from adam's extension feedback, 2026-09-19. not started.

## extension

- [ ] keep step logs per message. `state.steps` is reset on every run, so after the next message the previous run's actions are gone. attach the steps to the agent message they belong to and render each message's own "n actions" block.
- [ ] say plainly when a task is complete. the final agent message is only the planner's answer; add a clear outcome line ("done", "could not finish", "needs you") on the message itself, not just the status strip at the bottom.
- [ ] questions and approvals. the agent cannot ask the user anything or pause before an irreversible action (payment, send, delete, public post). add a planner status that ends the run with a question, show it in the panel as needing an answer, and continue from the next message. ask before irreversible actions unless the task authorizes them.
- [ ] tab groups. tabs the run opens should land in a "checkto" chrome tab group so the user sees what it controls. needs the `tabGroups` permission and grouping in `attachPopup`; do not group the user's own tab.

## agent

- [ ] stale element retry: on pages that re-render every second an element can vanish between snapshot and click (`locator.evaluate: Timeout`). retag the page and retry once by role and name instead of burning a step.
- [ ] custom openrouter ids show only "auto" for reasoning because there is no metadata for an unknown id. look the id up in the cached list before treating it as unknown.

## verification debt

- [ ] live runs on the official openai and gemini apis. no keys on this machine; only mocked-fetch tests exist.
- [ ] confirm which detach reason chrome reports when the google sign-in popup ends control, and tune the message in `detachMessage` if it reads badly.
