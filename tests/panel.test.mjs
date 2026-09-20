import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';
import { approvalRequest, credentialRequest } from '../extension/requests.js';

// The panel is rendered in a real browser: the bug this guards against was DOM order, not logic.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const root = join(import.meta.dirname, '..', 'dist/checkto-extension');
const server = createServer(async (req, res) => {
  try {
    const path = join(root, new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(root)) throw new Error('outside root');
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// A checkout without `npx playwright install chromium` skips these instead of failing the suite.
const browser = await chromium.launch().catch(() => undefined);
const skip = browser ? false : 'chromium is not installed: npx playwright install chromium';
after(async () => { await browser?.close(); server.close(); });

const steps = [
  {
    step: 1, plan: 'switch to the upload tab', action: 'opened tab: ~/upload',
    log: { ticker: 'Opening tab: ~/upload', expanded: 'Opened tab: ~/upload', fragment: 'opened tab: ~/upload', fragmentCapitalized: 'Opened tab: ~/upload' },
  },
  {
    step: 2, plan: 'click the "upload" button', action: 'CLICK [5] button "upload"',
    log: { ticker: 'Clicking the "upload" button', expanded: 'Clicked the "upload" button', fragment: 'clicked the "upload" button', fragmentCapitalized: 'Clicked the "upload" button' },
  },
];
const started = Date.parse('2026-09-19T12:00:00Z');
// The header label joins its segments on a non-breaking " · " so the dot can never be orphaned at a
// line end when the label wraps at 320px (see SEP in panel.js).
const SEP = '\u00a0·\u00a0';
const finished = {
  running: false, status: 'done', cost: 0.0002, steps,
  messages: [
    { role: 'user', text: 'upload the file' },
    { role: 'agent', text: 'uploaded it; the file URL opens.', steps, startedAt: started, endedAt: started + 125_000, stopped: false },
  ],
};

async function panel(state, { width, configured = true, voice } = {}) {
  const page = await browser.newPage(width ? { viewport: { width, height: 720 } } : undefined);
  await page.addInitScript(cfg => {
    const ev = () => ({ addListener() {}, removeListener() {} });
    window.chrome = {
      runtime: {
        sendMessage: async message => (message.type === 'getState'
          ? { state: { running: false, status: 'ready', messages: [], steps: [] }, configured: cfg.configured, mode: 'careful', model: 'glm-5.3-flash', reasoning: 'low', seq: 0, voice: cfg.voice }
          : message.type === 'clear'
            ? { ok: true, state: { running: false, messages: [], steps: [], status: 'ready' }, seq: 999 }
            : { ok: true }),
        onMessage: { addListener: f => { window.onState = f; } }, openOptionsPage() {},
      },
      tabs: { query: async () => [{ id: 1, url: 'https://example.test/', title: 'Example', active: true, windowId: 1, index: 0 }], onCreated: ev(), onRemoved: ev(), onUpdated: ev(), onActivated: ev() },
      storage: { onChanged: ev() },
    };
  }, { configured, voice });
  await page.goto(`${base}/panel.html`);
  await page.waitForFunction(() => window.onState);
  // A live run's age is measured against the page's own clock at the moment it renders, so a test
  // that cares about it says how old the run is rather than when it started.
  await page.evaluate(s => {
    if (s.startedAgoMs !== undefined) s.startedAt = Date.now() - s.startedAgoMs;
    window.onState({ type: 'state', state: s, seq: 1 });
  }, state);
  return page;
}

test('a finished run shows its answer after its own actions and duration, the duration line itself being the trace handle', { skip }, async () => {
  const page = await panel(finished);
  // No separate ".duration" divider any more: design 4's trace header line ("Worked for Ns") IS the
  // duration line — repeating it in a sibling element would just say the same thing twice.
  const order = await page.evaluate(() => [...document.querySelector('.message.agent').children].map(el => el.className || el.tagName.toLowerCase()));
  assert.deepEqual(order, ['message-label', 'trace steps', 'div']);
  assert.equal(await page.locator('.message.agent > div').last().innerText(), 'uploaded it; the file URL opens.');
  // The visible trace header reads "Worked for Ns", not a prose step sentence; the joined-sentence
  // prose lives on aria-label instead, so assistive tech still gets a sentence, never a stack trace.
  assert.equal(await page.locator('.message.agent .steps summary .trace-label').innerText(), 'Worked for 2m');
  assert.equal(await page.locator('.message.agent .steps summary').getAttribute('aria-label'), 'Opened tab: ~/upload, clicked the "upload" button');
  assert.doesNotMatch(
    await page.locator('.message.agent .steps summary').evaluate(el => getComputedStyle(el).fontFamily),
    /mono/i,
  );
  // The signature move: one filled tick per step that landed.
  assert.equal(await page.locator('.message.agent .steps .tick').count(), 2);
  assert.equal(await page.locator('.message.agent .steps .tick.is-done').count(), 2);
  // The answer is the last thing in the transcript, so autoscroll lands on it; the live steps/duration
  // elements stay in the DOM but hidden, since no run is in flight.
  assert.equal(await page.locator('#steps-wrap').isHidden(), true);
  assert.equal(await page.locator('#live-duration').isHidden(), true);
  await page.close();
});

test('a run the user stopped reads as the user\'s action, not the agent\'s failure', { skip }, async () => {
  const stopped = {
    ...finished, status: 'stopped',
    messages: [
      finished.messages[0],
      { ...finished.messages[1], text: 'stopped', endedAt: started + 40_000, stopped: true },
    ],
  };
  const page = await panel(stopped);
  assert.equal(await page.locator('.message.agent .steps summary .trace-label').innerText(), 'You stopped after 40s');
  await page.close();
});

test('a run shorter than one second shows no duration divider at all', { skip }, async () => {
  const instant = { ...finished, messages: [finished.messages[0], { ...finished.messages[1], endedAt: started + 400 }] };
  const page = await panel(instant);
  assert.equal(await page.locator('.message.agent .duration').count(), 0);
  await page.close();
});

test('the live trace header shows while the run is in flight, carries the join-sentence as its aria-label, the live ticker and running cost as its label (there is no separate status strip any more), and ticks a "Working" duration once a second has passed', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAgoMs: 2000, messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#steps-wrap').isVisible(), true);
  // Folded from the old #status-text/#cost strip: the trace header is the one place a live run
  // reports on itself now, so it carries the live ticker text and the running cost.
  assert.equal(await page.locator('#steps-label .trace-label').innerText(), `Clicking the "upload" button${SEP}$0.0002`);
  assert.equal(await page.locator('#steps-label').getAttribute('aria-label'), 'Opened tab: ~/upload, clicked the "upload" button');
  assert.equal(await page.locator('.message.agent').count(), 0);
  assert.equal(await page.locator('#live-duration').innerText(), 'Working');
  await page.close();
});

test('the live trace header shows the instant a run starts, before any step has landed', { skip }, async () => {
  const page = await panel({ running: true, status: 'connecting', cost: 0, steps: [], messages: [{ role: 'user', text: 'do it' }] });
  assert.equal(await page.locator('#steps-wrap').isVisible(), true);
  assert.equal(await page.locator('#steps-label .trace-label').innerText(), 'connecting to your tab…');
  assert.equal(await page.locator('#steps-label .tick').count(), 0);
  await page.close();
});

test('the segmented tick track advances as steps land', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAgoMs: 2000, steps: steps.slice(0, 1), messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#steps-label .tick').count(), 1);
  assert.equal(await page.locator('#steps-label .tick.is-done').count(), 1);
  // A second step lands: the track grows by one more filled tick, it does not reset or replace itself.
  await page.evaluate(s => window.onState({ type: 'state', state: s }), { ...finished, running: true, status: 'working', steps, messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#steps-label .tick').count(), 2);
  assert.equal(await page.locator('#steps-label .tick.is-done').count(), 2);
  await page.close();
});

// Palette 4's own caption says "send, ticks, and primary buttons go neutral" — green is reserved
// for the per-step done check, not the trace's tick track. A prior pass shipped the track green.
test('the segmented tick track is neutral (--accent), not the status-success green used by step checks', { skip }, async () => {
  const page = await panel(finished);
  const [tickColor, accent, statusSuccess, glyphColor] = await page.evaluate(() => {
    const tick = document.querySelector('.message.agent .steps .tick.is-done');
    const style = getComputedStyle(document.documentElement);
    return [
      getComputedStyle(tick).backgroundColor,
      style.getPropertyValue('--accent').trim(),
      style.getPropertyValue('--status-success').trim(),
      getComputedStyle(document.querySelector('.status-glyph')).color,
    ];
  });
  assert.notEqual(tickColor, glyphColor, 'the tick fill must not reuse the step-check green');
  const probe = await page.evaluate(([accentValue]) => {
    const el = document.createElement('div'); el.style.color = accentValue; document.body.append(el);
    const rgb = getComputedStyle(el).color; el.remove(); return rgb;
  }, [accent]);
  assert.equal(tickColor, probe, 'the tick fill should resolve to --accent');
  assert.notEqual(accent, statusSuccess);
  await page.close();
});

// Real tasks run 20-40+ actions. The unbounded track (one 8px tick per step, flex:none) overran the
// header at that count and crushed "Worked for 3m" into a one-character-per-line column down the
// panel's right edge. The track is now capped: past 8 steps it stays 8 ticks wide, each tick standing
// for a contiguous run of steps, and the label states the exact count instead.
function manySteps(n, failAt = []) {
  return Array.from({ length: n }, (_, i) => ({
    step: i + 1, plan: `click "next" (${i + 1})`, action: `CLICK [${i}] link "next"`,
    log: { ticker: `Clicking "next" (${i + 1})`, expanded: `Clicked "next" (${i + 1})`, fragment: `clicked "next" (${i + 1})`, fragmentCapitalized: `Clicked "next" (${i + 1})` },
    ...(failAt.includes(i + 1) ? { note: 'action failed: Error: the control is covered or not visible' } : {}),
  }));
}
const longRun = (n, failAt) => {
  const s = manySteps(n, failAt);
  // The reply carries the run's cost, as background.js's terminal message does, so the label is the
  // full three-segment one ("80 steps · Worked for 2m · $0.0002") that actually has to wrap at 320px.
  return { ...finished, steps: s, messages: [finished.messages[0], { ...finished.messages[1], steps: s, cost: finished.cost }] };
};

test('the tick track is bounded at 8 ticks and the label carries the exact step count past that, so the duration stays legible at 320px for 20, 40 and 80 steps', { skip }, async () => {
  for (const n of [20, 40, 80]) {
    const page = await panel(longRun(n), { width: 320 });
    const header = page.locator('.message.agent .trace-header');
    assert.equal(await header.locator('.tick').count(), 8, `${n} steps should render exactly 8 ticks`);
    assert.equal(await header.locator('.trace-label').innerText(), `${n} steps${SEP}Worked for 2m${SEP}$0.0002`);
    const { labelW, headerW, docOverflow } = await page.evaluate(() => ({
      labelW: document.querySelector('.message.agent .trace-label').getBoundingClientRect().width,
      headerW: document.querySelector('.message.agent .trace-header').getBoundingClientRect().width,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    assert.ok(labelW > headerW / 2, `the label must keep most of the header's width at 320px (got ${labelW}px of ${headerW}px)`);
    assert.equal(docOverflow, false, 'no horizontal overflow');
    // The label wraps at this width; no rendered line may start or end on the separator dot.
    const lines = await page.evaluate(() => {
      const label = document.querySelector('.message.agent .trace-label');
      const range = document.createRange(); const out = []; let last = -Infinity; let line = '';
      for (const node of label.childNodes) for (let i = 0; i < node.textContent.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        const { top } = range.getBoundingClientRect();
        if (top > last + 1 && line) { out.push(line); line = ''; }
        last = Math.max(last, top); line += node.textContent[i];
      }
      if (line) out.push(line);
      return out;
    });
    assert.ok(lines.length >= 1 && lines.every(l => !/^\s*·|·\s*$/.test(l)), `no line may open or close on the separator (got ${JSON.stringify(lines)})`);
    assert.ok(lines.join('').includes('$0.0002'), 'the cost is still shown');
    // Past the cap the accessible name is a summary, not an 80-clause sentence.
    assert.equal(await header.getAttribute('aria-label'), `${n} steps: Clicked "next" (1), … clicked "next" (${n})`);
    await page.close();
  }
});

test('at or under 8 steps the track is the approved comp exactly: one tick per step, no count prefix', { skip }, async () => {
  const page = await panel(longRun(8));
  const header = page.locator('.message.agent .trace-header');
  assert.equal(await header.locator('.tick').count(), 8);
  assert.equal(await header.locator('.trace-label').innerText(), `Worked for 2m${SEP}$0.0002`);
  await page.close();
});

test('a failed action is the one thing the track colours: its tick (or, past the cap, the tick covering its run of steps) reads --status-danger', { skip }, async () => {
  // Under the cap: step 3 of 4 failed, so exactly the third tick is red.
  let page = await panel(longRun(4, [3]));
  let flags = await page.evaluate(() => [...document.querySelectorAll('.message.agent .trace-header .tick')].map(t => t.classList.contains('is-failed')));
  assert.deepEqual(flags, [false, false, true, false]);
  // Hollow, not filled: the ring is the danger hue and the fill is gone, so the failed tick is the one
  // unfilled square in the row even without colour.
  const [ring, fill, danger] = await page.evaluate(() => {
    const el = document.createElement('div'); el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--status-danger').trim(); document.body.append(el);
    const rgb = getComputedStyle(el).color; el.remove();
    const cs = getComputedStyle(document.querySelector('.tick.is-failed'));
    return [cs.boxShadow, cs.backgroundColor, rgb];
  });
  assert.ok(ring.includes(danger) && ring.includes('inset'), `failed tick ring should be an inset --status-danger ring (got ${ring})`);
  assert.equal(fill, 'rgba(0, 0, 0, 0)');
  // The failed step's own row says so too: a danger-coloured cross, not the success check.
  await page.locator('.message.agent .trace-header').click();
  const rows = page.locator('.message.agent .step');
  assert.deepEqual(await rows.evaluateAll(els => els.map(e => e.classList.contains('is-failed'))), [false, false, true, false]);
  const [crossColor, checkColor] = await page.evaluate(() => [
    getComputedStyle(document.querySelector('.message.agent .step.is-failed .status-glyph')).color,
    getComputedStyle(document.querySelector('.message.agent .step:not(.is-failed) .status-glyph')).color,
  ]);
  assert.equal(crossColor, danger);
  assert.notEqual(checkColor, danger);
  assert.notEqual(await rows.nth(2).locator('.status-glyph').innerHTML(), await rows.nth(0).locator('.status-glyph').innerHTML(), 'the failed row uses a different glyph, not just a different colour');
  // And the accessible name of the collapsed trace names the failure in words.
  assert.equal(await page.locator('.message.agent .trace-header').getAttribute('aria-label'), 'Clicked "next" (1), clicked "next" (2), clicked "next" (3), clicked "next" (4); 1 failed (step 3)');
  await page.close();
  // Past the cap: 40 steps in 8 ticks of 5; step 27 sits in the sixth tick (steps 26-30) and nowhere else.
  page = await panel(longRun(40, [27]));
  flags = await page.evaluate(() => [...document.querySelectorAll('.message.agent .trace-header .tick')].map(t => t.classList.contains('is-failed')));
  assert.deepEqual(flags, [false, false, false, false, false, true, false, false]);
  await page.close();
  // A retry the loop recovered is not a failure and must not colour the track.
  const recovered = manySteps(4).map((s, i) => (i === 1 ? { ...s, note: 'element vanished before the action; re-tagged the page and retried by name' } : s));
  page = await panel({ ...finished, steps: recovered, messages: [finished.messages[0], { ...finished.messages[1], steps: recovered }] });
  assert.equal(await page.locator('.message.agent .trace-header .tick.is-failed').count(), 0);
  await page.close();
});

test('the live trace header is bounded the same way and prefixes the step count to the ticker', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAgoMs: 2000, steps: manySteps(21, [9]), messages: finished.messages.slice(0, 1) }, { width: 320 });
  assert.equal(await page.locator('#steps-label .tick').count(), 8);
  assert.equal(await page.locator('#steps-label .tick.is-failed').count(), 1);
  assert.equal(await page.locator('#steps-label .trace-label').innerText(), `21 steps${SEP}Clicking "next" (21)${SEP}$0.0002`);
  assert.equal(await page.locator('#steps-label').getAttribute('aria-label'), '21 steps; 1 failed (step 9): Clicked "next" (1), … clicked "next" (21)');
  await page.close();
});

test('monospace is confined to genuine tool output: the row label stays sans, only a raw execution note goes mono', { skip }, async () => {
  const notedSteps = [{ ...steps[0], note: 'jev chose "confirm", corrected to the element the supervisor named' }, steps[1]];
  const page = await panel({ ...finished, steps: notedSteps, messages: [finished.messages[0], { ...finished.messages[1], steps: notedSteps }] });
  // The trace is collapsed at rest, so its content has no rendered box yet; read it structurally
  // (textContent) rather than by rendered innerText, the same way a stylesheet-agnostic check should.
  const row = page.locator('.message.agent .step').first();
  // Labelled like the comp's own tool-output block ("plaintext"), the label living in its own
  // span so the note text itself stays exactly what the agent loop recorded.
  // The trace is collapsed at rest, so read structurally (textContent), not by rendered innerText.
  assert.equal(await row.locator('.tool-output .lang-tag').textContent(), 'plaintext');
  assert.equal(await row.locator('.tool-output').textContent(), 'plaintextjev chose "confirm", corrected to the element the supervisor named');
  assert.match(await row.locator('.tool-output').evaluate(el => getComputedStyle(el).fontFamily), /Plex Mono/i);
  assert.doesNotMatch(await row.locator('.step-label').evaluate(el => getComputedStyle(el).fontFamily), /Plex Mono/i);
  // The second row has no note at all, so it renders no tool-output block whatsoever.
  assert.equal(await page.locator('.message.agent .step').nth(1).locator('.tool-output').count(), 0);
  await page.close();
});

test('a live run younger than one second shows no duration yet', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAgoMs: 0, messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#live-duration').isHidden(), true);
  await page.close();
});

// ---- the pending request card.
const waiting = requests => ({ running: false, status: 'needs_input', cost: 0, steps: [], messages: [{ role: 'user', text: 'do it' }], requests });
// Every answer the panel sends, captured in the page.
const captureSent = page => page.evaluate(() => {
  window.sent = [];
  chrome.runtime.sendMessage = async message => { window.sent.push(message); return { ok: true }; };
});

test('a page that blocked the run says in the panel which check stopped it', { skip }, async () => {
  const page = await panel({ ...finished, status: 'blocked', blockedReason: 'captcha_failed' });
  assert.equal(await page.locator('#blocked').isVisible(), true);
  assert.match(await page.locator('#blocked').innerText(), /captcha/);
  // It gets the same bordered-card treatment as its sibling "needs you" states (ask, approval,
  // credential), not bare caption text: same background and radius as a request card.
  const [blockedBg, blockedRadius] = await page.locator('#blocked').evaluate(el => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.borderRadius];
  });
  const cardStyle = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'notice request-card';
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = [style.backgroundColor, style.borderRadius];
    probe.remove();
    return result;
  });
  assert.deepEqual([blockedBg, blockedRadius], cardStyle);
  // A run that ended cleanly says nothing about being blocked.
  await page.evaluate(s => window.onState({ type: 'state', state: s }), finished);
  assert.equal(await page.locator('#blocked').isHidden(), true);
  await page.close();
});

