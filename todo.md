# todo

one line per task. do it, tick it, move on.

everything below shipped on 2026-09-20 in prs #19-#25, merged in that order, released as extension v0.4.3. a second round the same day shipped in prs #35, #36, #37, #38, #39, released as extension v0.4.9 — see the bottom of `## done` for what that round actually was, and the new items below for what it opened up. what is left is the `verify` section: claims that need a real key or a real browser, not more code.

numbers in brackets are adam's item numbers from the 2026-09-19 list, so a line here maps back to what he actually complained about.

---

## fix: security

- [x] **the page snapshot sends password values to the planner.** `snapshot.js:55` reads `el.value` for every typeable element, and `input[type=password]` falls into that branch, so a field a password manager has already filled arrives in the element list we post to openrouter, openai, gemini or a custom server. the settings page promises keys "never synced or sent to a Checkto server"; shipping the user's password to a third-party model breaks the same promise. omit the value for `type=password` at the serializer, the way chatgpt does, so no policy layer above it can leak. keep the element itself listed so the agent can still see a login form is there. add a test with a filled password input asserting the value never reaches the planner payload.

## fix: ui

every one of these is visible in adam's 2026-09-19 screenshots.

- [x] [17] compare/summarize answers come out as one giant run-on sentence. `planner.ts:34` asks for "one sentence"; allow a few short newline-separated lines (one per item) for compare/summarize, keep one sentence for plain confirmations. the panel already renders pre-wrap.
- [x] [18] a multi-line message turns the compose box into a pill blob. keep the pill on one line and step to a large finite radius once the box grows, switched with `:has()` on the textarea being multi-line. the existing `:has(.selected-tabs)` override is the right technique on the wrong trigger. chatgpt does exactly this: pill by default, `--radius-3xl` via `:has(footer[data-composer-rows=stacked])`.
- [x] the @ and the send button float in the middle of a tall compose box. `.compose-row` is `align-items:center`; pin both to the last line so they sit next to the caret like every other chat app.
- [x] the transcript overscrolls past its own content into empty space. seen live: scrolling down keeps going well after the last message and composer have scrolled off, leaving a blank panel with the scrollbar thumb still short of the end of the track — everything is off screen and there is nothing below it to scroll to. the scroll container's height/`scrollHeight` is being measured before layout settles (same family of bug as the "n actions" toggle mounting late, below), so it reserves space for content that isn't there. clamp `scrollTop` to actual content height after each render, or scope the scrollable area with `overflow-anchor` so it can't outrun real content.
- [x] when a run ends the "n actions" toggle is half hidden under the status strip. the transcript scrolls to the bottom before the steps block mounts; scroll again after it renders and leave room above the strip.
- [x] after "new" the status strip still reads "finished" from the last run. reset the status to ready when a chat is cleared.
- [x] [16] settings page never got the redesign. `cadb09e` scoped the plum tokens to `.panel-page`, so `settings.html` still renders the cream `:root` theme in system fonts. move the tokens to `:root` and let each surface pick a variant with a data attribute instead of owning the tokens. that is how chatgpt does it: tokens on `:root,:host` in every chunk, surfaces varied by `data-composer-surface-variant`. it should look like the panel, not like a different product.

## fix: agent

- [x] custom openrouter model ids offer "auto" as the only reasoning choice, because an unknown id has no metadata. look the id up in the cached model list before treating it as unknown.
- [x] an element can vanish between snapshot and click on a page that re-renders every second (`locator.evaluate: Timeout`). retag the page and retry once by role and name instead of burning a step.
- [x] a failed step still gets reported as a finished success. seen live: setting up a Zoho catch-all filter, `TYPE_TEXT "@pcstyle.dev" into [60]` fails with "the control is covered or not visible", the agent clicks "Update" anyway on the half-filled form, then tells the user the filter "has been updated to exclude me@pcstyle.dev" — the second condition was never entered. any action with `action failed` in its own log must not be treated as `finished`; re-check the field it touched (or bail and say so) before writing the summary line.

