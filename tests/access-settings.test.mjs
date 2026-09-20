import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { isRequired, requiredPatterns } from '../extension/access-settings.js';
const source = await readFile(new URL('../extension/access-settings.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
// A checkout without `npx playwright install chromium` skips these instead of failing the suite,
// the same way panel.test.mjs does.
const browser = await chromium.launch().catch(() => undefined);
const skip = browser ? false : 'chromium is not installed: npx playwright install chromium';
after(() => browser?.close());
const fixtureManifest = {
  host_permissions: ['https://openrouter.ai/*'],
  permissions: ['storage'],
  content_scripts: [{ matches: ['https://internal-script.test/*'] }],
};
async function fixture({ manifest = fixtureManifest, origins = ['https://openrouter.ai/*', 'https://internal-script.test/*', 'https://example.test/*', 'https://*/*'], rows = 6 } = {}) {
  const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  await page.setContent('<section id="access-settings"><div id="approval-list"></div><div id="site-access-list"></div><button id="refresh-access">refresh access</button><button id="manage-site-access">open Chrome site access</button><div id="access-status" role="status"></div></section>');
  await page.evaluate(({ manifest, origins }) => {
    window.calls = [];
    window.grants = [{ key: 'a', action: '<script>send invoice</script>', origin: 'https://example.test', scope: 'always' }, { key: 'b', action: 'delete draft', scope: 'conversation' }];
    window.origins = origins;
    window.chrome = {
      runtime: {
        id: 'fixture-extension-id',
        getManifest: () => manifest,
        sendMessage: async message => {
          calls.push(message);
          if (message.type === 'grants:list') return { ok: true, grants };
          if (message.type === 'grants:revoke') {
            if (window.fail) throw new Error('secret-key');
            window.grants = grants.filter(g => g.key !== message.key);
          }
          return { ok: !window.stopFails };
        },
      },
      tabs: { create: (options, done) => { calls.push({ type: 'tabs.create', ...options }); done?.(); } },
      permissions: {
        getAll: async () => ({ origins: window.origins }),
        remove: async payload => {
          calls.push({ type: 'remove', ...payload });
          if (window.fail) return false;
          window.origins = window.origins.filter(o => !payload.origins.includes(o)); return true;
        },
      },
    };
  }, { manifest, origins });
  await page.addScriptTag({ type: 'module', content: `${source}\nmountAccessSettings();` });
  await page.waitForFunction(rows => document.querySelectorAll('.access-row').length === rows, rows);
  return page;
}
test('approvals show real scopes, render untrusted text safely, and revoke through worker', { skip }, async () => {
  const page = await fixture();
  assert.match(await page.locator('#approval-list').innerText(), /this conversation/);
  assert.equal(await page.locator('#approval-list script').count(), 0);
  await page.locator('#approval-list button').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#approval-list .access-row').length === 1);
  assert.deepEqual(await page.evaluate(() => calls.find(c => c.type === 'grants:revoke')), { type: 'grants:revoke', key: 'a' });
  await page.locator('#approval-list button').click();
  await page.waitForFunction(() => document.querySelector('#approval-list').textContent.includes('no saved approvals'));
  await page.close();
});
test('site removal lists required hosts without a revoke button and stops task before removing a broad optional grant', { skip }, async () => {
  const page = await fixture();
  for (const host of ['openrouter.ai', 'internal-script.test']) {
    const locked = page.locator('#site-access-list .access-row.is-required').filter({ hasText: host });
    assert.equal(await locked.count(), 1);
    assert.equal(await locked.locator('button').count(), 0);
    assert.match(await locked.innerText(), /required/);
  }
  assert.equal(await page.locator('#site-access-list .access-row:not(.is-required)').count(), 2);
  await page.locator('#site-access-list .access-row').filter({ hasText: 'https://*/*' }).getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('#access-status').textContent.includes('site access revoked'));
  const calls = await page.evaluate(() => window.calls.filter(c => ['stop', 'remove'].includes(c.type)));
  assert.deepEqual(calls, [{ type: 'stop' }, { type: 'remove', origins: ['https://*/*'] }]);
  assert.equal(await page.locator('#approval-list .access-row').count(), 2);
  await page.locator('#refresh-access').click();
  await page.waitForFunction(() => !document.querySelector('#refresh-access').disabled);
  assert.equal(await page.locator('#site-access-list .access-row').filter({ hasText: 'https://*/*' }).count(), 0);
  await page.close();
});
test('with the real manifest, every http(s) site is required coverage and only Chrome can narrow it', { skip }, async () => {
  // Chrome reports content_scripts.matches from permissions.getAll() and refuses permissions.remove
  // for them and for any narrower site they cover. Offering "revoke" there could only fail.
  const origins = ['https://openrouter.ai/*', 'http://*/*', 'https://*/*', 'https://example.test/*', 'file:///*'];
  const page = await fixture({ manifest, origins, rows: 2 + origins.length });
  const optional = page.locator('#site-access-list .access-row:not(.is-required)');
  assert.equal(await optional.count(), 1);
  assert.match(await optional.innerText(), /file:\/\/\/\*/);
  assert.equal(await page.locator('#site-access-list button').count(), 1);
  assert.equal(await page.locator('#site-access-list .access-row.is-required').filter({ hasText: 'https://example.test/*' }).count(), 1);
  await page.locator('#manage-site-access').click();
  assert.deepEqual(await page.evaluate(() => calls.find(c => c.type === 'tabs.create')), { type: 'tabs.create', url: 'chrome://extensions/?id=fixture-extension-id' });
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'remove')), false);
  await page.close();
});
test('required coverage follows Chrome match-pattern semantics, not string equality', () => {
  const required = requiredPatterns(manifest);
  assert.deepEqual(required, [...manifest.host_permissions, 'http://*/*', 'https://*/*']);
  for (const origin of ['https://example.test/*', 'http://localhost/*', '*://*/*', 'https://*.example.test/*', 'https://openrouter.ai/*']) {
    assert.equal(isRequired(origin, required), true, origin);
  }
  for (const origin of ['file:///*', 'ftp://example.test/*', '<all_urls>']) assert.equal(isRequired(origin, required), false, origin);
  assert.equal(isRequired('https://api.example.test/*', ['https://*.example.test/*']), true);
  assert.equal(isRequired('https://example.test/*', ['https://*.example.test/*']), true);
  assert.equal(isRequired('https://other.test/*', ['https://*.example.test/*']), false);
  assert.equal(isRequired('https://example.test/*', ['http://*/*']), false);
  assert.equal(isRequired('*://example.test/*', ['http://*/*']), false);
  assert.equal(isRequired('https://example.test/*', ['https://example.test/api/*']), false);
  assert.equal(isRequired('ftp://example.test/*', ['<all_urls>']), true);
});
test('failed revocation stays visible, never leaks exceptions, and can be retried', { skip }, async () => {
  const page = await fixture();
  await page.evaluate(() => { window.fail = true; });
  await page.locator('#approval-list button').first().click();
  await page.waitForFunction(() => document.querySelector('#access-status').classList.contains('error'));
  assert.equal(await page.locator('#approval-list .access-row').count(), 2);
  assert.doesNotMatch(await page.locator('body').innerText(), /secret-key/);
  await page.evaluate(() => { window.fail = false; });
  await page.locator('#approval-list button').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#approval-list .access-row').length === 1);
  await page.close();
});
test('failed task stop never removes site access', { skip }, async () => {
  const page = await fixture();
  await page.evaluate(() => { window.stopFails = true; });
  await page.locator('#site-access-list button').first().click();
  await page.waitForFunction(() => document.querySelector('#access-status').classList.contains('error'));
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'remove')), false);
  await page.close();
});
