# todo

one line per task. do it, tick it, move on.

start here, in this order:

1. the password leak in `snapshot.js` (below). it is the only item that is actively wrong right now rather than merely missing.
2. the two composer fixes adam screenshotted, as one small pr.
3. the favicon badge. it is the single cheapest change with the most payoff: it answers "which tabs does it control" and "did it finish" at once, and it works while the panel is closed.

everything else is ordered inside its own list.

numbers in brackets are adam's item numbers from the 2026-09-19 list, so a line here maps back to what he actually complained about.

---

## fix: security

- [ ] **the page snapshot sends password values to the planner.** `snapshot.js:55` reads `el.value` for every typeable element, and `input[type=password]` falls into that branch, so a field a password manager has already filled arrives in the element list we post to openrouter, openai, gemini or a custom server. the settings page promises keys "never synced or sent to a Checkto server"; shipping the user's password to a third-party model breaks the same promise. omit the value for `type=password` at the serializer, the way chatgpt does, so no policy layer above it can leak. keep the element itself listed so the agent can still see a login form is there. add a test with a filled password input asserting the value never reaches the planner payload.

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
- [ ] a failed step still gets reported as a finished success. seen live: setting up a Zoho catch-all filter, `TYPE_TEXT "@pcstyle.dev" into [60]` fails with "the control is covered or not visible", the agent clicks "Update" anyway on the half-filled form, then tells the user the filter "has been updated to exclude me@pcstyle.dev" — the second condition was never entered. any action with `action failed` in its own log must not be treated as `finished`; re-check the field it touched (or bail and say so) before writing the summary line.

## implement

- [ ] [14] the agent cannot ask a question. add a planner status that ends the run with a question, render it in the panel as waiting for an answer, and resume from the user's next message.
- [ ] [14] the agent never pauses before something irreversible. do not build this as a keyword list of payment/send/delete/post: chatgpt has no such list anywhere, because a verb denylist is brittle and endless to maintain. their reviewer classifies the pending action and the client just renders the verdict and a risk level. cheapest honest version for us: make the planner return a risk field with the action it proposes, and pause on high. builds on the question status above.
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

adam handed over the unpacked ChatGPT/Codex extension (build 1.26.901.11451) on 2026-09-19. every line names the evidence. these are new scope, not bugs.

one caveat before trusting any of the copy below: the browser agent's own chat UI is not in the bundle. `codex-work-sidepanel.html` mounts an iframe of `chatgpt.com/?surface=browser_side_chat`, so its wording is server-rendered. the mechanisms are local and solid; the wording comes from the codex side panel next door, so treat it as the same design language rather than as the browser agent's exact strings.

if you only take three things from it: the favicon badge, the end-of-run tab contract, and one blocking state per turn.

### the in-page feedback layer we do not have

checkto ships no content scripts. its permissions are `debugger` and `tabs`, so every signal lives in the side panel. when the agent works in a tab the user is not looking at, the page says nothing.

- [ ] badge the favicon of each tab the run touches. dim the site's real favicon to `0.3` and stamp a glyph over it: a cursor while working, a green dot (`#22c55e`) when the tab holds a result, a yellow dot (`#facc15`) when the agent is waiting on the user. stash the original in a `data-` attribute and restore it before the tab closes, so no stale badge is ever seen. chatgpt: `TAB_FAVICON_BADGE`, states `active`/`deliverable`/`handoff`. no banner, no injected bar. it survives full-page apps, shows up in the tab strip, and works with the panel closed.
- [ ] treat the finished badge as an unread marker: it stays until the user actually looks at that tab, then clears on tab activation or window focus. chatgpt: `readEffectiveBadge`, cleared by `handleTabActivated` and `handleWindowFocused`. this is the honest answer to "it never tells me it finished" [12], and it needs no notification permission.
- [ ] draw an agent cursor on the controlled page so the user sees what is about to be clicked before it is clicked. chatgpt: `content-scripts/codex.js`, `images/cursor-chat.png` as the only web-accessible resource, in a closed shadow root at `z-index:2147483646`, `aria-hidden`, hidden in print, with a mutation observer repairing the host.
- [ ] only paint the cursor for a tab the user can actually see. position keeps tracking in the background, rendering does not. chatgpt: `isObserved` means the tab is active in its window, and `readCursorOverlayState` returns `visible:false` otherwise.
- [ ] mute agent tabs the user is not watching, and unmute the moment one becomes active. only ever unmute what we muted (`mutedInfo.reason === "extension"` and our own id). nothing is worse than a background tab playing audio at someone.
- [ ] ping a content script before reinjecting rather than assuming the last injection survived. chatgpt: `CONTENT_PING` answered `{ok: true}`. reapply badges on `tabs.onUpdated` at `status === "complete"`, and re-pull overlay state on `pageshow` so bfcache restores are not blank.

### tab ownership, which has to come before tab groups

