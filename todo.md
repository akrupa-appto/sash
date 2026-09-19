1. planner.ts:34 — allow newlines for compare/summarize
2. extension/style.css:16 — .compose-box border-radius: 999px → 22px
3. panel.test.mjs — add multi-line message test in Chromium harness
4. settings.html — move plum tokens to :root; add Outfit; hand-tune .privacy and --acc
5. background.js — retry with larger output budget + native JSON mode for empty planner output
6. panel.js — one-word outcome status on message for blocked/errored runs
7. composer — add tab groups permission; group agent tabs in "checkto" tab group
8. agent loop — stale-element retry: retag and retry once by role/name on re-render
9. openrouter ids — cache lookup before marking unknown; show "auto" only when id not found
10. verification — live runs on official OpenAI and Gemini; confirm chrome detach reason