import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

// The content script is all DOM: a canvas favicon swap and a closed shadow root. It is run in a
// real browser against a real page, the same way panel.test.mjs runs the panel.
const bundle = await readFile(join(import.meta.dirname, '..', 'dist/sash-extension/content.js'), 'utf8');
// A flat green icon, served same-origin so the canvas can read the composite back.
const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#00ff00"/></svg>';
const fixture = `<!doctype html><title>Fixture</title><link rel="icon" href="/icon.svg">`;
const server = createServer((req, res) => {
  if (req.url === '/content.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(bundle); }
  if (req.url === '/icon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(icon); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/bare' ? '<!doctype html><title>Bare</title>' : fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// A checkout without `npx playwright install chromium` skips these instead of failing the suite.
const browser = await chromium.launch().catch(() => undefined);
const skip = browser ? false : 'chromium is not installed: npx playwright install chromium';
after(async () => { await browser?.close(); server.close(); });

/** A page with the content script loaded and a chrome stub the test drives it through. */
async function inject(path = '/', pulled = { badge: 'none', observed: false }) {
  const page = await browser.newPage();
  await page.addInitScript(state => {
    window.sent = [];
    window.chrome = {
      runtime: {
        sendMessage: async message => { window.sent.push(message); return { state }; },
        onMessage: { addListener: f => { window.deliver = (m) => new Promise(resolve => f(m, {}, resolve)); } },
      },
    };
  }, pulled);
  await page.goto(base + path);
  await page.addScriptTag({ url: '/content.js' });
  await page.waitForFunction(() => window.deliver);
  return page;
}

const href = page => page.evaluate(() => document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null);
const send = (page, message) => page.evaluate(m => window.deliver(m), message);
const badged = (page, state) => send(page, { type: 'CONTENT_STATE', state });

test('the favicon badge dims the real icon, stashes it, and restores it exactly', { skip }, async () => {
  const page = await inject();
  assert.equal(await href(page), '/icon.svg');
  await badged(page, { badge: 'working' });
  await page.waitForFunction(() => document.querySelector('link[rel~="icon"]').href.startsWith('data:image/png'));
  // The page's own icon is stashed, not thrown away.
  assert.equal(await page.evaluate(() => document.querySelector('link[rel~="icon"]').getAttribute('data-sash-favicon')), '/icon.svg');
  // Dimmed to 0.3: the green source pixel comes back translucent under the glyph.
  const alpha = await page.evaluate(async () => {
    const image = new Image();
    image.src = document.querySelector('link[rel~="icon"]').href;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas.getContext('2d').getImageData(1, 1, 1, 1).data[3];
  });
  assert.ok(alpha > 0 && alpha < 120, `expected a dimmed pixel, got alpha ${alpha}`);

  // Each state paints a different glyph, so the tab strip distinguishes them.
  const png = () => page.evaluate(() => document.querySelector('link[rel~="icon"]').href);
  const working = await png();
  await badged(page, { badge: 'deliverable' });
  await page.waitForFunction(w => document.querySelector('link[rel~="icon"]').href !== w, working);
  const deliverable = await png();
  await badged(page, { badge: 'handoff' });
  await page.waitForFunction(d => document.querySelector('link[rel~="icon"]').href !== d, deliverable);
  assert.notEqual(await png(), deliverable);

  await badged(page, { badge: 'none' });
  assert.equal(await href(page), '/icon.svg');
  assert.equal(await page.evaluate(() => document.querySelector('link[rel~="icon"]').hasAttribute('data-sash-favicon')), false);
  await page.close();
});

test('a page with no icon of its own is left with no icon link behind', { skip }, async () => {
  const page = await inject('/bare');
  assert.equal(await page.evaluate(() => document.querySelectorAll('link[rel~="icon"]').length), 0);
  await badged(page, { badge: 'deliverable' });
  await page.waitForFunction(() => document.querySelector('link[rel~="icon"]')?.href.startsWith('data:image/png'));
  await badged(page, { badge: 'none' });
  assert.equal(await page.evaluate(() => document.querySelectorAll('link[rel~="icon"]').length), 0);
  await page.close();
});

test('the cursor overlay only renders while the tab is the observed one', { skip }, async () => {
  const page = await inject();
  const host = () => page.evaluate(() => document.querySelector('[data-sash-cursor]') !== null);
  // Position is tracked for an unobserved tab; it just is not painted.
  await badged(page, { badge: 'working', observed: false, cursor: { x: 40, y: 60 } });
  assert.equal(await host(), false);

  await badged(page, { badge: 'working', observed: true, cursor: { x: 40, y: 60 } });
  assert.equal(await host(), true);
  assert.deepEqual(await page.evaluate(() => {
    const el = document.querySelector('[data-sash-cursor]');
    const style = getComputedStyle(el);
    return { z: style.zIndex, hidden: el.getAttribute('aria-hidden'), events: style.pointerEvents, closed: el.shadowRoot, transform: el.style.transform };
  }), { z: '2147483646', hidden: 'true', events: 'none', closed: null, transform: 'translate(40px, 60px)' });

  // Page scripts that wipe the overlay out get it put straight back.
  await page.evaluate(() => document.querySelector('[data-sash-cursor]').remove());
  await page.waitForFunction(() => document.querySelector('[data-sash-cursor]') !== null);

  await badged(page, { badge: 'working', observed: false, cursor: { x: 40, y: 60 } });
  assert.equal(await host(), false);
  // Once it is gone the repair stops too, so nothing resurrects it behind the user's back.
  await page.evaluate(() => document.documentElement.appendChild(document.createElement('span')));
  assert.equal(await host(), false);
  await page.close();
});

// The rendered position is read off the computed transform: an inline `transform` is the target,
// the computed one is where the pointer is drawn this frame.
const drawnAt = page => page.evaluate(() => {
  const el = document.querySelector('[data-sash-cursor]');
  if (!el) return null;
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return { x: m.e, y: m.f };
});

test('a second position slides the cursor from the first; the first appears in place', { skip }, async () => {
  const page = await inject();
  await badged(page, { badge: 'working', observed: true, cursor: { x: 100, y: 100 } });
  // No slide in from the corner: a cursor that was not on screen is drawn where it is.
  assert.deepEqual(await drawnAt(page), { x: 100, y: 100 });
  assert.equal(await page.evaluate(() => document.querySelector('[data-sash-cursor]').style.transition), 'none');

  await badged(page, { badge: 'working', observed: true, cursor: { x: 400, y: 300 } });
  // Sampled during the tween: the pointer is somewhere between the two points, on the way.
  const midway = [];
  for (let i = 0; i < 5; i++) { await page.waitForTimeout(30); midway.push(await drawnAt(page)); }
  const between = midway.filter(p => p.x > 100 && p.x < 400 && p.y > 100 && p.y < 300);
  assert.ok(between.length, `expected intermediate frames, saw ${JSON.stringify(midway)}`);
  // Motion touches transform only, at the design's relaxed duration and ease-out curve.
  assert.equal(await page.evaluate(() => document.querySelector('[data-sash-cursor]').style.transition), 'transform 280ms cubic-bezier(0, 0, 0.2, 1)');
  await page.waitForFunction(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('[data-sash-cursor]')).transform).e === 400);
  assert.deepEqual(await drawnAt(page), { x: 400, y: 300 });
  await page.close();
});

test('prefers-reduced-motion snaps the cursor instead of sliding it', { skip }, async () => {
  const page = await inject();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await badged(page, { badge: 'working', observed: true, cursor: { x: 100, y: 100 } });
  await badged(page, { badge: 'working', observed: true, cursor: { x: 400, y: 300 } });
  assert.deepEqual(await drawnAt(page), { x: 400, y: 300 });
  assert.equal(await page.evaluate(() => document.querySelector('[data-sash-cursor]').style.transition), 'none');
  await page.close();
});

test('the cursor does not outlive the page it was aimed at', { skip }, async () => {
  const page = await inject();
  await badged(page, { badge: 'working', observed: true, cursor: { x: 40, y: 60 } });
  assert.notEqual(await drawnAt(page), null);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  assert.equal(await drawnAt(page), null);
  // Dropping the position (what the worker does at end/stop/new chat) removes the overlay too.
  await badged(page, { badge: 'working', observed: true, cursor: { x: 40, y: 60 } });
  await badged(page, { badge: 'deliverable', observed: true, cursor: undefined });
  assert.equal(await drawnAt(page), null);
  await page.close();
});

test('the script answers the liveness ping and pulls its own state on load and on pageshow', { skip }, async () => {
  const page = await inject('/', { badge: 'handoff', observed: true, cursor: { x: 10, y: 10 } });
  assert.deepEqual(await send(page, { type: 'CONTENT_PING' }), { ok: true });
  // It did not wait to be pushed to: the state it is showing came from its own request.
  const asked = await page.evaluate(() => window.sent);
  assert.ok(asked.length >= 1 && asked.every(m => m.type === 'CONTENT_STATE_REQUEST'), JSON.stringify(asked));
  await page.waitForFunction(() => document.querySelector('[data-sash-cursor]') !== null);
  // A bfcache restore replays no scripts, so the overlay state has to be re-pulled here.
  await page.evaluate(() => { window.sent.length = 0; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await page.waitForFunction(() => window.sent.length === 1);
  await page.close();
});