test('several blocking conditions at once still render one card, the highest priority one', { skip }, async () => {
  const page = await panel(waiting([
    { id: 'plan-1', type: 'plan', question: 'does this plan look right?' },
    { id: 'elicit-1', type: 'elicitation', question: 'which folder?' },
    approvalRequest({ action: 'send the message', origin: 'https://example.test' }),
    { id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'] },
    { id: 'input-1', type: 'user_input', question: 'what name should i put on it?' },
  ]));
  assert.equal(await page.locator('.request-card').count(), 1);
  assert.equal(await page.locator('.request-card').getAttribute('data-request-type'), 'user_input');
  assert.match(await page.locator('.request-question').innerText(), /what name should i put on it/);
  // Drop the winner and the next one down takes the single slot, in priority order.
  await page.evaluate(s => window.onState({ type: 'state', state: s }), waiting([
    { id: 'plan-1', type: 'plan', question: 'does this plan look right?' },
    approvalRequest({ action: 'send the message', origin: 'https://example.test' }),
    { id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'] },
  ]));
  assert.equal(await page.locator('.request-card').count(), 1);
  assert.equal(await page.locator('.request-card').getAttribute('data-request-type'), 'option_picker');
  await page.close();
});

test('a mid-run question offers the choices and a free-text answer beside them', { skip }, async () => {
  const page = await panel(waiting([{ id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'], allowFreeText: true }]));
  assert.deepEqual(await page.locator('.request-options button').allInnerTexts(), ['first', 'second']);
  assert.equal(await page.locator('.request-text').count(), 1);
  await captureSent(page);
  await page.locator('.request-options button').first().click();
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: 'pick-1', outcome: 'submitted', choice: 'first' }]);
  await page.close();
});

test('a picker that allows no answer of its own shows the choices and nothing to type into', { skip }, async () => {
  const page = await panel(waiting([{ id: 'pick-2', type: 'option_picker', question: 'which one?', options: ['first', 'second'] }]));
  assert.deepEqual(await page.locator('.request-options button').allInnerTexts(), ['first', 'second']);
  assert.equal(await page.locator('.request-text').count(), 0);
  // Declining is still on offer: a card with no way out of it is the thing this protocol avoids.
  assert.deepEqual(await page.locator('.request-actions button').allInnerTexts(), ['skip']);
  await page.close();
});

test('an answer already on its way is sent once, however often the button is pressed', { skip }, async () => {
  const page = await panel(waiting([{ id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'], allowFreeText: true }]));
  // Hold the answer in flight, the way a busy worker would.
  await page.evaluate(() => {
    window.sent = [];
    chrome.runtime.sendMessage = async message => { window.sent.push(message); return new Promise(() => {}); };
  });
  const first = page.locator('.request-options button').first();
  await first.click();
  assert.equal(await first.isDisabled(), true);
  await page.locator('.request-options button').nth(1).click({ force: true });
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: 'pick-1', outcome: 'submitted', choice: 'first' }]);
  await page.close();
});

test('the handoff form is typed, starts empty, and keeps nothing once it is sent', { skip }, async () => {
  const request = credentialRequest({
    origin: 'https://example.test',
    fields: [
      { id: 1, label: 'Email', inputType: 'email', required: true },
      { id: 2, label: 'Password', inputType: 'password', required: true },
    ],
    signInOptions: ['Continue with Google'],
    submit: { id: 3, label: 'Sign in' },
  });
  const page = await panel(waiting([request]));
  assert.equal(await page.locator('.request-card').getAttribute('data-request-kind'), 'credential');
  assert.deepEqual(
    await page.locator('.request-field input').evaluateAll(els => els.map(e => [e.type, e.autocomplete, e.value])),
    [['email', 'email', ''], ['password', 'current-password', '']],
  );
  await captureSent(page);
  await page.locator('.request-field input').nth(0).fill('me@pcstyle.dev');
  await page.locator('.request-field input').nth(1).fill('hunter2');
  await page.locator('.request-fields button[type=submit]').click();
  const sent = await page.evaluate(() => window.sent);
  // Keyed by elementId, not label, so two fields sharing a label (e.g. password + confirm) don't collide.
  assert.deepEqual(sent, [{ type: 'answer', id: request.id, outcome: 'submitted', values: { 1: 'me@pcstyle.dev', 2: 'hunter2' } }]);
  // The panel holds no copy of what was typed once it has gone to the worker.
  assert.deepEqual(await page.locator('.request-field input').evaluateAll(els => els.map(e => e.value)), ['', '']);
  await page.close();
});

test('the widest approval scope is confirmed a second time with the warning spelled out', { skip }, async () => {
  const request = approvalRequest({ action: 'act on any site you open', origin: '*' });
  const page = await panel(waiting([request]));
  assert.deepEqual(await page.locator('.request-actions button').allInnerTexts(), ['allow once', 'allow for this conversation', 'always allow', 'deny']);
  await captureSent(page);
  await page.locator('button[data-scope=always]').click();
  assert.deepEqual(await page.evaluate(() => window.sent), [], 'the widest scope is not granted on the first click');
  assert.match(await page.locator('.confirm-warning').innerText(), /any site you open/);
  await page.locator('.request-actions button').first().click();
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: request.id, outcome: 'submitted', scope: 'always' }]);
  // A single-origin approval is granted on the first click, with no second dialog.
  const oneSite = approvalRequest({ action: 'send the message', origin: 'https://example.test' });
  await page.evaluate(s => window.onState({ type: 'state', state: s }), waiting([oneSite]));
  await captureSent(page);
  await page.locator('button[data-scope=always]').click();
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: oneSite.id, outcome: 'submitted', scope: 'always' }]);
  await page.close();
});

