import { test } from 'node:test';
import assert from 'node:assert/strict';

const requested = [];
let held = [];
globalThis.chrome = {
  permissions: {
    contains: async ({ origins }) => origins.every(o => held.includes(o)),
    request: async ({ origins }) => { requested.push(origins); held.push(...origins); return true; },
  },
};
const { ensureOriginAccess, ensureAllSitesAccess, originPrompt, allSitesPrompt } = await import('./extension/permissions.js');

const reset = () => { requested.length = 0; held = []; };

test('a single site is asked for with "allow checkto to access {origin}?"', async () => {
  reset();
  const asked = [];
  const ok = await ensureOriginAccess('https://example.test/page?x=1', prompt => { asked.push(prompt); return true; });
  assert.equal(ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 'allow checkto to access https://example.test?');
  assert.equal(asked[0].scope, 'origin');
  assert.deepEqual(requested, [['https://example.test/*']]);
});

test('all-sites access is asked for with distinctly scarier wording than one site', async () => {
  reset();
  const asked = [];
  await ensureAllSitesAccess(prompt => { asked.push(prompt); return true; });
  const all = asked[0];
  const one = originPrompt('https://example.test');
  assert.equal(all.scope, 'all-sites');
  assert.notEqual(all.title, one.title);
  assert.match(all.title, /EVERY site/);
  assert.match(all.detail, /risk/i);
  assert.match(all.allow, /i understand the risk/);
  assert.ok(all.detail.length > one.detail.length, 'the all-sites warning must say more than the single-site one');
  assert.deepEqual(requested, [['https://*/*']]);
});

test('neither request silently succeeds without a prompt', async () => {
  reset();
  await assert.rejects(ensureOriginAccess('https://example.test/'), /needs your permission to use https:\/\/example\.test/);
  await assert.rejects(ensureOriginAccess('https://example.test/', () => false), /allow checkto to access https:\/\/example\.test\?/);
  await assert.rejects(ensureAllSitesAccess(), /does not have access to every site/);
  await assert.rejects(ensureAllSitesAccess(() => false), /does not have access to every site/);
  assert.deepEqual(requested, [], 'chrome.permissions.request must never run without a yes');
});

test('an origin already granted is not asked for again', async () => {
  reset();
  held = ['https://granted.test/*'];
  const ok = await ensureOriginAccess('https://granted.test/deep/link', () => assert.fail('should not ask again'));
  assert.equal(ok, true);
  assert.deepEqual(requested, []);
  assert.equal(allSitesPrompt().scope, 'all-sites');
});
