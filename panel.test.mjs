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
const finished = {
  running: false, status: 'done', cost: 0.0002, steps,
  messages: [
    { role: 'user', text: 'upload the file' },
    { role: 'agent', text: 'uploaded it; the file URL opens.', steps, startedAt: started, endedAt: started + 125_000, stopped: false },
  ],
};

async function panel(state) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const ev = () => ({ addListener() {}, removeListener() {} });
    window.chrome = {
      runtime: {
        sendMessage: async message => (message.type === 'getState'
          ? { state: { running: false, status: 'ready', messages: [], steps: [] }, configured: true, mode: 'careful', model: 'glm-5.3-flash', reasoning: 'low' }
          : { ok: true }),
        onMessage: { addListener: f => { window.onState = f; } }, openOptionsPage() {},
      },
      tabs: { query: async () => [{ id: 1, url: 'https://example.test/', title: 'Example', active: true, windowId: 1, index: 0 }], onCreated: ev(), onRemoved: ev(), onUpdated: ev(), onActivated: ev() },
      storage: { onChanged: ev() },
    };
  });
  await page.goto(`${base}/panel.html`);
  await page.waitForFunction(() => window.onState);
  await page.evaluate(s => window.onState({ type: 'state', state: s }), state);
  return page;
}

test('a finished run shows its answer after its own actions and their duration, not before them', { skip }, async () => {
  const page = await panel(finished);
  const order = await page.evaluate(() => [...document.querySelector('.message.agent').children].map(el => el.className || el.tagName.toLowerCase()));
  assert.deepEqual(order, ['message-label', 'steps', 'duration', 'div']);
  assert.equal(await page.locator('.message.agent > div').last().innerText(), 'uploaded it; the file URL opens.');
  // The collapsed summary reads as one lowercase-joined sentence, not a step count or a stack trace.
  assert.equal(await page.locator('.message.agent .steps summary').innerText(), 'Opened tab: ~/upload, clicked the "upload" button');
  assert.equal(await page.locator('.message.agent .duration').innerText(), 'Worked for 2m');
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
  assert.equal(await page.locator('.message.agent .duration').innerText(), 'You stopped after 40s');
  await page.close();
});

test('a run shorter than one second shows no duration divider at all', { skip }, async () => {
  const instant = { ...finished, messages: [finished.messages[0], { ...finished.messages[1], endedAt: started + 400 }] };
  const page = await panel(instant);
  assert.equal(await page.locator('.message.agent .duration').count(), 0);
  await page.close();
});

test('the live action list only shows while the run is in flight, and ticks a "Working" duration once a second has passed', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAt: Date.now() - 2000, messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#steps-wrap').isVisible(), true);
  assert.equal(await page.locator('#steps-label').innerText(), 'Opened tab: ~/upload, clicked the "upload" button');
  assert.equal(await page.locator('.message.agent').count(), 0);
  assert.equal(await page.locator('#live-duration').innerText(), 'Working');
  await page.close();
});

test('a live run younger than one second shows no duration yet', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAt: Date.now(), messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#live-duration').isHidden(), true);
  await page.close();
});
