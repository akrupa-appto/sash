// Official Playwright extension fixture: a disposable Chromium profile, no existing browser changes.
import { chromium } from 'playwright';
import http from 'node:http';
import { cp, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
await import('./build-extension.mjs');
const builtExtension = path.resolve('dist/sash-extension');
const artifacts = path.resolve('runs/extension-qa');
await mkdir(artifacts, { recursive: true });
const html = await readFile(new URL('../tests/fixtures/extension.html', import.meta.url));
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let fixtureRoot;
let context;
const errors = [];
try {
  // This fixture verifies browser control, not Chrome's optional-permission prompt (covered by
  // access-settings.test.mjs). Headless Chromium cannot accept that browser-owned prompt, so grant
  // only the fixture host in a disposable copy and preserve the built artifact byte-for-byte.
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'sash-extension-'));
  const extension = path.join(fixtureRoot, 'extension');
  await cp(builtExtension, extension, { recursive: true });
  const fixtureManifestPath = path.join(extension, 'manifest.json');
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
  fixtureManifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(fixtureManifestPath, JSON.stringify(fixtureManifest, null, 2) + '\n');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('weberror', error => errors.push(error.error().message));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const settings = await context.newPage();
  const settingsUrl = `chrome-extension://${extensionId}/settings.html`;
  await settings.goto(settingsUrl).catch(err => { if (settings.url() !== settingsUrl) throw err; });
  await settings.waitForLoadState();
  await settings.locator('#openrouterKey').fill('qa-fake-key');
  await settings.getByRole('button', { name: 'save settings', exact: true }).click();
  await settings.waitForFunction(() => document.querySelector('#status').textContent.includes('saved on this device'));
  await settings.reload();
  await settings.waitForFunction(() => document.querySelector('#openrouterKey').value === 'qa-fake-key');
  assert.equal(await settings.locator('#openrouterKey').getAttribute('type'), 'password');
  assert.equal(await settings.evaluate(async () => (await chrome.storage.local.get('settings')).settings.openrouterKey), 'qa-fake-key');
  assert.deepEqual(await settings.evaluate(() => chrome.storage.sync.get(null)), {});
  await settings.screenshot({ path: path.join(artifacts, 'settings.png'), fullPage: true });
  await settings.setViewportSize({ width: 390, height: 844 });
  assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS installed extension: settings save, reload, local-only keys, masked fields, mobile-width layout');

  // Prove the native side panel opens, not just that its HTML can render as a tab.
  const windowId = await settings.evaluate(async () => (await chrome.windows.getCurrent()).id);
  await settings.evaluate(windowId => {
    const button = document.createElement('button'); button.id = 'qa-open-panel'; button.textContent = 'open side panel';
    button.onclick = () => chrome.sidePanel.open({ windowId }).then(() => { globalThis.qaPanelOpened = true; });
    document.body.append(button);
  }, windowId);
  await settings.locator('#qa-open-panel').click();
  await settings.waitForFunction(() => globalThis.qaPanelOpened === true);
  const browserSession = await context.browser().newBrowserCDPSession();
  const targets = (await browserSession.send('Target.getTargets')).targetInfos;
  const nativePanel = targets.find(t => t.url === `chrome-extension://${extensionId}/panel.html`);
  assert.ok(nativePanel);
  // Leave one panel listener for the task checks below. Otherwise the native panel and the panel
  // page fixture can race to answer the worker's site-access request, stranding one prompt.
  await browserSession.send('Target.closeTarget', { targetId: nativePanel.targetId });
  await browserSession.detach();
  await settings.evaluate(async () => { await chrome.sidePanel.setOptions({ enabled: false }); await chrome.sidePanel.setOptions({ enabled: true }); document.querySelector('#qa-open-panel').remove(); });
  console.log('PASS installed extension: native Chrome side panel opens');

  // Mock only provider replies in the real extension worker. Chrome APIs and browser actions remain real.
  await worker.evaluate(() => {
    globalThis.fixtureCalls = [];
    globalThis.fixtureTabs = [];
    chrome.tabs.onCreated.addListener(t => fixtureTabs.push({ id: t.id, opener: t.openerTabId, url: t.url, pendingUrl: t.pendingUrl }));
    globalThis.fixtureScenario = 'fast';
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith('https://openrouter.ai/')) throw new Error('unexpected provider');
      if (options.headers.Authorization !== 'Bearer qa-fake-key') throw new Error('missing local provider key');
      const body = JSON.parse(options.body);
      globalThis.fixtureCalls.push({ url, model: body.model });
      if (globalThis.fixtureScenario === 'stop') {
        return new Promise((_, reject) => {
          options.signal.throwIfAborted();
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      const scenario = globalThis.fixtureScenario;
      const name = scenario === 'careful' ? 'Grace' : 'Ada';
      const plan = scenario === 'careful' ? 'business' : 'team';
      if (String(url).includes('/chat/completions')) {
        const state = JSON.parse(body.messages.find(m => m.role === 'user').content);
        const step = Number(state.step.split(' ')[0]);
        const reply = state.page.text.includes(`saved: ${name} / ${plan}`)
          ? { status: 'done', answer: `saved ${name} on the ${plan} plan` }
          : { status: 'continue', next: [`type ${name} into name`, `select ${plan} in plan`, 'click save'][step - 1], text: step === 1 ? name : undefined };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { cost: 0 } }), { status: 200 });
      }
      const state = body.state;
      const done = state.page.text.includes(`saved: ${name} / ${plan}`);
      const step = Number(state.step.split(' ')[0]);
      const operation = scenario === 'popup' ? (state.page.url.includes('popup=1') ? 'DONE' : 'CLICK') : done ? 'DONE' : ['TYPE_TEXT', 'SELECT', 'CLICK'][step - 1];
      const pick = (question, contains) => Object.entries(body.questions[question]?.criteria || {}).find(([, text]) => text.includes(contains))?.[0];
      const answers = { operation: { choice: operation } };
      if (operation === 'TYPE_TEXT') {
        answers.type_target = { choice: pick('type_target', '"name"') };
        answers.type_value = { choice: pick('type_value', name) };
      }
      if (operation === 'SELECT') answers.select_target = { choice: pick('select_target', `option "${plan}"`) };
      if (operation === 'CLICK') answers.click_target = { choice: pick('click_target', scenario === 'popup' ? '"open details"' : '"save"') };
      return new Response(JSON.stringify({ answers, usage: { cost: 0 } }), { status: 200 });
    };
  });
  const fixture = await context.newPage();
  await fixture.goto(origin);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 390, height: 844 });
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  const tabId = await worker.evaluate(async origin => (await chrome.tabs.query({})).find(t => t.url?.startsWith(origin)).id, origin);
  await panel.locator('#goal').fill('@');
  await panel.locator(`#tab-option-${tabId}`).click();
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal((await worker.evaluate(() => chrome.sidePanel.getPanelBehavior())).openPanelOnActionClick, true);
  await panel.screenshot({ path: path.join(artifacts, 'panel-ready.png') });

  for (const mode of ['fast', 'careful']) {
    await fixture.goto(origin);
    await worker.evaluate(mode => { globalThis.fixtureScenario = mode; }, mode);
    await panel.locator('#mode').selectOption(mode);
    const name = mode === 'careful' ? 'Grace' : 'Ada';
    const plan = mode === 'careful' ? 'business' : 'team';
    await panel.locator('#goal').fill(`type "${name}" into name, select ${plan}, and save`);
    await panel.locator('#send').click();
    await panel.locator('#stop').waitFor({ state: 'visible', timeout: 5000 });
    await panel.locator('#stop').waitFor({ state: 'hidden', timeout: 20000 });
    assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('runState')).runState.status)), 'done');
    assert.equal(await fixture.locator('#result').textContent(), `saved: ${name} / ${plan}`);
    assert.equal(await worker.evaluate(async tabId => { try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }); return true; } catch { return false; } }, tabId), false);
    console.log(`PASS installed extension: ${mode} task saved the intended form state and detached`);
  }
  await panel.screenshot({ path: path.join(artifacts, 'panel-complete.png') });
  await fixture.screenshot({ path: path.join(artifacts, 'completed-form.png') });
  await worker.evaluate(() => { globalThis.fixtureScenario = 'popup'; });
  await panel.locator('#mode').selectOption('fast');
  await panel.locator('#goal').fill('open details in a new tab');
  await panel.locator('#send').click();
  await panel.locator('#stop').waitFor({ state: 'visible', timeout: 5000 });
  await panel.locator('#stop').waitFor({ state: 'hidden', timeout: 20000 });
  const lastState = await worker.evaluate(async () => (await chrome.storage.local.get('runState')).runState);
  assert.equal(lastState.status, 'done', JSON.stringify({ state: lastState, tabs: await worker.evaluate(() => fixtureTabs) }));
  assert.notEqual(lastState.tabId, tabId);
  assert.equal(await worker.evaluate(async id => chrome.tabs.get(id).then(() => true, () => false), lastState.tabId), false);
  console.log('PASS installed extension: follows an opened tab, finishes there, and closes the unmarked agent tab');
  const before = await worker.evaluate(() => fixtureCalls.length);
  await worker.evaluate(() => { globalThis.fixtureScenario = 'stop'; });
  await panel.locator('#goal').fill('wait for a model reply');
  await panel.locator('#send').click();
  for (let i = 0; i < 100; i++) { if (await worker.evaluate(n => fixtureCalls.length > n, before)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  await panel.locator('#stop').click();
  await panel.locator('#stop').waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('runState')).runState.status)), 'stopped');
  assert.equal(await worker.evaluate(async tabId => { try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' }); return true; } catch { return false; } }, tabId), false);
  await settings.getByRole('button', { name: 'remove saved keys' }).click();
  await settings.waitForFunction(() => document.querySelector('#status').textContent.includes('removed'));
  assert.equal(await settings.locator('#openrouterKey').inputValue(), '');
  await settings.reload();
  assert.equal(await settings.locator('#openrouterKey').inputValue(), '');
  assert.equal(await settings.evaluate(async () => (await chrome.storage.local.get('settings')).settings.openrouterKey), '');
  console.log('PASS installed extension: stop cancels an in-flight provider request, detaches, and keys can be removed');
  assert.deepEqual(errors, []);
  console.log(`extension id: ${extensionId}`);
  console.log(`screenshots: ${artifacts}`);
} finally {
  await context?.close();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
