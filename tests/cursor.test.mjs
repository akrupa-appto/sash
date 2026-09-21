import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import * as b from '../extension/browser.js';

// The agent cursor, end to end, in a real browser: the extension's own action code (browser.js,
// with chrome.debugger standing on a Playwright CDP session) drives the built content script
// (content.js, with a chrome.runtime stub) through the same sink background.js installs. The
// point is to prove an *action* moves the cursor, at the right pixel, before it clicks — not that
// the content script can draw a pointer when handed coordinates (content.test.mjs already does).
const bundle = await readFile(join(import.meta.dirname, '..', 'dist/sash-extension/content.js'), 'utf8');
// A tall page: the control the run wants is well below the fold, so reaching it means scrolling,
// and the cursor's fixed-position coordinates have to agree with the post-scroll click point.
// Every pointerdown is recorded with what it hit, so a click that lands on the wrong thing is
// visible, not just a click that does not land.
const recorder = `<script>
  window.clicks = [];
  document.addEventListener('pointerdown', e => window.clicks.push({ x: e.clientX, y: e.clientY, target: e.target.id, t: performance.now() }));
</script>`;
const fixture = `<!doctype html><title>Cursor fixture</title>
<style>body{margin:0;font:16px system-ui;background:#f4f4f2}#top{margin:24px}#spacer{height:1800px}#target{display:block;margin:0 0 0 120px;padding:14px 22px;font:inherit}</style>
<button id="top">top control</button><div id="spacer"></div><button id="target">buy now</button><div style="height:600px"></div>
${recorder}`;
// Where a navigation during the lead takes the tab: a page that is one big control, so a mouse
// event dispatched at the old coordinates would hit it, and be recorded as hitting it.
const elsewhere = `<!doctype html><title>Elsewhere</title>
<style>body{margin:0}#wrong{position:fixed;inset:0;font:16px system-ui}</style>
<button id="wrong">delete account</button>
${recorder}`;
const server = createServer((req, res) => {
  if (req.url === '/content.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(bundle); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/elsewhere' ? elsewhere : fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch().catch(() => undefined);
const skip = browser ? false : 'chromium is not installed: npx playwright install chromium';
const shots = join(import.meta.dirname, '..', 'runs', 'cursor-lab');
before(async () => { await mkdir(shots, { recursive: true }); });
after(async () => { b.setCursorSink(undefined); await browser?.close(); server.close(); });

/**
 * One controlled tab: a Playwright page with the content script loaded, a ChromePage over it whose
 * chrome.debugger is a CDP session on that same page, and a cursor sink wired the way background.js
 * wires it, except that "push to the content script" is a direct call into the stub and `observed`
 * is whatever the test says it is.
 *
 * `sinkDelay`/`sinkFails` make the delivery itself slow or failing — the two shapes a real tab's
 * feedback push takes — so a test can change the page inside that window. `sinkEntered()` resolves
 * when an action hands the sink its point, i.e. the moment that window opens.
 */
async function controlledTab({ observed = true, reducedMotion = false, sinkDelay = 0, sinkFails = false } = {}) {
  const tab = await browser.newPage({ viewport: { width: 900, height: 600 }, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  await tab.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: async () => ({ state: { badge: 'none', observed: false } }),
        onMessage: { addListener: f => { window.deliver = (m) => new Promise(resolve => f(m, {}, resolve)); } },
      },
    };
  });
  await tab.goto(base + '/');
  await tab.addScriptTag({ url: '/content.js' });
  await tab.waitForFunction(() => window.deliver);
  let cdp;
  globalThis.chrome = {
    tabs: { update: async () => {}, get: async () => ({ id: 7, windowId: 1 }) },
    windows: { update: async () => {} },
    debugger: {
      attach: async () => { cdp = await tab.context().newCDPSession(tab); },
      detach: async () => cdp.detach(),
      sendCommand: async (_target, method, params) => cdp.send(method, params),
    },
  };
  const moves = [];
  const feedback = { badge: 'working', observed, cursor: undefined };
  let sinkWaiters = [];
  const sinkEntered = () => new Promise(resolve => sinkWaiters.push(resolve));
  b.setCursorSink(async (tabId, cursor) => {
    const arrived = sinkWaiters; sinkWaiters = [];
    for (const resolve of arrived) resolve(performance.now());
    // Recorded together with what the page had seen by then: a cursor that arrives after the
    // click is not "before the click" no matter what its coordinates say.
    moves.push({ tabId, cursor, clicksSoFar: await tab.evaluate(() => window.clicks.length) });
    if (sinkDelay) await new Promise(resolve => setTimeout(resolve, sinkDelay));
    if (sinkFails) throw new Error('no receiver for that tab');
    feedback.cursor = cursor;
    await tab.evaluate(m => window.deliver(m), { type: 'CONTENT_STATE', state: { ...feedback } });
    return { ...feedback };
  });
  const ac = new AbortController();
  const pages = [];
  const page = new b.ChromePage({ id: 7, url: base + '/', title: 'Cursor fixture' }, ac.signal, pages);
  pages.push(page);
  const waits = [];
  // `leadEntered()` resolves the moment an action starts its CURSOR_LEAD_MS wait, so a test can act
  // *during* the lead (stop, mutate the page) instead of guessing with a sleep.
  let leadWaiters = [];
  const leadEntered = () => new Promise(resolve => leadWaiters.push(resolve));
  const realWait = page.waitForTimeout.bind(page);
  page.waitForTimeout = ms => {
    waits.push(ms);
    if (ms === b.CURSOR_LEAD_MS) { const w = leadWaiters; leadWaiters = []; for (const resolve of w) resolve(performance.now()); }
    return realWait(ms);
  };
  await page.attach();
  return { tab, page, moves, waits, ac, leadEntered, sinkEntered, close: async () => { await page.detach(); await tab.close(); } };
}
const cursorHost = tab => tab.evaluate(() => {
  const el = document.querySelector('[data-sash-cursor]');
  if (!el) return null;
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: m.e, y: m.f, inline: el.style.transform };
});