## implement

- [x] [14] the agent cannot ask a question. add a planner status that ends the run with a question, render it in the panel as waiting for an answer, and resume from the user's next message.
- [x] [14] the agent never pauses before something irreversible. do not build this as a keyword list of payment/send/delete/post: chatgpt has no such list anywhere, because a verb denylist is brittle and endless to maintain. their reviewer classifies the pending action and the client just renders the verdict and a risk level. cheapest honest version for us: make the planner return a risk field with the action it proposes, and pause on high. builds on the question status above.
- [x] [15] tabs the run opens are mixed in with the user's own. put them in a "checkto" chrome tab group in `attachPopup` (needs the `tabGroups` permission). never group the tab the user started from.
- [x] [12] a run that ends blocked or errored explains its reason but never names its outcome. put one word on the agent message itself: "done", "could not finish", or "needs you".

## verify

these are the claims nothing on this machine has actually proven. they need a real key or a real browser, which is why the sweep above did not close them.

- [ ] openai, gemini and custom-server planner paths have only ever run against mocked fetch. run each once with a real key and fix what breaks. adam confirmed on 2026-09-20 that the openai and custom-server paths work; gemini is still unproven.
- [ ] [9] the google sign-in popup ends browser control with a chrome detach reason nobody has read. capture the real reason and fix the wording in `detachMessage` if it reads badly.
- [ ] [7] no run has ever exercised forms, settings pages or error paths. do one deliberate run against each and write down what broke.
- [ ] the keyboard shortcut, the context menu entry and the live favicon badge are code-verified only. this vm's chrome cannot load an unpacked extension (`--load-extension` is inert, and driving "load unpacked" through the gtk picker closes cleanly without registering), so nobody has pressed ctrl+shift+period or watched a real tab get badged. load v0.4.9 on a normal machine and check those three.
- [ ] find out whether a long wait lets chrome suspend the service worker mid-run. `background.js` persists run state and recovers with "the browser restarted, so the task stopped", which is the right floor, but a run that dies at step 20 and asks the user to start over is still a bad outcome. chatgpt keeps `alarms` for exactly this. measure it before building anything.
- [ ] **new, 2026-09-20.** nothing about voice control (prs #30, #37) is verified on a real machine, for the same reason as the row above: this vm cannot load the extension. the mic permission prompt from `mic-permission.html`, `getUserMedia` actually succeeding from the offscreen document, live audio reaching a configured provider and a real transcript coming back, and push-to-talk / the double-tap hands-free latch's real feel — none of it has been pressed for real. load v0.4.9 on a normal machine and check all of it.

---

## take from the chatgpt extension

adam handed over the unpacked ChatGPT/Codex extension (build 1.26.901.11451) on 2026-09-19. every line names the evidence. these are new scope, not bugs.

one caveat before trusting any of the copy below: the browser agent's own chat UI is not in the bundle. `codex-work-sidepanel.html` mounts an iframe of `chatgpt.com/?surface=browser_side_chat`, so its wording is server-rendered. the mechanisms are local and solid; the wording comes from the codex side panel next door, so treat it as the same design language rather than as the browser agent's exact strings.

if you only take three things from it: the favicon badge, the end-of-run tab contract, and one blocking state per turn.

### the in-page feedback layer we do not have

checkto ships no content scripts. its permissions are `debugger` and `tabs`, so every signal lives in the side panel. when the agent works in a tab the user is not looking at, the page says nothing.

- [x] badge the favicon of each tab the run touches. dim the site's real favicon to `0.3` and stamp a glyph over it: a cursor while working, a green dot (`#22c55e`) when the tab holds a result, a yellow dot (`#facc15`) when the agent is waiting on the user. stash the original in a `data-` attribute and restore it before the tab closes, so no stale badge is ever seen. chatgpt: `TAB_FAVICON_BADGE`, states `active`/`deliverable`/`handoff`. no banner, no injected bar. it survives full-page apps, shows up in the tab strip, and works with the panel closed.
- [x] treat the finished badge as an unread marker: it stays until the user actually looks at that tab, then clears on tab activation or window focus. chatgpt: `readEffectiveBadge`, cleared by `handleTabActivated` and `handleWindowFocused`. this is the honest answer to "it never tells me it finished" [12], and it needs no notification permission.
- [ ] **correction, 2026-09-20: these two were wrongly ticked. re-opened.** draw an agent cursor on the controlled page so the user sees what is about to be clicked before it is clicked. what actually shipped is only the drawing half: `background.js` handles a `setCursor` message that **nothing ever sends**; every real write sets `cursor: undefined`. `content.js` has no motion code at all — no transition, no rAF, no tween — and `snapshot.js` exposes no x/y coordinates, only `above`/`below` for offscreen elements. needs three things that don't exist yet: coordinates out of the snapshot, a sender driving `setCursor` per action from the agent loop, and interpolated motion in the content script. full writeup in `DECISIONS.md`, "The cursor is a receiver with no sender."
- [ ] only paint the cursor for a tab the user can actually see. this half is real (`isObserved`/`observed` gating exists and is tested) but is moot until the item above actually drives a cursor.
- [x] mute agent tabs the user is not watching, and unmute the moment one becomes active. only ever unmute what we muted (`mutedInfo.reason === "extension"` and our own id). nothing is worse than a background tab playing audio at someone.
- [x] ping a content script before reinjecting rather than assuming the last injection survived. chatgpt: `CONTENT_PING` answered `{ok: true}`. reapply badges on `tabs.onUpdated` at `status === "complete"`, and re-pull overlay state on `pageshow` so bfcache restores are not blank.

### tab ownership, which has to come before tab groups

- [x] give each controlled tab a lease bound to a session and a turn, carrying an instance id so a restarted worker can tell whose lease it is. chatgpt refuses a second claim with `Tab N is already part of browser session M`. checkto tracks one tab id and nothing else.
- [x] decide what happens to each tab when a run ends, and make the agent say which. chatgpt marks every tab `deliverable` (leave it open, ungroup it, green dot) or `handoff` (leave it open, hold the lease, yellow dot); unmarked tabs the agent opened get closed with the favicon restored first, and tabs the user handed over are just released. that single contract is why their runs do not litter the tab strip.
- [x] [15] put agent-opened tabs in a group, created lazily on the first tab, titled "checkto" with a random colour, with the group id persisted so a restarted worker rejoins instead of making a second group. let the model rename the group to the task. never group a tab the user handed us: chatgpt groups only from `createTab` and popups the agent's own page spawned, never from `claimUserTab`. never collapse the group.
- [x] reattach to handoff tabs on the next turn instead of starting cold: probe each one, resume the survivors under the new turn id keeping origin and viewport, silently drop the ones the user closed, and restore which was active. chatgpt: `resumeHandoffIfPresent`.

### how a step log should read

- [x] give every action three strings, not one: a live ticker line while it runs ("Reading …"), an expanded row once done ("Read …"), and a lowercase fragment for the collapsed summary, plus a capitalised twin for when it starts the sentence. chatgpt ships all four per tool. this is the difference between a collapsed log that reads as a sentence and one that reads as a stack trace. checkto's "n actions" block is the place for it.
- [x] put a duration divider between the actions and the answer, with three states and no more: "Working" while live, "Worked for 2m" when finished, "You stopped after 40s" when the user stopped it. note that the stopped case is phrased as the user's action, not the agent's failure. chatgpt re-ticks it every second while live and only shows a timer past one second.
- the answer belongs below the steps, which [13] already fixed. their divider description says the same thing, so that call was right.

### saying why it is stuck

- [x] name the reason when a page blocks the run instead of going quiet [9]. chatgpt has a dedicated tool for it with four reasons: `captcha_failed`, `access_denied`, `challenge_loop`, `unexpected_bot_error`, described as "the current tab is blocked by bot detection, a failed CAPTCHA, a hard access denial, or a repeated challenge/login loop". checkto currently stops and says nothing useful.
- [x] when the agent needs a credential, hand the page back and report what happened with a real outcome, not a guess. chatgpt tracks `submitted`, `declined`, `cancelled`, `unavailable`, `expired`, `origin_changed`, `page_changed`, `locator_invalid`, `submission_failed`, and a `user_took_over` reason. this is the concrete shape of the approval pause in [14].

### asking the human

- [x] allow exactly one blocking state per turn, picked by scanning the turn backwards in a fixed priority order. chatgpt's order is user input, option picker, setup step, approval, permission request, elicitation, plan. without this you get two cards racing for the same answer.
- [x] give every approval three scopes, not a yes/no: allow once, allow for this conversation, allow always. chatgpt puts the widest scope behind a second dialog with an explicit warning, and only for whole-internet access. their strings are "Allow once", "Allow this conversation", "Always allow", "Deny".
- [x] when the user asks a question mid-run, offer a multiple-choice picker as well as free text. chatgpt ships an option picker with "Skip" and "Submit" alongside plain user input, because most mid-run questions are a choice between two pages, not an essay.
- [x] stop retrying after repeated denials and end the turn saying so. chatgpt: "Auto-review stopped this turn after repeated denials. Add more context or choose a different permission mode to continue." an agent that asks the same thing five times is worse than one that gives up once.
- [x] on stop, explicitly decline every pending request instead of dropping them. chatgpt fans out a decline to all six pending request types on interrupt, so nothing is left hanging waiting for an answer that will never come. checkto's stop path must not leave a question card alive.
- [x] when the agent hits a login wall, hand back a typed form, not a sentence. chatgpt sends the origin, up to six labelled credential fields with their input types and autocomplete hints, the sign-in options, a submit descriptor and a screenshot, then the human fills it in the panel and the agent resumes and verifies. the agent never reads the credentials back off the page. this and the password fix above are the same piece of work.
- [x] gate browser access per origin, with the wording doing the work: "allow checkto to access {origin}?" and a separate, scarier confirm for all sites. checkto already has `optional_host_permissions`, so this is mostly asking at the right moment rather than new permission machinery.

### ways in

- [x] add a keyboard shortcut that opens the panel. chatgpt registers `open-codex-side-panel` on `Ctrl+Shift+Period`, `Cmd+Shift+Period` on mac. checkto's only entry point is the toolbar icon.
- [x] add a right-click entry that sends the selection or link to checkto. chatgpt registers one context menu, "Ask ChatGPT", across page, frame, selection, link, editable, image, video and audio.

### deliberately not copying

- their manifest takes `<all_urls>` plus history, bookmarks, topSites, downloads, sessions, webNavigation and nativeMessaging. checkto's narrow host permissions and `optional_host_permissions` are better and stay. their own bundled notes argue for cutting back to `sidePanel`, `storage` and `activeTab`. the one permission worth adding is `tabGroups`.
- they pause a run when the agent's behaviour stops matching the user's instructions, with a gated resume behind a checkbox: "Chat paused as a precaution", "ChatGPT couldn't confirm the agent was interpreting your instructions correctly." that is a prompt-injection defence with a whole review surface behind it. worth knowing it exists; far too big for us now.
- they strip other extensions' `chrome-extension://` iframes out of pages they control (`content-scripts/foreign-frame-monitor.js`). real problem, wrong size for us. parked with a reason, not forgotten.
- checkto already debounces its tab picker on tab events and already honours `prefers-reduced-motion` for both animations. checked, nothing to do.

---

## fix: panel (found 2026-09-20, second round)

- [ ] **the tick track does not survive a real multi-step workflow.** adam sent four real screenshots of the installed extension running genuine multi-step tasks (~20 and ~40 actions). the tick track — the segmented-square row that fills in per step, the redesigned panel's signature move — was built and only ever screenshot-tested against a 2-3 step demo task. at ~40 steps the dot row is one unbroken flex row with no wrap and no cap, so it overflows its container width and shoves the "Worked for Nm" duration label into a squeezed vertical single-character-per-line stack down the right edge of the panel. at ~20 steps it wraps to a second line instead of overflowing, which doesn't break layout but is still 20 meaningless identical dots — nobody can tell which step failed by counting squares. real tasks on real sites regularly run 15-40+ actions; this is not an edge case. needs a real design pass, not a patch: a cap with an overflow affordance ("12 more"), a different visual unit at high counts (a progress bar or percentage instead of discrete dots), or grouping consecutive same-kind actions. full writeup, including exactly what the screenshots showed, in `DECISIONS.md`. adam's screenshots are not saved in the repo — ask him to resend when this is picked up.
- [ ] **no settings surface for anything shipped this round.** settings.html still only has connections (provider keys) and agent preferences (mode/model/reasoning) — seven keys total. nothing exists for: reviewing or revoking approval grants (`grants:list`/`grants:revoke` messages exist in `background.js`, built specifically for this, unconsumed by any UI), voice on/off + eagerness mode + dictation provider (`voiceEnabled`/`voiceMode`/`voiceProvider` settings keys exist, no UI), per-origin access grants (`extension/permissions.js`, no way to see or revoke what's been allowed), or the tab-group/favicon-badge/cursor-overlay behavior from the "take from the chatgpt extension" section above (no toggles at all — always on, no way to turn off). an "always allow" approval grant that can't be found or revoked from settings is its own trap.

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
| — | password values reached the planner payload | `snapshot.test.mjs` — a filled password field is listed without its value |
| 4 | read one pr, reported another pr's result | `agent.test.mjs` — the run reports the item it actually opened, not a same-named one it only considered |
| 8 | summary stated facts the action log didn't support | `agent.test.mjs` — a claim absent from the step history cannot reach the answer |
| 7 | barely tested the app | `agent.test.mjs` — a run that reaches "done" after one navigation with no inspection is sent back to work |
| 17 | run-on compare/summarize answers | `planner.test.mjs` — the prompt allows one short line per item, and a multi-line answer survives |
| 18 | multi-line message turned the pill into a blob | `panel.test.mjs` — compose radius at one line vs two |
| — | @ and send floated mid-box | `panel.test.mjs` — both controls sit at the textarea's bottom in a tall box |
| — | transcript overscrolled past its content | `panel.test.mjs` — no gap past the last message once layout settles |
| — | "n actions" toggle hid under the status strip | `panel.test.mjs` — the toggle stays fully visible above the strip |
| — | status strip still read "finished" after "new" | `panel.test.mjs` — a stray post-clear broadcast cannot put "finished" back |
| 16 | settings page rendered the cream theme | `panel.test.mjs` — settings.html computes the plum background and Outfit |
| — | a failed step was reported as a finished success | `agent.test.mjs` — an unconfirmed failed action forces a re-check before "done", or blocks |
| — | free text could discard a pending approval | `panel.test.mjs` + `extension-background.test.mjs` — the composer goes inert and `run` refuses while a request is pending |

### guards still missing

- [x] [4] "read one pr, reported another pr's result" has no test. the closest is `agent.test.mjs` — an exact-name match beats a pick that only contains the planner-quoted name — but nothing asserts the run reports the thing it actually opened. write that test.
- [x] [8] "summary stated facts the action log didn't support" is held only by prompt wording in `planner.ts`. add a test that a claim not present in the step history cannot reach the answer.
- [x] [7] "barely tested the app" is a run-quality problem with no mechanical check at all. decide whether it is a prompt rule or a step-budget rule before writing anything.
- [x] each ui fix above ships with a `panel.test.mjs` case in the real-chromium harness: compose radius at two lines, control alignment, actions toggle not overlapped, status reset on new chat.

---

## done

shipped and verified this session unless noted.

- [x] 2026-09-20: the whole list above, as prs #19-#25 merged bottom-to-top, released as extension v0.4.3. two things only the combination caught: #23 and #24 had each built their own pause mechanism, unified onto the request queue; and the composer was never gated on a pending request, so typing "yes" at an approval silently dropped it and started a fresh run. the outcome word from [12] is rendered by the status strip rather than prefixed onto the message — same need, one place.
- [x] [19] official openai, gemini and typesafe providers.
- [x] [20] openrouter picker is a real modal with per-model reasoning controls.
- [x] [21] custom openai-compatible provider option.
- [x] [22] ci builds the extension and bumps the version on every merge that touches it.
- [x] [11] step logs stay on the message that produced them; each message renders its own "n actions" block.
- [x] [13] the answer renders after the actions, so a finished run reads its reason without scrolling.
- [x] [1, 2, 3, 5, 6, 9, 10, 12] the agent-run failures above, each with the guard test named in the table.
- [ ] [23] "took too long to hand you something installable" — noted, not a task. the release pipeline now cuts a zip on every extension merge, which is the answer to it.

- [x] 2026-09-20, second round: prs #35, #36, #37, #38, #39 merged bottom-to-top (#36 approval scopes, #39 handoff docs, #35 panel surfaces, #37 voice stage 2, #38 panel-comp-match), released as extension v0.4.9. three things worth naming:
  - **the panel's three approval scopes were decorative.** `state.grants` was written on every approval answer and read nowhere — `grep -c` on `background.js` returned 1. all three scopes ("allow once" / "allow for this conversation" / "always allow") behaved identically: permit once, ask again next time. shipped past a cloud review, coderabbit, and 175 tests because every check verified the button rendered and resolved the request; none asserted the scope changed future behaviour. fixed with a real `grantKey`/`isGranted` check before a request ever reaches the panel, `conversation`-scope grants riding `runState` (wiped by `clear`), `always`-scope grants in their own `chrome.storage.local` entry (surviving a service-worker restart), and a cap on the auto-resume loop (coderabbit caught a real unbounded-spin risk here).
  - **two implementation attempts at the panel redesign shipped as reskins, not redesigns**, before this round's actually matched the approved comp. attempt one changed 2 lines of html and 335 of css. attempt two converted more surfaces but still applied the comp's tokens onto checkto's existing composition instead of adopting the comp's composition (topbar, composer, tick-track colour). the method that actually worked: render the comp and the built extension side by side at the same states and width, diff visually, fix, re-render, repeat — never implement a design from a prose description, including descriptions in this file or in `DECISIONS.md`. full detail in `DECISIONS.md`.
  - **voice control** (dictation, push-to-talk on `M`, a double-tap hands-free latch on the global shortcut, three eagerness modes) shipped across two prs (#30 earlier, #37 this round). byok per adam's requirement — audio goes to whichever provider is already configured, resolved from the actual planner model, not a fixed priority order (that was also a real bug, fixed before this round: dictation was silently defaulting to whichever provider's key sorted first). `eager` mode is honestly built on chunk-sized partials rather than silently downgraded to word-by-word, because true streaming needs openai realtime or gemini live, neither implemented here. nothing mic-related is verified on real hardware — see `## verify` above.
  - one release-pipeline gap found and fixed live: the atomic version-bump push can lose a race when two merges land back to back, and unlike earlier in the day it did not self-heal that time because the next merge was docs-only and didn't match the release workflow's path filter — `main` sat unreleased with real code changes merged in. fixed by re-running the workflow via `workflow_dispatch`; worth knowing if a version number ever looks stale after a merge.
