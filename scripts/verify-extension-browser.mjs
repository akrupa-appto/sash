// Run against the dedicated QA Chrome after chrome-qa start. Uses a temporary tab only.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as b from '../extension/browser.js';
const html = await readFile(new URL('../tests/fixtures/extension.html', import.meta.url));
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const fixture = await browser.contexts()[0].newPage();
let cdp;
try {
  await fixture.goto(origin);
  await fixture.bringToFront();
  // Exercise the same protocol commands that chrome.debugger sends, on a real page.
  globalThis.chrome = {
    tabs: { update: async () => fixture.bringToFront(), get: async () => ({ id: 1, windowId: 1 }) },
    windows: { update: async () => {} },
    debugger: {
      attach: async () => { cdp = await fixture.context().newCDPSession(fixture); },
      detach: async () => cdp.detach(),
      sendCommand: async (_target, method, params) => cdp.send(method, params),
    },
  };
  const ac = new AbortController();
  const pages = [];
  const page = new b.ChromePage({ id: 1, url: origin, title: 'fixture' }, ac.signal, pages);
  pages.push(page);
  await page.attach();
  let snap = await b.snapshot(page);
  const id = name => snap.elements.find(e => e.name === name).id;
  assert.equal(snap.elements.find(e => e.role === 'password').value, undefined);
  assert.ok(!JSON.stringify(snap).includes('must-not-reach-model'));
  await b.typeText(page, id('name'), 'Ada', false);
  await b.typeText(page, id('quantity'), '7', false);
  await b.typeText(page, id('date'), '2026-09-19', false);
  await b.typeText(page, id('note'), 'new note', false);
  await b.selectOption(page, id('plan'), 1);
  await b.click(page, id('save'));
  await b.settle(page);
  const values = await fixture.evaluate(() => ({
    name: document.querySelector('[name=name]').value,
    quantity: document.querySelector('[type=number]').value,
    date: document.querySelector('[type=date]').value,
    note: document.querySelector('[contenteditable]').textContent,
    result: document.querySelector('#result').textContent,
  }));
  assert.deepEqual(values, { name: 'Ada', quantity: '7', date: '2026-09-19', note: 'new note', result: 'saved: Ada / team' });
  console.log('PASS real Chrome: snapshot, password redaction, text/number/date/rich text, select, click, and form result');
  snap = await b.snapshot(page);
  await b.click(page, id('bottom control'));
  assert.equal(await fixture.locator('#bottom').textContent(), 'clicked bottom');
  await b.click(page, id('next page'));
  await b.settle(page);
  assert.match((await b.snapshot(page)).url, /next=1/);
  await page.goBack();
  assert.equal((await b.snapshot(page)).url, origin + '/');
  console.log('PASS real Chrome: offscreen action, navigation, and back');
  ac.abort();
  await assert.rejects(b.click(page, id('save')), /abort/i);
  await page.detach();
  console.log('PASS real Chrome: abort blocks subsequent actions and detach succeeds');
} finally {
  await fixture.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