test('a click moves the cursor to the control it is about to press, and only then presses it', { skip }, async () => {
  const { tab, page, moves, waits, close } = await controlledTab();
  const snap = await b.snapshot(page);
  const target = snap.elements.find(e => e.name === 'buy now');
  assert.ok(target, 'the fixture control is in the snapshot');
  // Below the fold at rest: the snapshot says so in both forms, and the coordinate is viewport-relative.
  assert.equal(target.inViewport, false);
  assert.equal(target.pos, 'below');
  assert.ok(target.rect.y >= 600, `rect.y ${target.rect.y} should be below a 600px viewport`);
  assert.equal(await cursorHost(tab), null, 'nothing is drawn before an action');

  await b.click(page, target.id);

  const clicks = await tab.evaluate(() => window.clicks);
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].target, 'target', 'the mouse event landed on the control');
  // Exactly one move for one action, sent before the mouse event, to the very pixel it then used.
  assert.equal(moves.length, 1);
  assert.equal(moves[0].tabId, 7);
  assert.equal(moves[0].clicksSoFar, 0, 'the cursor moved before the click, not after');
  assert.ok(Math.abs(moves[0].cursor.x - clicks[0].x) <= 1 && Math.abs(moves[0].cursor.y - clicks[0].y) <= 1,
    `cursor ${JSON.stringify(moves[0].cursor)} vs click ${JSON.stringify(clicks[0])}`);
  // The action waited for the cursor to arrive because the tab is being watched.
  assert.ok(waits.includes(b.CURSOR_LEAD_MS), `waits: ${waits}`);
  // The overlay itself is sitting on the control: fixed-position coordinates match the post-scroll box.
  const host = await cursorHost(tab);
  assert.equal(host.inline, `translate(${moves[0].cursor.x}px, ${moves[0].cursor.y}px)`);
  const over = await tab.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [host.x, host.y]);
  assert.equal(over, 'target', 'the pointer tip is over the control, not over stale pre-scroll coordinates');
  const box = await tab.evaluate(() => { const r = document.querySelector('#target').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  assert.ok(host.x > box.left && host.x < box.right && host.y > box.top && host.y < box.bottom, `cursor ${JSON.stringify(host)} outside ${JSON.stringify(box)}`);
  await tab.screenshot({ path: join(shots, 'after-click.png') });
  await close();
});

