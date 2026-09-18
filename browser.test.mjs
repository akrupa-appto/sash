import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { click, settle } from './browser.ts';

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
