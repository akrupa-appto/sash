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