test('cursor coordinates track the page as it scrolls, and a move slides from the last position', { skip }, async () => {
  const { tab, page, moves, close } = await controlledTab();
  const before = await b.snapshot(page);
  const at = (snap, name) => snap.elements.find(e => e.name === name);
  assert.equal(at(before, 'top control').inViewport, true);
  // Scroll and read the same control again: its viewport box moved up by exactly the scroll delta.
  await b.scroll(page, 'down');
  const afterScroll = await b.snapshot(page);
  const delta = afterScroll.scroll.y - before.scroll.y;
  assert.ok(delta > 0, 'the page scrolled');
  assert.equal(at(afterScroll, 'buy now').rect.y, at(before, 'buy now').rect.y - delta);
  assert.equal(at(afterScroll, 'top control').inViewport, false);
  assert.equal(at(afterScroll, 'top control').pos, 'above');

  // First action: the cursor appears in place (no slide in from the corner). Second action on a
  // control the page has to scroll back up to: the cursor slides there from where it was, and the
  // coordinates it is given are the control's *new* viewport position, not the one before the scroll.
  await b.click(page, at(afterScroll, 'buy now').id);
  const first = await cursorHost(tab);
  const clicksBefore = await tab.evaluate(() => window.clicks.length);
  const midway = [];
  const clickTop = b.click(page, at(afterScroll, 'top control').id);
  // Sample the rendered position while the action is still waiting on the tween.
  for (let i = 0; i < 6; i++) { await tab.waitForTimeout(40); midway.push(await cursorHost(tab)); }
  await clickTop;
  const clicks = await tab.evaluate(() => window.clicks);
  assert.equal(clicks.length, clicksBefore + 1);
  const move = moves.at(-1).cursor;
  assert.ok(Math.abs(move.x - clicks.at(-1).x) <= 1 && Math.abs(move.y - clicks.at(-1).y) <= 1, 'second click used the moved cursor point');
  assert.equal(clicks.at(-1).target, 'top');
  const between = midway.filter(p => p && p.y !== first.y && p.y !== move.y);
  assert.ok(between.length, `expected intermediate positions between ${first.y} and ${move.y}, saw ${JSON.stringify(midway.map(p => p?.y))}`);
  const rest = await cursorHost(tab);
  assert.equal(rest.y, move.y, 'the cursor came to rest on the target');
  await tab.screenshot({ path: join(shots, 'after-scroll-click.png') });
  await close();
});

test('an unobserved tab tracks the cursor but spends no lead time and paints nothing', { skip }, async () => {
  const { tab, page, moves, waits, close } = await controlledTab({ observed: false });
  const snap = await b.snapshot(page);
  await b.click(page, snap.elements.find(e => e.name === 'buy now').id);
  assert.equal(moves.length, 1, 'the position is still tracked for a tab nobody is watching');
  assert.equal(await cursorHost(tab), null, 'but it is not drawn');
  assert.ok(!waits.includes(b.CURSOR_LEAD_MS), `no one is watching, so nothing waits for the tween: ${waits}`);
  assert.equal((await tab.evaluate(() => window.clicks)).length, 1);
  await close();
});