test('the approval scope buttons form an even grid at narrow width, not a ragged wrap', { skip }, async () => {
  const page = await panel(waiting([approvalRequest({ action: 'submit the $89.00 order', origin: 'https://example.test' })]), { width: 320 });
  const widths = await page.locator('.request-actions button').evaluateAll(els => els.map(e => e.getBoundingClientRect().width));
  assert.equal(widths.length, 4);
  for (const w of widths) assert.ok(Math.abs(w - widths[0]) <= 1, `every scope button should share one column width, got ${widths}`);
  await page.close();
});

test('a run waiting on the user reads as asking, not as ordinary chat text', { skip }, async () => {
  const page = await panel({
    running: false, status: 'needs_input', steps: [],
    messages: [{ role: 'user', text: 'open the readme' }, { role: 'agent', text: 'which README do you mean?', steps }],
    requests: [{ id: 'ask-1', type: 'user_input', question: 'which README do you mean?' }],
  });
  assert.equal(await page.locator('.message.agent.asking > div').last().innerText(), 'which README do you mean?');
  await page.close();
});

// A pending request used to leave the ordinary chat box fully live: typing "yes" and hitting enter
// silently destroyed the request instead of answering it (the run handler wiped `requests` on a new
// run without declining it first). The composer must go inert, and a submit forced straight at the
// form -- not just a disabled button -- must still be refused.
test('the composer goes inert while a request is pending, and a submit cannot start a run over it', { skip }, async () => {
  const request = { id: 'approve-1', type: 'approval', action: 'submit this $500 order', scopes: [{ id: 'once', label: 'allow once' }], denyLabel: 'deny' };
  const page = await panel(waiting([request]));
  assert.equal(await page.locator('#goal').isDisabled(), true);
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.match(await page.locator('#goal').getAttribute('placeholder'), /answer the request above/);
  await captureSent(page);
  await page.evaluate(() => {
    document.querySelector('#goal').value = 'yes';
    document.querySelector('#task-form').dispatchEvent(new Event('submit', { cancelable: true }));
  });
  assert.deepEqual(await page.evaluate(() => window.sent), [], 'no run message is sent while a request is pending');
  assert.equal(await page.locator('.request-card').count(), 1, 'the pending request card is still there, not silently dropped');
  await page.close();
});

