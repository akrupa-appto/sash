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
