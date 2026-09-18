import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { click, settle, snapshot } from './browser.ts';

test('a slow navigation gets enough time without repeating the click', async () => {
  let attempts = 0;
  const link = {
    evaluate: async () => null,
    click: async ({ timeout }) => {
      attempts++;
      if (timeout < 8000) throw new Error('locator.click: Timeout exceeded during navigation');
    },
  };
  await click({ url: () => 'https://example.test', locator: () => ({ first: () => link }) }, 1);
  assert.equal(attempts, 1);
});

test('snapshot retries an interrupted read, never a page action', async () => {
  let reads = 0;
  const page = {
    evaluate: async () => {
      if (++reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
      return {url:'https://example.test/next', title:'Next', text:'Saved', scroll:{y:0,max:0}, elements:[]};
    },
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  assert.equal((await snapshot(page)).title, 'Next');
  assert.equal(reads, 2);
});

test('snapshot does not retry unrelated errors', async () => {
  let reads = 0;
  await assert.rejects(snapshot({ evaluate: async () => { reads++; throw new Error('page closed'); } }), /page closed/);
  assert.equal(reads, 1);
});

test('settle waits for requests started shortly after a click', async () => {
  // A client-side click handler starts fetching after a debounce. The old page
  // has already reached networkidle, so waiting on it before that fetch returns
  // immediately, even though the controls are about to be replaced.
  let pending = false;
  let replaced = false;
  const request = (async () => {
    await delay(50);
    pending = true;
    await delay(350);
    replaced = true;
    pending = false;
  })();
  const page = {
    waitForLoadState: async state => {
      if (state === 'networkidle' && pending) await request;
    },
    waitForTimeout: delay,
  };
  try {
    await settle(page);
    assert.equal(replaced, true, 'the next snapshot must see the replacement controls');
  } finally {
    await request;
  }
});

test('click waits for delayed same-tab link navigation before returning', async () => {
  let url = 'https://example.test/list';
  let navigation;
  const link = {
    evaluate: async () => 'https://example.test/file',
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { navigation = delay(50).then(() => { url = 'https://example.test/file'; }); },
  };
  const page = {
    url: () => url,
    locator: () => ({ first: () => link }),
    waitForURL: async predicate => { await navigation; assert.ok(predicate(new URL(url))); },
  };
  try {
    await click(page, 1);
    assert.equal(url, 'https://example.test/file');
  } finally {
    await navigation;
  }
});

test('a failed click is not blindly force-clicked again', async () => {
  let attempts = 0;
  const link = {
    evaluate: async () => null,
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { attempts++; throw new Error('element was replaced'); },
  };
  await assert.rejects(click({ url: () => 'https://example.test', locator: () => ({ first: () => link }) }, 1), /element was replaced/);
  assert.equal(attempts, 1);
});
