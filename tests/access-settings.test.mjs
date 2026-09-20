import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const source = await readFile(new URL('../extension/access-settings.js', import.meta.url), 'utf8');
const browser = await chromium.launch();
after(() => browser.close());
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  await page.setContent('<section id="access-settings"><div id="approval-list"></div><div id="site-access-list"></div><button id="refresh-access">refresh access</button><div id="access-status" role="status"></div></section>');
  await page.evaluate(() => {
    window.calls = [];
    window.grants = [{ key: 'a', action: '<script>send invoice</script>', origin: 'https://example.test', scope: 'always' }, { key: 'b', action: 'delete draft', scope: 'conversation' }];
    window.origins = ['https://openrouter.ai/*', 'https://internal-script.test/*', 'https://example.test/*', 'https://*/*'];
    window.chrome = {
      runtime: {
        getManifest: () => ({
          host_permissions: ['https://openrouter.ai/*'],
          permissions: ['storage'],
          content_scripts: [{ matches: ['https://internal-script.test/*'] }],
        }),
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
      permissions: {
        getAll: async () => ({ origins }),
        remove: async payload => {
          calls.push({ type: 'remove', ...payload });
          if (window.fail) return false;
          window.origins = origins.filter(o => !payload.origins.includes(o)); return true;
        },
      },
    };
  });
  await page.addScriptTag({ type: 'module', content: `${source}\nmountAccessSettings();` });
  await page.waitForFunction(() => document.querySelectorAll('.access-row').length === 4);
  return page;
}
test('approvals show real scopes, render untrusted text safely, and revoke through worker', async () => {
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
test('site removal excludes required hosts and stops task before removing a broad optional grant', async () => {
  const page = await fixture();
  assert.doesNotMatch(await page.locator('#site-access-list').innerText(), /openrouter/);
  assert.doesNotMatch(await page.locator('#site-access-list').innerText(), /internal-script/);
  await page.locator('#site-access-list .access-row').filter({ hasText: 'https://*/*' }).getByRole('button').click();
  await page.waitForFunction(() => document.querySelector('#access-status').textContent.includes('site access revoked'));
  const calls = await page.evaluate(() => window.calls.filter(c => ['stop', 'remove'].includes(c.type)));
  assert.deepEqual(calls, [{ type: 'stop' }, { type: 'remove', origins: ['https://*/*'] }]);
  assert.equal(await page.locator('#approval-list .access-row').count(), 2);
  await page.close();
});
test('failed revocation stays visible, never leaks exceptions, and can be retried', async () => {
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
test('failed task stop never removes site access', async () => {
  const page = await fixture();
  await page.evaluate(() => { window.stopFails = true; });
  await page.locator('#site-access-list button').first().click();
  await page.waitForFunction(() => document.querySelector('#access-status').classList.contains('error'));
  assert.equal(await page.evaluate(() => calls.some(c => c.type === 'remove')), false);
  await page.close();
});
