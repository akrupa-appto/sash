// Capture the real installed extension for the public README.
// Provider replies are mocked; Chrome APIs, the panel, and the page are real.
import { chromium } from 'playwright';
import http from 'node:http';
import { cp, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import './build-extension.mjs';

const builtExtension = path.resolve('dist/sash-extension');
const out = path.resolve('docs/images');
await mkdir(out, { recursive: true });

const demo = await readFile(new URL('../docs/fixtures/demo.html', import.meta.url));
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(demo);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'sash-readme-'));
const videoDir = await mkdtemp(path.join(os.tmpdir(), 'sash-readme-video-'));
let panelWebm = '';
const extension = path.join(fixtureRoot, 'extension');
await cp(builtExtension, extension, { recursive: true });
const manifestPath = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  viewport: { width: 400, height: 720 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 400, height: 720 } },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

async function stack(left, right, dest) {
  execFileSync('ffmpeg', [
    '-y', '-i', left, '-i', right,
    '-filter_complex', '[0]scale=880:720[a];[1]scale=400:720[b];[a][b]hstack=inputs=2,format=yuv420p',
    dest,
  ], { stdio: 'pipe' });
}

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;

  const settings = await context.newPage();
  await settings.setViewportSize({ width: 880, height: 1100 });
  await settings.goto(`chrome-extension://${extensionId}/settings.html`);
  await settings.waitForLoadState();
  await settings.locator('#openrouterKey').fill('qa-fake-key');
  await settings.getByRole('button', { name: 'save settings', exact: true }).click();
  await settings.waitForFunction(() => document.querySelector('#status').textContent.includes('saved on this device'));
  await settings.evaluate(() => window.scrollTo(0, 0));
  await settings.screenshot({ path: path.join(out, 'settings-connections.png') });
  await settings.locator('#access-settings').scrollIntoViewIfNeeded();
  await settings.screenshot({ path: path.join(out, 'settings-access.png') });

  const shop = await context.newPage();
  await shop.setViewportSize({ width: 880, height: 720 });
  await shop.goto(origin);
  await shop.screenshot({ path: path.join(out, 'demo-page.png') });

  await worker.evaluate(() => {
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith('https://openrouter.ai/')) throw new Error('unexpected provider');
      await new Promise(resolve => setTimeout(resolve, 450));
      const body = JSON.parse(options.body);
      const name = 'Ada';
      const plan = 'team';
      if (String(url).includes('/chat/completions')) {
        const state = JSON.parse(body.messages.find(m => m.role === 'user').content);
        const step = Number(state.step.split(' ')[0]);
        const reply = state.page.text.includes(`saved: ${name} / ${plan}`)
          ? { status: 'done', answer: `saved ${name} on the ${plan} plan` }
          : { status: 'continue', next: [`type ${name} into name`, `select ${plan} in plan`, 'click save'][step - 1], text: step === 1 ? name : undefined };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { cost: 0.0004 } }), { status: 200 });
      }
      const state = body.state;
      const done = state.page.text.includes(`saved: ${name} / ${plan}`);
      const step = Number(state.step.split(' ')[0]);
      const operation = done ? 'DONE' : ['TYPE_TEXT', 'SELECT', 'CLICK'][step - 1];
      const pick = (question, contains) => Object.entries(body.questions[question]?.criteria || {}).find(([, text]) => text.includes(contains))?.[0];
      const answers = { operation: { choice: operation } };
      if (operation === 'TYPE_TEXT') {
        answers.type_target = { choice: pick('type_target', '"name"') };
        answers.type_value = { choice: pick('type_value', name) };
      }
      if (operation === 'SELECT') answers.select_target = { choice: pick('select_target', `option "${plan}"`) };
      if (operation === 'CLICK') answers.click_target = { choice: pick('click_target', '"save"') };
      return new Response(JSON.stringify({ answers, usage: { cost: 0.0004 } }), { status: 200 });
    };
  });

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 720 });
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  await panel.waitForSelector('#goal');
  await panel.screenshot({ path: path.join(out, 'panel-intro.png') });

  await panel.locator('#mode').selectOption('careful');
  await panel.locator('#goal').fill('type "Ada" into name, select team, and save');
  await panel.screenshot({ path: path.join(out, 'panel-ready.png') });

  await panel.locator('#send').click();
  await panel.locator('#stop').waitFor({ state: 'visible', timeout: 8000 });
  await panel.locator('#steps-label .tick').first().waitFor({ timeout: 15000 });
  await shop.screenshot({ path: path.join(out, 'demo-working.png') });
  await panel.screenshot({ path: path.join(out, 'panel-working.png') });
  await panel.locator('#stop').waitFor({ state: 'hidden', timeout: 25000 });
  const trace = panel.locator('.message.agent .trace-header');
  if (await trace.count()) await trace.click();
  await panel.screenshot({ path: path.join(out, 'panel-done.png') });
  await shop.screenshot({ path: path.join(out, 'demo-done.png') });

  const panelVideo = panel.video();
  await panel.close();
  await shop.close();
  await settings.close();
  panelWebm = panelVideo ? await panelVideo.path() : '';
} finally {
  await context.close();
  await rm(fixtureRoot, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

await stack(path.join(out, 'demo-working.png'), path.join(out, 'panel-working.png'), path.join(out, 'together-working.png'));
await stack(path.join(out, 'demo-done.png'), path.join(out, 'panel-done.png'), path.join(out, 'together-done.png'));

if (!panelWebm) throw new Error('no panel video recorded');
execFileSync('ffmpeg', [
  '-y', '-i', panelWebm,
  '-vf', 'scale=400:720,format=yuv420p',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-an', path.join(out, 'panel-run.mp4'),
], { stdio: 'pipe' });
await rm(videoDir, { recursive: true, force: true });
for (const extra of ['demo-page.png', 'demo-working.png', 'demo-done.png', 'panel-ready.png', 'panel-working.png', 'settings-access.png']) {
  await rm(path.join(out, extra), { force: true });
}
console.log(`wrote screenshots and panel-run.mp4 to ${out}`);