test('type and select move the cursor too, and stop aborts the action while the cursor is still travelling', { skip }, async () => {
  const { tab, page, moves, ac, leadEntered, close } = await controlledTab();
  await tab.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin', '<input aria-label="email"><select aria-label="plan"><option>a</option><option>b</option></select>');
  });
  const snap = await b.snapshot(page);
  const id = name => snap.elements.find(e => e.name === name).id;
  await b.typeText(page, id('email'), 'a@b.c', false);
  await b.selectOption(page, id('plan'), 1);
  assert.deepEqual(moves.map(m => m.tabId), [7, 7]);
  assert.equal(await tab.evaluate(() => document.querySelector('[aria-label=email]').value), 'a@b.c');
  // Stop mid-travel: the abort has to cut the lead wait short, not be noticed after it. So the
  // rejection is timed from the moment the wait began, and it must arrive well inside the 320ms
  // the wait would otherwise have taken.
  const entered = leadEntered();
  const clicking = b.click(page, id('buy now'));
  const startedAt = await entered;
  ac.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(clicking, /stopped|abort/i);
  const rejectedAfter = performance.now() - startedAt;
  assert.ok(rejectedAfter < b.CURSOR_LEAD_MS / 2, `the abort should end the lead wait at once, not after it: ${rejectedAfter.toFixed(0)}ms`);
  assert.equal((await tab.evaluate(() => window.clicks)).length, 0, 'a stopped action never presses the control');
  await close();
});

// --- the lead time is a window the page can change in ---------------------------------------
// The coordinates were right when point() read them. Anything that makes them wrong before the
// mouse event is dispatched (the control moves, something covers it, the tab navigates) must be
// caught by the action, which rejects instead of pressing whatever is now under the pointer.
const stale = /page changed while the cursor was moving/;

test('a replacement carrying the same snapshot index during the lead is rejected', { skip }, async () => {
  const { tab, page, leadEntered, close } = await controlledTab();
  const snap = await b.snapshot(page);
  const target = snap.elements.find(e => e.name === 'buy now');
  const entered = leadEntered();
  const clicking = b.click(page, target.id);
  await entered;
  // A re-render that swaps the control for a copy. The copy carries the snapshot's own index
  // attribute and occupies the same box, so a re-check that looks the control up by that attribute
  // finds a fine control to press — just not the one the coordinates were read from.
  assert.equal(await tab.evaluate(id => {
    const el = document.querySelector('#target');
    const copy = el.cloneNode(true);
    el.replaceWith(copy);
    return copy.getAttribute('data-jev-idx') === id && copy.isConnected;
  }, String(target.id)), true, 'the copy carries the index attribute and is the only #target left');
  await assert.rejects(clicking, stale);
  assert.deepEqual(await tab.evaluate(() => window.clicks), [], 'the copy was not pressed');
  await close();
});

test('a control repurposed in place during the lead is rejected', { skip }, async () => {
  const { tab, page, leadEntered, close } = await controlledTab();
  const snap = await b.snapshot(page);
  const entered = leadEntered();
  const clicking = b.click(page, snap.elements.find(e => e.name === 'buy now').id);
  await entered;
  // The same element, still where it was, still carrying the same index attribute — and now the one
  // thing on the page a plan for "buy now" must not touch.
  await tab.evaluate(() => { document.querySelector('#target').textContent = 'delete account'; });
  await assert.rejects(clicking, err => {
    assert.match(err.message, stale);
    assert.match(err.message, /delete account/, `the reason names what the control is now: ${err.message}`);
    return true;
  });
  assert.deepEqual(await tab.evaluate(() => window.clicks), [], 'the repurposed control was not pressed');
  await close();
});

// --- the delivery itself is a window, watched or not ----------------------------------------
// Handing the point to the sink is an awaited round trip through the worker to the tab's content
// script: recorded, persisted, pinged, pushed. The tab being unobserved only means nobody would see
// the cursor arrive — it does not make that window any shorter, so the recheck cannot depend on it,
// and a delivery that fails is still time the page had.

test('a slow cursor delivery on an unobserved tab still revalidates before the click', { skip }, async () => {
  const { tab, page, waits, moves, sinkEntered, close } = await controlledTab({ observed: false, sinkDelay: 300 });
  const snap = await b.snapshot(page);
  const entered = sinkEntered();
  const clicking = b.click(page, snap.elements.find(e => e.name === 'buy now').id);
  await entered;
  await tab.evaluate(() => {
    const el = document.querySelector('#target');
    el.replaceWith(el.cloneNode(true));
  });
  await assert.rejects(clicking, stale);
  assert.deepEqual(await tab.evaluate(() => window.clicks), [], 'the copy that landed mid-delivery was not pressed');
  assert.equal(moves.length, 1, 'the position was still tracked for the tab nobody is watching');
  assert.ok(!waits.includes(b.CURSOR_LEAD_MS), `the guard is not the tween wait, which an unobserved tab skips: ${waits}`);
  await close();
});