test('once the pending request clears, the composer is available again', { skip }, async () => {
  const page = await panel(waiting([{ id: 'ask-1', type: 'user_input', question: 'which folder?' }]));
  assert.equal(await page.locator('#goal').isDisabled(), true);
  await page.evaluate(s => window.onState({ type: 'state', state: s }), finished);
  assert.equal(await page.locator('#goal').isDisabled(), false);
  assert.equal(await page.locator('#goal').getAttribute('placeholder'), 'Do anything');
  await page.close();
});

test('the transcript keeps riding the real bottom when content settles late, instead of overscrolling past it', { skip }, async () => {
  // Enough messages (each with its own actions block) to make #content scroll — the bug only
  // shows up once scrollHeight actually exceeds clientHeight.
  const longMessages = [];
  for (let i = 0; i < 25; i++) {
    longMessages.push({ role: 'user', text: `do thing number ${i}` });
    longMessages.push({ role: 'agent', text: `done with thing number ${i}; here is a longer answer so the message takes real vertical space in the transcript.`, steps });
  }
  const longFinished = { running: false, status: 'done', cost: 0.01, steps: [], messages: longMessages };
  const page = await panel(longFinished);
  // Let the initial render's own autoscroll settle before simulating anything further.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = await page.evaluate(() => {
    const c = document.querySelector('#content');
    return c.scrollHeight - c.clientHeight - c.scrollTop;
  });
  assert.ok(before <= 1, `first render should already land at the bottom (gap ${before})`);
  // Simulate the real-world trigger: layout settling *after* render() already ran and scrolled —
  // e.g. the Outfit web font swapping in, or a details block finishing its box — which grows the
  // last message without any new render() call to re-trigger the naive one-shot autoscroll.
  await page.evaluate(() => {
    const last = document.querySelector('.message.agent:last-of-type > div');
    last.style.fontSize = '48px';
    last.style.lineHeight = '2';
  });
  // Give the fix a moment to react (ResizeObserver callbacks run on a later microtask/frame).
  await page.waitForFunction(() => {
    const c = document.querySelector('#content');
    return c.scrollHeight - c.clientHeight - c.scrollTop <= 1;
  }, null, { timeout: 2000 }).catch(() => {});
  const after = await page.evaluate(() => {
    const c = document.querySelector('#content');
    return { gap: c.scrollHeight - c.clientHeight - c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
  });
  assert.ok(after.scrollHeight > after.clientHeight, 'test setup should keep the transcript scrollable');
  // (a) no overscroll / no lag: the container tracks the real bottom even after the late growth.
  assert.ok(after.gap <= 1, `scrollTop should still sit at the real bottom after late layout growth (gap ${after.gap})`);
  // (b) the last message's actions toggle is fully visible, not clipped under the composer docked below #content.
  const boxes = await page.evaluate(() => {
    const toggle = document.querySelector('.message.agent:last-of-type .steps');
    const strip = document.querySelector('#task-form');
    return { toggle: toggle.getBoundingClientRect().toJSON(), strip: strip.getBoundingClientRect().toJSON() };
  });
  assert.ok(boxes.toggle.bottom <= boxes.strip.top + 1,
    `actions toggle (bottom ${boxes.toggle.bottom}) should end above the composer (top ${boxes.strip.top})`);
  await page.close();
});