- [ ] give each controlled tab a lease bound to a session and a turn, carrying an instance id so a restarted worker can tell whose lease it is. chatgpt refuses a second claim with `Tab N is already part of browser session M`. checkto tracks one tab id and nothing else.
- [ ] decide what happens to each tab when a run ends, and make the agent say which. chatgpt marks every tab `deliverable` (leave it open, ungroup it, green dot) or `handoff` (leave it open, hold the lease, yellow dot); unmarked tabs the agent opened get closed with the favicon restored first, and tabs the user handed over are just released. that single contract is why their runs do not litter the tab strip.
- [ ] [15] put agent-opened tabs in a group, created lazily on the first tab, titled "checkto" with a random colour, with the group id persisted so a restarted worker rejoins instead of making a second group. let the model rename the group to the task. never group a tab the user handed us: chatgpt groups only from `createTab` and popups the agent's own page spawned, never from `claimUserTab`. never collapse the group.
- [ ] reattach to handoff tabs on the next turn instead of starting cold: probe each one, resume the survivors under the new turn id keeping origin and viewport, silently drop the ones the user closed, and restore which was active. chatgpt: `resumeHandoffIfPresent`.

### how a step log should read

- [ ] give every action three strings, not one: a live ticker line while it runs ("Reading …"), an expanded row once done ("Read …"), and a lowercase fragment for the collapsed summary, plus a capitalised twin for when it starts the sentence. chatgpt ships all four per tool. this is the difference between a collapsed log that reads as a sentence and one that reads as a stack trace. checkto's "n actions" block is the place for it.
- [ ] put a duration divider between the actions and the answer, with three states and no more: "Working" while live, "Worked for 2m" when finished, "You stopped after 40s" when the user stopped it. note that the stopped case is phrased as the user's action, not the agent's failure. chatgpt re-ticks it every second while live and only shows a timer past one second.
- the answer belongs below the steps, which [13] already fixed. their divider description says the same thing, so that call was right.

### saying why it is stuck

- [ ] name the reason when a page blocks the run instead of going quiet [9]. chatgpt has a dedicated tool for it with four reasons: `captcha_failed`, `access_denied`, `challenge_loop`, `unexpected_bot_error`, described as "the current tab is blocked by bot detection, a failed CAPTCHA, a hard access denial, or a repeated challenge/login loop". checkto currently stops and says nothing useful.
- [ ] when the agent needs a credential, hand the page back and report what happened with a real outcome, not a guess. chatgpt tracks `submitted`, `declined`, `cancelled`, `unavailable`, `expired`, `origin_changed`, `page_changed`, `locator_invalid`, `submission_failed`, and a `user_took_over` reason. this is the concrete shape of the approval pause in [14].

### asking the human

- [ ] allow exactly one blocking state per turn, picked by scanning the turn backwards in a fixed priority order. chatgpt's order is user input, option picker, setup step, approval, permission request, elicitation, plan. without this you get two cards racing for the same answer.
- [ ] give every approval three scopes, not a yes/no: allow once, allow for this conversation, allow always. chatgpt puts the widest scope behind a second dialog with an explicit warning, and only for whole-internet access. their strings are "Allow once", "Allow this conversation", "Always allow", "Deny".
- [ ] when the user asks a question mid-run, offer a multiple-choice picker as well as free text. chatgpt ships an option picker with "Skip" and "Submit" alongside plain user input, because most mid-run questions are a choice between two pages, not an essay.
- [ ] stop retrying after repeated denials and end the turn saying so. chatgpt: "Auto-review stopped this turn after repeated denials. Add more context or choose a different permission mode to continue." an agent that asks the same thing five times is worse than one that gives up once.
- [ ] on stop, explicitly decline every pending request instead of dropping them. chatgpt fans out a decline to all six pending request types on interrupt, so nothing is left hanging waiting for an answer that will never come. checkto's stop path must not leave a question card alive.
- [ ] when the agent hits a login wall, hand back a typed form, not a sentence. chatgpt sends the origin, up to six labelled credential fields with their input types and autocomplete hints, the sign-in options, a submit descriptor and a screenshot, then the human fills it in the panel and the agent resumes and verifies. the agent never reads the credentials back off the page. this and the password fix above are the same piece of work.
- [ ] gate browser access per origin, with the wording doing the work: "allow checkto to access {origin}?" and a separate, scarier confirm for all sites. checkto already has `optional_host_permissions`, so this is mostly asking at the right moment rather than new permission machinery.

### ways in

- [ ] add a keyboard shortcut that opens the panel. chatgpt registers `open-codex-side-panel` on `Ctrl+Shift+Period`, `Cmd+Shift+Period` on mac. checkto's only entry point is the toolbar icon.
- [ ] add a right-click entry that sends the selection or link to checkto. chatgpt registers one context menu, "Ask ChatGPT", across page, frame, selection, link, editable, image, video and audio.

### deliberately not copying

- their manifest takes `<all_urls>` plus history, bookmarks, topSites, downloads, sessions, webNavigation and nativeMessaging. checkto's narrow host permissions and `optional_host_permissions` are better and stay. their own bundled notes argue for cutting back to `sidePanel`, `storage` and `activeTab`. the one permission worth adding is `tabGroups`.
- they pause a run when the agent's behaviour stops matching the user's instructions, with a gated resume behind a checkbox: "Chat paused as a precaution", "ChatGPT couldn't confirm the agent was interpreting your instructions correctly." that is a prompt-injection defence with a whole review surface behind it. worth knowing it exists; far too big for us now.
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
