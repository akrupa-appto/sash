# DESIGN.md - sash

## Context

- Artifact type: AI/conversational interface — a Chrome side panel (`extension/panel.html`, 400px and 320px wide) plus its settings page (`extension/settings.html`), both parts of a browser extension.
- Positioning: technical, utilitarian. sash drives a browser on the user's behalf; the panel is a working tool, not a marketing surface.
- Audience: people who already trust sash with page access and API keys. Primary action: state a task, watch it run, answer the rare thing it cannot decide alone.
- Adjectives: quiet, precise, checked-off, unhurried.
- Visual word translations: quiet -> near-black neutral background, no borders except where two surfaces must be told apart; precise -> a segmented tick track that fills in exactly once per completed step, never an estimate; checked-off -> finished work recorded as ticks in the window sash, not a brand pun on the old name; unhurried -> collapsed trace at rest, nothing animates unless a run is genuinely live.
- Aesthetic essence: near-black, checked-off, signal-only.
- Single-minded proposition: every run is a short, legible ledger you can leave collapsed and trust.
- References: admire the Codex CLI side-panel structure (top-anchored transcript, collapsed-by-default trace) this was drawn from; avoid the previous plum/cream theme and any indigo-gradient "AI assistant" default.
- Mode: dark only (the extension has no light mode). Density: balanced — a 400/320px panel cannot afford dense, but pure air wastes the space a real run's trace needs.
- Constraints: Manifest V3 extension page CSP (`script-src 'self'; object-src 'self'`), so fonts are self-hosted, not loaded from Google Fonts at runtime. Must render correctly at both 400px and 320px with zero horizontal overflow. Must not regress the composer-inert-while-blocked, `lastSeq` staleness guard, scroll-clamp, or even-grid approval-scope behaviors already fixed on this branch.

This is design 4 ("Marked Rows") from `public/panel-prototype.html` on `prototype/panel-directions`, palette 4 ("Signal-Only"). That comp is the source of truth for the aesthetic; this file records how it was implemented against sash's real, streaming state model, and freezes the decisions so a later session does not quietly drift back toward a different look.

## Aesthetic

