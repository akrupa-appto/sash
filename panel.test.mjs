import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

// The panel is rendered in a real browser: the bug this guards against was DOM order, not logic.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const root = join(import.meta.dirname, 'dist/checkto-extension');
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
  { step: 1, plan: 'switch to the upload tab', action: 'opened tab: ~/upload' },
  { step: 2, plan: 'click the "upload" button', action: 'CLICK [5] button "upload"' },
];
const finished = {
  running: false, status: 'done', cost: 0.0002, steps,
  messages: [{ role: 'user', text: 'upload the file' }, { role: 'agent', text: 'uploaded it; the file URL opens.', steps }],
};

async function panel(state) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const ev = () => ({ addListener() {}, removeListener() {} });
    window.chrome = {
      runtime: {
        sendMessage: async message => (message.type === 'getState'
          ? { state: { running: false, status: 'ready', messages: [], steps: [] }, configured: true, mode: 'careful', model: 'glm-5.3-flash', reasoning: 'low', seq: 0 }
          : message.type === 'clear'
            ? { ok: true, state: { running: false, messages: [], steps: [], status: 'ready' }, seq: 999 }
            : { ok: true }),
        onMessage: { addListener: f => { window.onState = f; } }, openOptionsPage() {},
      },
      tabs: { query: async () => [{ id: 1, url: 'https://example.test/', title: 'Example', active: true, windowId: 1, index: 0 }], onCreated: ev(), onRemoved: ev(), onUpdated: ev(), onActivated: ev() },
      storage: { onChanged: ev() },
    };
  });
  await page.goto(`${base}/panel.html`);
  await page.waitForFunction(() => window.onState);
  await page.evaluate(s => window.onState({ type: 'state', state: s, seq: 1 }), state);
  return page;
}

test('a finished run shows its answer after its own actions, not before them', { skip }, async () => {
  const page = await panel(finished);
  const order = await page.evaluate(() => [...document.querySelector('.message.agent').children].map(el => el.className || el.tagName.toLowerCase()));
  assert.deepEqual(order, ['message-label', 'steps', 'div']);
  assert.equal(await page.locator('.message.agent > div').last().innerText(), 'uploaded it; the file URL opens.');
  assert.equal(await page.locator('.message.agent .steps summary').innerText(), '2 actions');
  // The answer is the last thing in the transcript, so autoscroll lands on it.
  assert.equal(await page.evaluate(() => document.querySelector('#content').lastElementChild.id), 'steps-wrap');
  assert.equal(await page.locator('#steps-wrap').isHidden(), true);
  await page.close();
});

test('a run that stopped on a question shows it as waiting for an answer', { skip }, async () => {
  const page = await panel({
    running: false, status: 'question', steps: [],
    messages: [{ role: 'user', text: 'open the readme' }, { role: 'agent', text: 'which README do you mean?', steps }],
  });
  assert.equal(await page.locator('#status-text').innerText(), 'waiting for an answer');
  assert.equal(await page.locator('.message.agent.asking > div').last().innerText(), 'which README do you mean?');
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
  // (b) the last message's actions toggle is fully visible, not clipped under the status strip below #content.
  const boxes = await page.evaluate(() => {
    const toggle = document.querySelector('.message.agent:last-of-type .steps');
    const strip = document.querySelector('#run-status');
    return { toggle: toggle.getBoundingClientRect().toJSON(), strip: strip.getBoundingClientRect().toJSON() };
  });
  assert.ok(boxes.toggle.bottom <= boxes.strip.top + 1,
    `actions toggle (bottom ${boxes.toggle.bottom}) should end above the status strip (top ${boxes.strip.top})`);
  await page.close();
});

test('clicking new-chat resets the status strip to ready, even if a stale broadcast from the finished run arrives after', { skip }, async () => {
  const page = await panel(finished);
  assert.equal(await page.locator('#status-text').innerText(), 'finished');
  await page.click('#new-chat');
  // The clear response carries the cleared state, so the strip resets without waiting on a broadcast.
  await page.waitForFunction(() => document.querySelector('#status-text').textContent === 'ready when you are');
  // Now the race: a stray broadcast from the previous ('finished') run, tagged with an older seq
  // than the clear response, lands after the reset and must not flash the old status back.
  await page.evaluate(s => window.onState({ type: 'state', state: s, seq: 1 }), finished);
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#status-text').innerText(), 'ready when you are');
  await page.close();
});

// The plum tokens once lived on .panel-page, so settings.html rendered the old cream theme.
test('the settings page renders the same plum theme as the panel', { skip }, async () => {
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
  assert.equal(theme.bg, 'rgb(23, 16, 32)');
  assert.equal(theme.fg, 'rgb(245, 235, 240)');
  assert.equal(theme.scheme, 'dark');
  assert.match(theme.font, /^Outfit/);
  await page.close();
});

test('the live action list only shows while the run is in flight', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#steps-wrap').isVisible(), true);
  assert.equal(await page.locator('#steps-label').innerText(), '2 actions');
  assert.equal(await page.locator('.message.agent').count(), 0);
  await page.close();
});

const readyState = { running: false, status: 'ready', messages: [], steps: [] };

test('the compose box is a full pill for a single-line message and steps down once the textarea wraps to multiple lines', { skip }, async () => {
  const page = await panel(readyState);
  const box = page.locator('.compose-box');
  const goal = page.locator('#goal');
  const radius = async () => box.evaluate(el => getComputedStyle(el).borderRadius);
  assert.equal(await radius(), '999px');
  await goal.fill('one\ntwo\nthree');
  assert.equal(await radius(), '20px');
  await goal.fill('back to one line');
  assert.equal(await radius(), '999px');
  await page.close();
});

test('the @ and send buttons sit at the bottom of a tall compose box, next to the caret, not centered', { skip }, async () => {
  const page = await panel(readyState);
  const goal = page.locator('#goal');
  await goal.fill(Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n'));
  const [goalBox, mentionBox, sendBox] = await Promise.all([
    goal.boundingBox(), page.locator('#mention-tabs').boundingBox(), page.locator('#send').boundingBox(),
  ]);
  assert.ok(goalBox.height > 60, 'the textarea should have grown across several lines');
  for (const button of [mentionBox, sendBox]) {
    assert.ok(Math.abs((button.y + button.height) - (goalBox.y + goalBox.height)) <= 4, 'button bottom should align with the textarea bottom, not float in the middle');
  }
  await page.close();
});