test('a rejected cursor delivery still revalidates before the click', { skip }, async () => {
  const { tab, page, sinkEntered, close } = await controlledTab({ sinkDelay: 200, sinkFails: true });
  const snap = await b.snapshot(page);
  const entered = sinkEntered();
  const clicking = b.click(page, snap.elements.find(e => e.name === 'buy now').id);
  await entered;
  await tab.evaluate(() => { document.querySelector('#target').textContent = 'delete account'; });
  await assert.rejects(clicking, err => {
    assert.match(err.message, stale);
    assert.ok(!/no receiver/.test(err.message), `the sink's own failure never reaches the action: ${err.message}`);
    return true;
  });
  assert.deepEqual(await tab.evaluate(() => window.clicks), [], 'the repurposed control was not pressed');
  await close();
});

test('the control moving during the lead rejects the click instead of pressing what took its place', { skip }, async () => {
  const { tab, page, leadEntered, close } = await controlledTab();
  const snap = await b.snapshot(page);
  const entered = leadEntered();
  const clicking = b.click(page, snap.elements.find(e => e.name === 'buy now').id);
  await entered;
  // A re-render: the target is pushed down and a different control now sits exactly where it was.
  await tab.evaluate(() => {
    const target = document.querySelector('#target');
    const r = target.getBoundingClientRect();
    const decoy = document.createElement('button');
    decoy.id = 'decoy'; decoy.textContent = 'cancel order';
    decoy.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:1;font:inherit`;
    target.style.marginTop = '200px';
    document.body.appendChild(decoy);
  });
  await assert.rejects(clicking, stale);
  assert.deepEqual(await tab.evaluate(() => window.clicks), [], 'nothing was pressed: not the decoy, not the moved control');
  await close();
});

test('an overlay covering the control during the lead rejects the click', { skip }, async () => {
  const { tab, page, leadEntered, close } = await controlledTab();
  const snap = await b.snapshot(page);
  const entered = leadEntered();
  const clicking = b.click(page, snap.elements.find(e => e.name === 'buy now').id);
  await entered;
  await tab.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:10"><button id="modal-ok" style="position:absolute;inset:40%">ok</button></div>');
  });
  await assert.rejects(clicking, stale);
  assert.deepEqual(await tab.evaluate(() => window.clicks), [], 'the dialog and what it covers are both untouched');
  await close();
});

test('the tab navigating during the lead rejects the click; the new document is never pressed at old coordinates', { skip }, async () => {
  const { tab, page, leadEntered, close } = await controlledTab();
  const snap = await b.snapshot(page);
  const entered = leadEntered();
  const clicking = b.click(page, snap.elements.find(e => e.name === 'buy now').id);
  await entered;
  await tab.evaluate(url => { location.href = url; }, base + '/elsewhere');
  await tab.waitForURL(base + '/elsewhere');
  // The new document has no `data-jev-idx` from the old one, and the message stays one plain line.
  await assert.rejects(clicking, err => { assert.match(err.message, stale); assert.match(err.message, /no longer available/); assert.ok(!err.message.includes('\n'), err.message); return true; });
  assert.equal(await tab.title(), 'Elsewhere');
  assert.deepEqual(await tab.evaluate(() => window.clicks), [], 'the full-page control on the new document was not pressed');
  await close();
});

test('the planner payload never carries coordinates', { skip }, async () => {
  const { page, close } = await controlledTab();
  const snap = await b.snapshot(page);
  assert.ok(snap.elements.every(e => e.rect), 'coordinates are on the snapshot');
  // describe() is the only path an element takes into a planner or executor prompt (src/agent.ts).
  for (const e of snap.elements) assert.equal(b.describe(e), `[${e.id}] ${e.role} "${e.name}"`);
  await close();
});