- Direction: near-black neutral panel, separation entirely by background lightness, hairline rules only where two adjacent regions would otherwise be unreadable against each other (the topbar's bottom edge, the composer's top edge, the tab picker's panel edges via shadow, not borders elsewhere).
- Defining trait: the neutral ramp (`oklch(0.14 0 0)` through `oklch(0.95 0 0)`, chroma 0 throughout) is the entire structural language. No border tokens exist; every card, bubble, and control is one of six lightness steps.
- Signature move: the segmented tick track in a turn's trace header. Every finished (or in-flight) turn is headed by a quiet line — ticks, then "Worked for Ns" (or "N steps" / "Working" / "You stopped after Ns") — and that line **is** the trace's collapse handle, not a separate element repeating the same fact. One tick lands, filled, per step the agent loop actually completed.

## Typography

- UI face: Archivo (variable, weights 400-700), self-hosted at `extension/fonts/archivo.woff2`. Used for every label, button, heading, status line, and chat bubble.
- Mono: IBM Plex Mono, weights 400/500, self-hosted at `extension/fonts/ibm-plex-mono-{400,500}.woff2`. **Confined to genuine tool output only** — the raw execution note (`step.note`) the agent loop attaches to a step when it corrected, retried, or failed an action. Never used for chrome, labels, timings, or the trace header, even though those also show technical-sounding text like "3 steps" or "$0.0021" (those stay Archivo with `font-variant-numeric: tabular-nums` where they're numbers, not mono).
- Scale (`--text-*` tokens): 11 / 12 / 14 / 16 / 28 / 36px. No other sizes appear anywhere in the stylesheet.

| token | px | used for |
|---|---|---|
| `--text-2xs` | 11 | timestamps, tab picker footer, tool-output |
| `--text-xs` | 12 | buttons, step rows, trace header, muted captions |
| `--text-sm` | 14 | body copy, chat bubbles, composer input |
| `--text-md` | 16 | h2, settings labels |
| `--text-xl` | 28 | intro headline, settings h1 |
| `--text-2xl` | 36 | reserved, unused at panel width — kept in the scale for a future wider surface |

- Weights: 400 (body), 500 (buttons, emphasis), 600 (brand mark, h2), 700 (headline). Letter-spacing -.01em on headline-weight text only.

## Color

- Strategy: no brand accent anywhere. sash's old orange/peach accent (`--acc: #FFB48A`) is retired along with the plum background it lived on. Palette 4 is deliberately signal-only: send button, ticks, and every primary button fill are neutral, told apart from secondary controls by lightness and weight, not hue. Color exists only where it means something.
- Distribution: effectively 100% neutral surface + text, with 3 semantic hues currently in use (a done tick, a danger button, an amber "needs you" phrase) plus one reserved (`--status-info`, see below).
- Neutral ramp (chroma 0 throughout, six even steps):

| token | OKLCH | role |
|---|---|---|
| `--bg-page` | `oklch(0.14 0 0)` | page/panel background |
| `--bg` | `oklch(0.17 0 0)` | reserved next step up (currently unused as a fill; keeps the ramp complete) |
| `--surface-1` | `oklch(0.21 0 0)` | first lift: tab card, examples chips, tab picker, nested form fields inside a deep card |
| `--surface-2` | `oklch(0.25 0 0)` | deep lift: chat bubbles (user + agent), request/blocked cards |
| `--surface-3` | `oklch(0.30 0 0)` | hover state on secondary buttons and chips, unfilled tick |
| `--line` | `oklch(1 0 0 / 10%)` | the topbar and composer hairlines, plus the focus outline on the composer field |
| `--line-strong` | `oklch(1 0 0 / 16%)` | reserved for a stronger hairline if a future surface needs one |
| `--text-1` | `oklch(0.95 0 0)` | primary text |
| `--text-2` | `oklch(0.74 0 0)` | secondary text, step labels |
| `--text-3` | `oklch(0.62 0 0)` | tertiary text, captions, timestamps |

- No-accent interactive tokens: `--accent: oklch(0.92 0 0)`, `--accent-strong: oklch(0.98 0 0)` (hover), `--accent-ink: oklch(0.15 0 0)` (text on accent). Used by the send button and every "go" action (composer send, request-card primary button, credential submit).
- Semantic (the only hues in the file):

| token | OKLCH | hue | meaning | where it appears |
|---|---|---|---|---|
| `--status-success` | `oklch(0.75 0.15 145)` | green 145° | done | filled ticks, step check glyphs |
| `--status-danger` | `oklch(0.68 0.19 25)` | red 25° | failed / blocked | blocked-reason text, confirm-warning text |
| `--status-danger-bg` | `oklch(0.68 0.19 25 / 14%)` | red 25° | reserved for a future blocked-glyph chip | — |
| `--status-warning` | `oklch(0.78 0.15 75)` | amber 75° | needs you | the approval target phrase itself (`.request-target`, e.g. "submit the $89.00 order") in a request card with no explicit question |
| `--status-info` | `oklch(0.72 0.12 230)` | blue 230° | running / pending | reserved: retired along with the run-status strip its live dot used to sit on (the comp's own live state is text-only, `.panel-topbar-meta`'s "live", not a coloured dot); re-measure a real use before spending this token again |

- Worst measured contrast: 4.88:1 (`--text-3` on `--surface-1`), same ratio the source comp verified — above AA. Not re-measured lower anywhere in this implementation; if a future change adds `--text-3` on a lighter surface, re-measure before shipping it.

## Spacing, radius, motion

- Spacing base: `.25rem` (4px), scale `--sp-1` through `--sp-8` (4/8/12/16/20/24/32px). Every margin, gap, and padding in the stylesheet is one of these tokens; no bare pixel values for spacing.
- Radius scale: base values (2/4/6/8/10/12/16/20/24px) times a 1.25 role multiplier (`--r-2` … `--r-24`), plus one non-scaled `--radius-pill: 999px`, currently unused (the composer field the panel-match-comp pass replaced it on is a fixed `--r-16` rounded rect, matching the comp). Role, not size, picks the token: `--r-8` for small controls (buttons, chips, the model/mode cluster), `--r-12` for cards, `--r-16` for bubbles and the composer field, `--r-20` reserved for a future full-panel radius.
- Motion durations: `--dur-basic: .15s` (ticks landing, chevron rotation, hover), `--dur-relaxed: .3s` (trace expand/collapse). Easing: `--ease-out: cubic-bezier(0,0,.2,1)` for state changes, `--ease-enter: cubic-bezier(.23,1,.32,1)` for a tick landing.
- What animates: `transform` and `opacity` only, plus `grid-template-rows` (0fr -> 1fr) for the trace expanding — never `height`. Nothing pulses or ticks at rest (the one prior pulsing indicator, `.running .dot`, was removed with the run-status strip it lived on; see the panel-match-comp changelog entry).
- `prefers-reduced-motion: reduce` turns off the dot pulse, the tab-card hand drift, and every collapse/expand transition (the trace still opens and closes instantly, just without the animated `grid-template-rows` step).

## Components and states

- Buttons: one primary fill (`--accent`/`--accent-ink`, used for send and every card's "go" action) and one secondary fill (`--surface-2` normally, stepped down to `--surface-1` when the button sits inside a card that is already `--surface-2`, via `.notice button.secondary`, so a secondary control never blends into its own card). No outline/ghost/text-only button variant exists; every clickable action has a visible fill.
- Cards (`.notice`, covering `.request-card` and `.blocked-card`): `--surface-2` background, `--r-12` radius, no border. The blocked card is explicitly the same rule as its sibling request states — verified by a test that asserts identical computed `background-color` and `border-radius` between `#blocked` and a fresh `.notice.request-card` probe.
- Chat bubbles: user turns right-aligned, `--surface-2`, `--r-16 --r-16 --r-4 --r-16` (squared bottom-right corner reads as the tail). Agent turns full-width, `--surface-2`, `--r-12` — the deepest background lift the panel uses, marking a turn's reply as this run's confirmed output. An agent turn waiting on the user (`.message.agent.asking`) gets no extra border or edge treatment: palette 4 is signal-only, and a coloured side-tab border is exactly the AI-slop tell the palette's "no decoration, only meaning" rule forbids. The "needs you" signal lives in the `.asking` class itself (a screen-reader-only distinction — see Accessibility) and in the interactive request card below the composer, not as a stripe on the bubble or a repeated status word.
- The trace (signature move): `.trace` wraps either a native `<details>` (a finished turn, collapsible, chevron rotates on open) or a plain live `<div class="is-live">` (the in-flight run, always expanded, no chevron — there is nothing to collapse yet). The header (`.trace-header`) is ticks + a short label, never the step-by-step prose; the prose join-sentence ("opened tab, clicked upload, …") lives on the header's `aria-label` instead, so assistive tech still gets a real sentence and never a raw step count or stack trace. Each step row (`.step`) is a status glyph (always a green check — the agent loop only ever records a step once it is done, so there is no mid-flight glyph state to render) plus a label, plus, only when the step carried a raw execution note, a `.tool-output` block in mono with a bottom fade mask instead of a hard clip.
- Inputs: `--surface-1` background (one step darker than the `--surface-2` card that holds them, so they read as a recessed well), `--r-8`, no border; focus is the browser default outline offset by 3px on every focusable element.
- Empty state: unchanged structure (tab-card preview of the active tab + two example prompts), restyled to the new tokens — `--surface-1` card, `--surface-1` example chips instead of outlined pill buttons.
- Approval scope grid: `display:grid;grid-template-columns:1fr 1fr` — an even 2-column grid at any panel width, not a wrap. Verified at 320px by an existing test asserting all four buttons share one column width.

## Iconography

- Two inline SVGs only: a check (`status-glyph`, done ticks) and a chevron (`trace-header` disclosure). 16x16 viewBox, 1.4-1.8px stroke, round caps/joins. No icon font, no third-party icon set.

## Accessibility

- Contrast: worst pairing 4.88:1, AA-clear, carried from the source comp and not lowered.
- Focus: every button/input/textarea keeps a visible 3px-offset outline; nothing suppresses `outline` without providing a replacement.
- The trace header's visible text and its `aria-label` intentionally differ (ticks-and-duration vs. prose sentence) so sighted and screen-reader users both get the right form of the same information.
- Reduced motion: honored per the Motion section above.
- Color independence: every status also carries a text difference — the request/blocked cards' own copy, the trace header's live ticker or duration text, and (since the run-status strip's generic status word retired) an asking message's `.message-label` reading "sash, waiting for your answer" instead of plain "sash" — never color alone.

## Tokens (source of truth)

Full token block lives at the top of `extension/style.css` under `:root,:host`. It is the literal source; this table is a reference, not a duplicate to keep in sync by hand.

## Craft-layer decisions specific to this implementation

- **Ticks without a known total.** The prototype's tick track assumes a fixed, pre-known step count (`STEPS.length`). sash's real agent loop discovers steps one at a time and never predeclares a plan length. The implementation adapts the signature move honestly: the track has no empty/pending ticks at all — it is exactly as many filled ticks as steps completed so far, growing by one each time a new step lands (covered by `tests/panel.test.mjs`: "the segmented tick track advances as steps land"). This preserves the literal "checking off" reading without inventing a plan the agent doesn't have.
- **No live elapsed-seconds counter.** The source comp ticks a live "Ns" count once a second. sash's existing `durationText()` deliberately reports only three phrased states — "Working", "Worked for Ns", "You stopped after Ns" — a hard-won simplification already commented in `panel.js` ("Three states only, phrased as what happened to the run, not as the agent's failure"). That rule is preserved; the trace header shows "Working" (no number) while live and the numeric duration only once a run has actually ended.
- **The duration line replaced the separate `.duration` divider.** The pre-redesign panel rendered the trace summary (a prose sentence) and a separate `.duration` div ("Worked for 2m") as two sibling elements. Design 4 states the duration line **is** the trace handle, so the divider is gone; its text now lives inside `.trace-header .trace-label`, and a run too short to report a duration (<1s) falls back to a plain step count ("N steps") instead of leaving the header blank.
- **Fonts are self-hosted, not `<link>`-loaded from Google Fonts.** The extension's CSP (`script-src 'self'; object-src 'self'`) plus the existing precedent (Outfit was already vendored as a local `.woff2`) meant vendoring Archivo (one variable `.woff2`) and IBM Plex Mono (two static `.woff2`, 400/500) into `extension/fonts/` rather than adding a runtime dependency on `fonts.googleapis.com`.
- **Secondary buttons inside a card get their own step down.** A `.secondary` button is `--surface-2` by default — identical to the `.notice` card it usually sits inside, which would make it visually disappear. `.notice button.secondary` steps it back to `--surface-1` so it reads as a control, not as un-styled text (caught during screenshot review of the credential and approval states, not by a test — there is no automated contrast-between-nested-surfaces check yet).

## Slop audit

- Date: 2026-09-20. Result: pass. `python3 ~/.agents/skills/unslop-ui/scripts/devibe_scan.py extension/`: 0 findings, vibe score 0. `impeccable detect extension/`: 0 findings (exit 0) after fixes below.
- Notes: no AI-purple gradient, no centered-hero-plus-three-cards layout (not applicable to a chat panel, but checked), no gradient heading text, no emoji-as-icon, no unprompted glow.
- Real findings fixed during the pass, not suppressed: a coloured side-tab left-border on `.message.agent.asking` (the exact tell `frontend-design-deslop`'s NEVER list names; replaced with the design's actual mechanism, the amber `.request-target` phrase); a stray hardcoded `9px` in `.picker-footer` (now `--text-2xs`); a `:root` `font-size` bug that silently shrank every `rem`-based spacing token ~12.5% (spacing tokens now use `px`, decoupled from the document font-size); and two functional hint texts sized below the 11px legibility floor for actionable copy — `.composer-caption` (`#tab-context` + the send-key hint) and `.tab-card-foot`'s "or type @ for another" — both bumped from 11px (`--text-2xs`) to 12px (`--text-xs`).
- Disclosed, not silently suppressed (`.impeccable/config.json`, each with a reason): `cramped-padding` and `broken-image` on `extension/panel.html` (verified false positives — see the file's ignore reasons), and `tiny-text` on the same file for `#tab-card-title`, a status/caption readout (the textbook defensible case per this project's own `--text-2xs: 11px` caption tier).

## Changelog

- 2026-09-20: Initial DESIGN.md. Rebuilt `extension/style.css`, `panel.html`, `panel.js`, and verified `settings.html` against design 4 / palette 4 from `public/panel-prototype.html` (`prototype/panel-directions`). See PR description for the full list of preserved behaviors and screenshots.
- 2026-09-20 (panel-match-comp): The first pass retokened sash's *existing* composition instead of adopting the comp's; this pass replaces the composition itself, verified by rendering the comp (`public/panel-prototype.html?design=4&palette=4`) and the built extension side by side at every state and diffing them, not by re-reading either as prose.
  - **Topbar.** Added `.panel-topbar`: a 16px white rounded-square `.brand-mark` beside the wordmark, separated from the body by one hairline, matching the comp exactly. The comp's own outer rounded/shadowed `.panel-frame` is that file's lab-viewport mockup of the browser's own window chrome (the same thing a screenshot of any floating panel demo does); Chrome's real side panel already supplies that outer frame, so it is not re-implemented in `panel.html`. `new` and `settings` — both real, reachable functionality — moved to the topbar's trailing edge, in the slot the comp reserves for a meta readout (`#topbarMeta`).
  - **Composer, fully restructured, not retokened.** Replaced the three bolted-on chrome rows (`.run-status` strip with `#status-text`/`#cost`, `.mode-row` with `#model-link`/`#mode`, `.composer-caption` with `#tab-context`) with the comp's own two-part composer: `.composer-field` (the input alone, placeholder `Do anything` verbatim) above `.composer-actions` (a `.icon-btn` "+", a model/mode control, the circular neutral send button with the comp's own arrow glyph). Nothing was dropped, each moved to where the comp's own composition already has a place for it:
    - run status + cost → folded into the trace header (`#steps-label`), the one place a run already reports on itself; `#steps-wrap` now shows the instant a run starts (not only once a step has landed), carrying the same live-ticker text `#status-text` used to show, plus the running cost (`· $0.0002`) once one exists. A finished turn's own trace header gets the same cost suffix (`background.js` now carries `cost` onto the pushed message).
    - model + mode → `.model-cluster` (`#model-link` + `#mode`) sits inside `.composer-left`, one visual chip on one `surface-1` fill with a hairline between its two halves, doubling as `#model-link`'s old click-through into settings.
    - the tab-context caption → kept as a screen-reader-only live region (`#tab-context`) instead of a permanent visible line; the "+" button's tooltip and the tab picker's own heading carry the same fact for sighted users, on demand.
    - Dropped, deliberately, to match the comp exactly: the pill-that-morphs-to-a-rounded-rect radius behavior the old `.compose-box` had (a prior, `unslop-ignore`d ChatGPT-style decision). The comp's `.composer-field` is a fixed `--r-16` rounded rect in every state it renders; there is no comp state depicting a "pill at one line" variant to preserve, and the instruction for this pass is to match the file, not evoke a past decision it doesn't show.
    - Mic button (next voice-stage-2 work): belongs beside "+" in `.composer-left`, as a second `.icon-btn` — that row is exactly the "beside + without a rewrite" slot the composer was kept structural for.
  - **Tick track.** `.tick.is-done` now reads `var(--accent)` (neutral), not `var(--status-success)` (green) — palette 4's own caption: "send, ticks, and primary buttons go neutral"; green stays reserved for the per-step done check (`.status-glyph`). Covered by a new test.
  - **Tool output.** Added the comp's `plaintext` `.lang-tag` label above the mono block; padding/mask/max-height already matched the comp.
  - **Type/spacing.** `.content` padding-top raised from `--sp-3` to `--sp-4` to match the comp's `.transcript` padding; the rest of the scale already matched (both files draw from the same 4/8/12/16/20/24/32 base and 11/12/14/16/28/36 type scale).
  - **Kept, per instruction:** the first-run hero, the setup notice, the permission dialog, and the first-paint autoscroll fix from `adam/panel-surfaces`, untouched; the `#live-duration` "Working" line below the live steps list (pre-existing, not one of the measured deltas, and removing it would touch three passing tests for a very small piece of duplicated text — left as a known minor redundancy against the comp, which folds "Working" only into its header).
  - Tests: 178 (up from 177 on `adam/panel-surfaces`) — `panel.test.mjs` assertions that encoded the old composition (`#status-text`, `#run-status`, the compose-box pill radius, the "@ pinned beside the caret" alignment checks) were rewritten to check the new one's equivalent guarantees, not deleted; one new test added for the neutral tick track.

- 2026-09-21: Five alternative directions were drawn against this panel's real content and reviewed — d5 Quiet Receipt, d6 Shell Prompt, d7 Focus Rail, d8 Paper Ledger, d9 Command Deck (`prototype/panel-directions-2`, `public/designs/`, screenshots at 400px and 320px). The owner rejected all five as worse than what ships and said to keep the current design, so design 4 ("Marked Rows") / palette 4 ("Signal-Only") stands. That branch is the record of what was rejected, not a backlog, and a redesign is reopened only on his request. The known unfixed issues behind his standing "I still hate the UI" complaint — the tick track at high step counts and the provider error landing in the transcript rather than the error line — are behaviour, not palette or composition, and a redraw would not fix them.
