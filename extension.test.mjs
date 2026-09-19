import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeSettings, validateSettings, readSettings } from './extension/settings.js';
import { configure, clearConfig, env } from './extension/config.js';
import { ChromePage } from './extension/browser.js';

const event = () => ({ addListener() {}, removeListener() {} });
function chromeMock() {
  const calls = [];
  const chrome = {
    tabs: { update: async () => {}, get: async id => ({ id }) },
    storage: { local: {
      setAccessLevel: async (...args) => calls.push(['access', ...args]),
      get: async () => ({ settings: { openrouterKey: 'local-test-key' } }),
    } },
    debugger: { attach: async (...args) => calls.push(['attach', ...args]), detach: async (...args) => calls.push(['detach', ...args]),
      sendCommand: async (...args) => { calls.push(['command', ...args]); return {}; }, onDetach: event() },
  };
  globalThis.chrome = chrome;
  return { chrome, calls };
}

test('settings read uses trusted local storage, without sync or a server', async () => {
  const { calls } = chromeMock();
  assert.equal((await readSettings()).openrouterKey, 'local-test-key');
  assert.deepEqual(calls, [['access', { accessLevel: 'TRUSTED_CONTEXTS' }]]);
});

test('settings clamp budgets and require the right provider keys', () => {
  const settings = normalizeSettings({ maxSteps: 999, openrouterKey: ' key ', arbitrarySecret: 'ignored' });
  assert.equal(settings.maxSteps, 60);
  assert.equal(settings.openrouterKey, 'key');
  assert.equal(settings.arbitrarySecret, undefined);
  validateSettings(settings);
  assert.throws(() => validateSettings(normalizeSettings({ provider: 'typesafe', mode: 'fast' })), /TypeSafe/);
  const direct = normalizeSettings({ provider: 'typesafe', mode: 'fast', typesafeKey: 'test' });
  validateSettings(direct);
  assert.throws(() => validateSettings(direct, 'careful'), /OpenRouter/);
});

test('provider settings are snapshotted per run and cleared after use', () => {
  const direct = normalizeSettings({ provider: 'typesafe', typesafeKey: 'direct-key', openrouterKey: 'router-key' });
  configure(direct);
  assert.equal(env.TYPESAFE_API_KEY, 'direct-key');
  configure(normalizeSettings({ openrouterKey: 'other-key' }));
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, 'other-key');
  clearConfig();
  assert.deepEqual(env, {});
});

test('Chrome adapter rejects internal tabs before attaching', async () => {
  const { calls } = chromeMock();
  const page = new ChromePage({ id: 1, url: 'chrome://settings' }, new AbortController().signal, []);
  await assert.rejects(page.attach(), /regular website/);
  assert.equal(calls.length, 0);
});

test('Chrome adapter scopes actions to its tab and stops sending after abort', async () => {
  const { calls } = chromeMock();
  const ac = new AbortController();
  const pages = [];
  const page = new ChromePage({ id: 42, url: 'https://example.test' }, ac.signal, pages);
  pages.push(page);
  assert.equal(page.context().pages().length, 0);
  await page.attach();
  assert.deepEqual(page.context().pages(), [page]);
  await page.command('Input.insertText', { text: 'hello' });
  ac.abort();
  const before = calls.length;
  await assert.rejects(page.command('Input.insertText', { text: 'must not type' }), /abort/i);
  assert.equal(calls.length, before);
  await page.detach();
  assert.equal(page.context().pages().length, 0);
  assert.deepEqual(calls.at(-1), ['detach', { tabId: 42 }]);
  assert.ok(calls.filter(c => c[0] === 'command').every(c => c[1].tabId === 42));
});

test('an abort during debugger attachment still leaves a detachable handle', async () => {
  const { chrome, calls } = chromeMock();
  const ac = new AbortController();
  chrome.debugger.attach = async () => ac.abort();
  const page = new ChromePage({ id: 42, url: 'https://example.test' }, ac.signal, []);
  await assert.rejects(page.attach(), /abort/i);
  await page.detach();
  assert.deepEqual(calls, [['detach', { tabId: 42 }]]);
});

test('extension build is self-contained and only permits direct provider connections', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://openrouter.ai/*', 'https://api.typesafe.ai/*']);
  assert.equal(manifest.options_ui.open_in_tab, true);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  const bundle = await readFile('dist/checkto-extension/background.js', 'utf8');
  assert.doesNotMatch(bundle, /from ["'](?:node:|playwright)|import\(["']node:|process\.env|new Function\(/);
});
