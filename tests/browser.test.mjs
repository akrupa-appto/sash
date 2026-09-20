import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { click, settle, snapshot, typeText } from '../src/browser.ts';

test('a slow navigation gets enough time without repeating the click', async () => {
  let attempts = 0;
  const link = {
    evaluate: async () => 'https://example.test/next',
    click: async ({ timeout, noWaitAfter }) => {
      attempts++;
      assert.equal(timeout, 5000);
      if (!noWaitAfter) throw new Error('locator.click: Timeout exceeded during navigation');
    },
  };
  await click({ url: () => 'https://example.test', locator: () => ({ first: () => link }),
    waitForURL: async (_predicate, {timeout}) => { assert.ok(timeout >= 8000); },
  }, 1);
  assert.equal(attempts, 1);
});

test('plain inputs use fill and rich editors keep keyboard events', async () => {
  const calls = [];
  const locator = {
    fill: async text => calls.push(['fill',text]),
    selectText: async () => calls.push(['selectText']),
    press: async key => calls.push(['press',key]),
    pressSequentially: async text => calls.push(['type',text]),
  };
  const page = {locator:()=>({first:()=>locator})};
  await typeText(page,1,'plain',false);
  await typeText(page,1,'rich',true,true);
  assert.deepEqual(calls,[['fill','plain'],['selectText'],['type','rich'],['press','Enter']]);
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

test('snapshot waits for a visible disabled saving button even without a network request', async () => {
  let saved = false;
  const save = delay(400).then(() => { saved = true; });
  const button = {textContent:'Saving…', getAttribute:()=>null, getClientRects:()=>[{}]};
  const page = {
    evaluate: async () => ({busy:!saved, url:'https://example.test', title:'Save', text:saved?'Saved':'Saving…', scroll:{y:0,max:0}, elements:[]}),
    waitForLoadState: async () => {}, waitForTimeout: delay,
    waitForFunction: async fn => {
      const document = {querySelectorAll:()=>saved ? [] : [button]};
      while (!runInNewContext(`(${fn.toString()})()`, {document})) await delay(5);
    },
  };
  try { assert.equal((await snapshot(page)).text, 'Saved'); } finally { await save; }
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
    waitForFunction: async () => {},
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

test('a fragment-only link does not wait for a document navigation', async () => {
  let waited = false;
  const link = { evaluate: async () => 'https://example.test/#', click: async ({ noWaitAfter }) => assert.equal(noWaitAfter, undefined) };
  await click({ url: () => 'https://example.test/', locator: () => ({ first: () => link }), waitForURL: async () => { waited = true; } }, 1);
  assert.equal(waited, false);
});

test('a link whose handler prevents navigation returns once the page changed in place, even at equal length', async () => {
  let text = 'runs list view';
  const link = { evaluate: async () => 'https://example.test/settings', click: async () => { text = 'settings view!'; } };
  assert.equal(text.length, 'settings view!'.length);
  const page = {
    url: () => 'https://example.test/',
    locator: () => ({ first: () => link }),
    evaluate: async () => { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return `${text.length}:${h}`; },
    waitForURL: () => new Promise((_, reject) => setTimeout(() => reject(new Error('page.waitForURL: Timeout 30000ms exceeded.')), 30000).unref()),
  };
  const t0 = Date.now();
  await click(page, 1);
  assert.ok(Date.now() - t0 < 5000);
});
