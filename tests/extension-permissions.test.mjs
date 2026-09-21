import { test } from 'node:test';
import assert from 'node:assert/strict';

// Chrome only grants an optional permission from inside a user gesture, so the panel's Allow
// click is what calls chrome.permissions.request. Here `grant` stands in for that click.
const requested = [];
let held = [];
globalThis.chrome = {
  permissions: {
    contains: async ({ origins }) => origins.every(o => held.includes(o)),
    request: async ({ origins }) => { requested.push(origins); held.push(...origins); return true; },
  },
};
const { ensureOriginAccess, ensureAllSitesAccess, originPrompt, allSitesPrompt } = await import('../extension/permissions.js');

const reset = () => { requested.length = 0; held = []; };
// What the panel does with a prompt: ask Chrome from the click, then answer the worker.
const grant = asked => prompt => { asked.push(prompt); return chrome.permissions.request({ origins: prompt.origins }); };

test('a single site is asked for with "allow sash to access {origin}?"', async () => {
  reset();
  const asked = [];
  const ok = await ensureOriginAccess('https://example.test/page?x=1', grant(asked));
  assert.equal(ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 'allow sash to access https://example.test?');
  assert.equal(asked[0].scope, 'origin');
  assert.deepEqual(asked[0].origins, ['https://example.test/*']);
  assert.deepEqual(requested, [['https://example.test/*']]);
});

test('a site on a non-default port requests Chrome-valid host access while naming the exact origin', async () => {
  reset();
  const asked = [];
  const ok = await ensureOriginAccess('http://127.0.0.1:8799/settings', grant(asked));
  assert.equal(ok, true);
  assert.equal(asked[0].title, 'allow sash to access http://127.0.0.1:8799?');
  assert.match(asked[0].detail, /Chrome grants access to every port on this host\./);
  assert.deepEqual(asked[0].origins, ['http://127.0.0.1/*']);
  assert.deepEqual(requested, [['http://127.0.0.1/*']]);

  const crossPort = await ensureOriginAccess('http://127.0.0.1:8800/other', () => assert.fail('host access should cover another port'));
  assert.equal(crossPort, true);
  assert.deepEqual(requested, [['http://127.0.0.1/*']], 'another port must reuse the host-wide grant');
});

test('all-sites access is asked for with distinctly scarier wording than one site', async () => {
  reset();
  const asked = [];
  await ensureAllSitesAccess(grant(asked));
  const all = asked[0];
  const one = originPrompt('https://example.test');
  assert.equal(all.scope, 'all-sites');
  assert.notEqual(all.title, one.title);
  assert.match(all.title, /EVERY site/);
  assert.match(all.detail, /risk/i);
  assert.match(all.allow, /i understand the risk/);
  assert.ok(all.detail.length > one.detail.length, 'the all-sites warning must say more than the single-site one');
  // sash acts on both http and https tabs, so "all sites" has to request both schemes.
  assert.deepEqual(requested, [['https://*/*', 'http://*/*']]);
});

test('neither request silently succeeds without a prompt', async () => {
  reset();
  await assert.rejects(ensureOriginAccess('https://example.test/'), /needs your permission to use https:\/\/example\.test/);
  await assert.rejects(ensureOriginAccess('https://example.test/', () => false), /allow sash to access https:\/\/example\.test\?/);
  await assert.rejects(ensureAllSitesAccess(), /does not have access to every site/);
  await assert.rejects(ensureAllSitesAccess(() => false), /does not have access to every site/);
  assert.deepEqual(requested, [], 'chrome.permissions.request must never run without a yes');
});

// A yes on its own is not access: the user can still dismiss Chrome's own prompt.
test('a yes that chrome did not actually grant is still a failure', async () => {
  reset();
  await assert.rejects(ensureOriginAccess('https://example.test/', () => true), /chrome did not grant access to https:\/\/example\.test/);
  await assert.rejects(ensureAllSitesAccess(() => true), /try again and accept chrome's prompt/);
  assert.deepEqual(requested, [], 'the caller asking is what runs request, never permissions.js');
});

test('an origin already granted is not asked for again', async () => {
  reset();
  held = ['https://granted.test/*'];
  const ok = await ensureOriginAccess('https://granted.test/deep/link', () => assert.fail('should not ask again'));
  assert.equal(ok, true);
  assert.deepEqual(requested, []);
  assert.equal(allSitesPrompt().scope, 'all-sites');
});