test('clicking new-chat clears the transcript, and a stale broadcast from the finished run cannot resurrect it after', { skip }, async () => {
  const page = await panel(finished);
  assert.equal(await page.locator('.message').count(), 2);
  await page.click('#new-chat');
  // The clear response carries the cleared state, so the transcript empties without waiting on a broadcast.
  await page.waitForFunction(() => document.querySelectorAll('.message').length === 0);
  // Now the race: a stray broadcast from the previous ('finished') run, tagged with an older seq
  // than the clear response, lands after the reset and must not bring the old messages back.
  await page.evaluate(s => window.onState({ type: 'state', state: s, seq: 1 }), finished);
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.message').count(), 0, 'a stale broadcast tagged with an old seq must not resurrect the cleared run');
  await page.close();
});

// The old plum tokens once lived only on .panel-page, so settings.html rendered a different theme
// from the panel. Both now read the same design-4/palette-4 tokens from :root, so they must compute
// to the exact same near-black neutral and the same UI typeface.
test('the settings page renders the same neutral theme as the panel', { skip }, async () => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const store = {};
    window.chrome = {
      storage: { local: { get: async () => ({ ...store }), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {}, removeListener() {} } },
      permissions: { request: async () => true, contains: async () => true },
      runtime: { sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} } },
    };
  });
  await page.goto(`${base}/settings.html`);
  const theme = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { bg: style.backgroundColor, fg: style.color, font: style.fontFamily, scheme: getComputedStyle(document.documentElement).colorScheme };
  });
  assert.equal(theme.bg, 'oklch(0.14 0 0)');
  assert.equal(theme.fg, 'oklch(0.95 0 0)');
  assert.equal(theme.scheme, 'dark');
  assert.match(theme.font, /^Archivo/);
  await page.close();
});

