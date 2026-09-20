// Real Chrome, real manifest: the built extension loaded in a disposable Chromium profile.
// Guards the fact access-settings.js is built on: Chrome reports content_scripts.matches as
// granted host permissions and refuses permissions.remove() for anything they cover.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
const extension = path.resolve('dist/checkto-extension');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, viewport: { width: 760, height: 1400 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
after(() => context.close());
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(worker.url()).host;

test('Chrome treats content-script coverage as required and rejects removing sites inside it', async () => {
  const probe = await worker.evaluate(async () => {
    const { origins } = await chrome.permissions.getAll();
    const attempts = {};
    for (const origin of ['https://example.test/*', 'https://*/*', 'https://openrouter.ai/*']) {
      try { attempts[origin] = { removed: await chrome.permissions.remove({ origins: [origin] }) }; }
      catch (error) { attempts[origin] = { error: String(error.message || error) }; }
    }
    return { origins, attempts };
  });
  assert.ok(probe.origins.includes('http://*/*') && probe.origins.includes('https://*/*'), JSON.stringify(probe.origins));
  for (const [origin, result] of Object.entries(probe.attempts)) {
    assert.match(result.error || '', /cannot remove required permissions/i, `${origin}: ${JSON.stringify(result)}`);
  }
});

test('settings page shows every granted site as required with no revoke button', async () => {
  const page = await context.newPage();
  const url = `chrome-extension://${extensionId}/settings.html`;
  await page.goto(url).catch(error => { if (page.url() !== url) throw error; });
  await page.waitForFunction(() => document.querySelectorAll('#site-access-list .access-row').length >= 6, null, { timeout: 10000 });
  const rows = page.locator('#site-access-list .access-row');
  assert.equal(await rows.count(), await page.locator('#site-access-list .access-row.is-required').count());
  assert.equal(await page.locator('#site-access-list button').count(), 0);
  assert.match(await page.locator('#site-access-list').innerText(), /https:\/\/\*\/\*/);
  assert.equal(await page.locator('#manage-site-access').isEnabled(), true);
  await page.setViewportSize({ width: 390, height: 1400 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.close();
});