const readyState = { running: false, status: 'ready', messages: [], steps: [] };

// Adopted from the comp: a rounded composer-field (the input alone) sits above a fixed
// composer-actions row ("+", model/mode, send) — not the single morphing pill the shipped build
// used to grow around every control as the textarea wrapped.
test('the composer field grows with the textarea, but the actions row underneath ("+", model pill, send) keeps its own fixed height', { skip }, async () => {
  const page = await panel(readyState);
  const goal = page.locator('#goal');
  const field = page.locator('.composer-field');
  const mention = page.locator('#mention-tabs');
  const fieldHeightBefore = (await field.boundingBox()).height;
  const mentionHeightBefore = (await mention.boundingBox()).height;
  await goal.fill(Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n'));
  const fieldHeightAfter = (await field.boundingBox()).height;
  const mentionHeightAfter = (await mention.boundingBox()).height;
  assert.ok(fieldHeightAfter > fieldHeightBefore + 40, 'the composer-field should grow with a multi-line message');
  assert.ok(Math.abs(mentionHeightAfter - mentionHeightBefore) <= 1, 'the "+" control in the actions row below should not stretch with the field');
  await goal.fill('back to one line');
  const fieldHeightReset = (await field.boundingBox()).height;
  assert.ok(fieldHeightReset < fieldHeightAfter, 'the field should shrink back once the message is one line again');
  await page.close();
});

test('the actions row ("+", model pill, mode, send) stays below the composer field when the composer is disabled by a pending request', { skip }, async () => {
  const page = await panel(waiting([{ id: 'ask-1', type: 'user_input', question: 'which README do you mean?' }]), { width: 320 });
  const goal = page.locator('#goal');
  assert.equal(await goal.isDisabled(), true);
  const [goalBox, mentionBox, sendBox] = await Promise.all([goal.boundingBox(), page.locator('#mention-tabs').boundingBox(), page.locator('#send').boundingBox()]);
  assert.ok(mentionBox.y >= goalBox.y + goalBox.height - 2, '"+" should sit in the actions row under the field, not beside it');
  assert.ok(sendBox.y >= goalBox.y + goalBox.height - 2, 'send should sit in the actions row under the field, not beside it');
  await page.close();
});

// ---- the first-run hero. This is the first thing every user sees; design 4 gives it a real
// hierarchy (eyebrow, headline, lead copy, tab preview, then a labeled row of examples) instead of
// the flat h1-then-card-then-paragraph stack a plain retokening left behind.
test('the first-run hero reads eyebrow, headline, lead, tab preview, then labeled examples, all in design 4\'s neutral tokens', { skip }, async () => {
  const page = await panel(readyState);
  const order = await page.evaluate(() => [...document.querySelector('#intro').children].map(el => el.className));
  assert.deepEqual(order, ['intro-eyebrow', '', 'intro-lead', 'tab-card', 'examples']);
  // text-transform:uppercase renders innerText uppercased; the underlying text content stays lowercase.
  assert.equal(await page.locator('.intro-eyebrow').evaluate(el => el.textContent), 'browser agent');
  assert.equal(await page.locator('.examples-label').innerText(), 'try');
  // The tab-card's hand icon is neutral, chroma-0 tokens now, not the retired plum/peach brand hex
  // (#FFB48A fill / #171020 stroke) the redesign left hardcoded in the markup.
  const [fill, stroke] = await page.locator('.tab-card .hand path').evaluate(el => [el.getAttribute('fill'), el.getAttribute('stroke')]);
  assert.doesNotMatch(fill, /#/, 'the hand icon fill should reference a token, not a hardcoded hex');
  assert.doesNotMatch(stroke, /#/, 'the hand icon stroke should reference a token, not a hardcoded hex');
  // Palette 4 is signal-only: nothing in the empty state may render a hue.
  const [eyebrowColor, h1Color] = await Promise.all([
    page.locator('.intro-eyebrow').evaluate(el => getComputedStyle(el).color),
    page.locator('.intro h1').evaluate(el => getComputedStyle(el).color),
  ]);
  for (const color of [eyebrowColor, h1Color]) assert.match(color, /oklch\([\d.]+ 0 0\)/, `${color} should be chroma-0`);
  await page.close();
});

test('an unconfigured first run shows the connect-a-model notice as a real card, not buried by autoscroll', { skip }, async () => {
  const page = await panel(readyState, { configured: false });
  const setup = page.locator('#setup');
  assert.equal(await setup.isHidden(), false);
  assert.equal(await page.locator('#setup .notice-lead').innerText(), 'connect a model to start');
  assert.match(await page.locator('#setup .muted').innerText(), /API key/);
  // The empty state has nothing to pin to the bottom of; #setup (the first thing in #content) must
  // actually be in view on load, not scrolled off above a hero taller than the viewport.
  const box = await setup.boundingBox();
  assert.ok(box.y >= 0, `#setup should be visible at the top of the panel on load, got y=${box.y}`);
  await page.close();
});

test('a voice partial does not overwrite the composer after the user starts typing', { skip }, async () => {
  const page = await panel(readyState, {
    voice: { enabled: true, mode: 'prewarm', capability: { canTranscribe: true } },
  });
  await page.locator('#mic').click();
  await page.evaluate(() => window.onState({
    type: 'state', seq: 2,
    state: { running: false, status: 'ready', messages: [], steps: [], dictation: { status: 'listening', partialText: 'buy milk' } },
  }));
  assert.equal(await page.locator('#goal').inputValue(), 'buy milk');
  await page.locator('#goal').fill('I typed this myself');
  await page.evaluate(() => window.onState({
    type: 'state', seq: 3,
    state: { running: false, status: 'ready', messages: [], steps: [], dictation: { status: 'listening', partialText: 'buy milk now please' } },
  }));
  assert.equal(await page.locator('#goal').inputValue(), 'I typed this myself');
  await page.close();
});
