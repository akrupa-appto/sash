import { collectSnapshot, pageReady } from '../src/snapshot.js';

export function supportedUrl(url) {
  return /^https?:\/\//i.test(url || '') && !/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:\/|$)/i.test(url || '');
}

// Serialize this function into the page just like collectSnapshot. App content often
// scrolls inside a pane while the document and its fixed sidebar do not scroll.
function scrollState() {
  const root = document.scrollingElement || document.documentElement;
  let target = root;
  let area = root.scrollHeight > root.clientHeight + 4 ? innerWidth * innerHeight : 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el === root || el.clientHeight < 80 || el.scrollHeight <= el.clientHeight + 4) continue;
    const style = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(style.overflowY) || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const width = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
    const height = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
    const size = width * height;
    if (size > area) { target = el; area = size; }
  }
  document.querySelectorAll('[data-sash-scroll]').forEach(el => el.removeAttribute('data-sash-scroll'));
  target.setAttribute('data-sash-scroll', 'true');
  return { y: Math.round(target.scrollTop), max: Math.max(0, target.scrollHeight - target.clientHeight) };
}

export class ChromePage {
  constructor(tab, signal, pages) {
    this.tabId = tab.id;
    this.currentUrl = tab.url;
    this.currentTitle = tab.title || '';
    this.signal = signal;
    this.pages = pages;
    this.attached = false;
    this.initialized = false;
  }
  url() { return this.currentUrl; }
  async title() { this.currentTitle = await this.evaluate(() => document.title); return this.currentTitle; }
  context() { return { pages: () => this.pages.filter(p => p.attached && p.initialized) }; }
  async attach() {
    this.signal.throwIfAborted();
    if (!supportedUrl(this.currentUrl)) throw new Error('open a regular website first; Chrome settings, the web store, and extension pages cannot be controlled');
    await chrome.tabs.update(this.tabId, { active: true });
    const tab = await chrome.tabs.get(this.tabId);
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    this.signal.throwIfAborted();
    try { await chrome.debugger.attach({ tabId: this.tabId }, '1.3'); }
    catch (err) {
      // Keep Chrome's reason; only blame DevTools or another debugger when that is what Chrome said.
      if (/chrome-extension:/.test(err.message)) throw new Error(`could not control this tab: it is showing a page from another Chrome extension. switch it back to the website you want, then try again.`);
      if (/already attached|debugger|devtools/i.test(err.message)) throw new Error(`could not control this tab: ${err.message}. close DevTools or another browser-control extension on this tab, then try again.`);
      throw new Error(`could not control this tab: ${err.message}. choose another website tab and try again.`);
    }
    this.attached = true;
    this.signal.throwIfAborted();
    await this.command('Page.enable');
    this.initialized = true;
  }
  async detach() {
    if (this.attached) {
      this.attached = false;
      this.initialized = false;
      await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
    }
  }
  async command(method, params = {}) {
    this.signal.throwIfAborted();
    if (!this.attached) throw new Error('browser control disconnected');
    const result = await chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
    this.signal.throwIfAborted();
    return result;
  }
  async evaluate(fn, arg) {
    // A new isolated world is resolved on each read, so navigation cannot leave a stale context.
    const { frameTree } = await this.command('Page.getFrameTree');
    const frame = frameTree.frame;
    if (!supportedUrl(frame.url)) throw new Error('this page cannot be controlled; return to a regular website');
    this.currentUrl = frame.url;
    const { executionContextId } = await this.command('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'sash' });
    const result = await this.command('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`,
      contextId: executionContextId, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  async waitForTimeout(ms) {
    this.signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const done = () => { this.signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, ms);
      const abort = () => { clearTimeout(timer); reject(this.signal.reason); };
      this.signal.addEventListener('abort', abort, { once: true });
    });
  }
  async ready(timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await this.evaluate(() => document.readyState !== 'loading')) return; }
      catch (err) { if (this.signal.aborted) throw err; }
      await this.waitForTimeout(150);
    }
    throw new Error('the page is still loading');
  }
  async goto(url) {
    if (!supportedUrl(url)) throw new Error('use an http or https website');
    const result = await this.command('Page.navigate', { url });
    if (result.errorText) throw new Error(result.errorText);
    this.currentUrl = url;
    await this.ready(30000);
  }
  async reload() { await this.command('Page.reload'); await this.ready(30000); }
  async goBack() {
    const history = await this.command('Page.getNavigationHistory');
    if (history.currentIndex > 0) {
      await this.command('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id });
      await this.ready(30000);
    }
  }
}

export function describe(e) {
  return `[${e.id}] ${e.role} "${e.name}"${e.value ? ` = "${e.value}"` : ''}`;
}
export async function snapshot(page) {
  let raw;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await page.evaluate(collectSnapshot, 240);
      if (raw.busy) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !(await page.evaluate(pageReady))) await page.waitForTimeout(200);
        raw = await page.evaluate(collectSnapshot, 240);
      }
      break;
    } catch (err) {
      if (attempt >= 2 || !/context|frame|navigat/i.test(err.message) || page.signal.aborted) throw err;
      await page.waitForTimeout(200);
    }
  }
  // Existing login fields must never disclose their values to a model.
  raw.scroll = await page.evaluate(scrollState);
  for (const e of raw.elements) if (e.role === 'password') e.value = undefined;
  page.currentUrl = raw.url;
  page.currentTitle = raw.title;
  const input = raw.url + Math.round(raw.scroll.y / 50) + raw.text.slice(0, 6000) + raw.elements.map(e => `${e.role}|${e.name}|${e.value ?? ''}`).join('\n');
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  const fingerprint = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('').slice(0, 16);
  return { ...raw, text: raw.text.slice(0, 8000), fingerprint };
}

// --- the agent cursor's sender ------------------------------------------------------------------
// Every action that touches a control (click, type, select) resolves its coordinates in `point()`
// below, so that is the one place the cursor moves from: the worker gets the same viewport point
// the mouse event is about to use, pushes it to the page, and the action waits long enough for the
// user to watch the cursor arrive before the click lands. The sink is injected by background.js
// (like tabs.js's favicon restorer) because this module knows tabs, not feedback state, and a
// service worker cannot chrome.runtime.sendMessage itself. It returns the tab's feedback record;
// `observed` false means nobody can see the page, so the extra wait for the tween is not worth
// spending — the delivery itself still takes time the page can change in, so the recheck after it
// runs either way.
let cursorSink;
export function setCursorSink(fn) { cursorSink = fn; }
// A hair over content.js's 280ms tween (DESIGN.md `--dur-relaxed`), so the cursor is at rest on
// the target when the click happens. The wait is abortable: stop cancels the action with it.
export const CURSOR_LEAD_MS = 320;
// Names one action's binding in the page (see cursorControl). Sequential, and deliberately nothing
// outside this module can guess or use: it is never put on the page or into the snapshot.
let actionSeq = 0;
// Hands the sink the point the action is about to use and waits for the delivery to be recorded and
// pushed to the content script. Resolves to whether a delivery was attempted at all: every awaited
// delivery — watched or not, accepted or rejected — is a window in which the page can change under
// the coordinates it was handed, so point() revalidates after every one of them. Only the wait for
// the tween depends on `observed`.
async function moveCursor(page, target) {
  if (!cursorSink) return false;
  let shown;
  try { shown = await cursorSink(page.tabId, { x: Math.round(target.x), y: Math.round(target.y) }); }
  catch { shown = undefined; } // feedback is a courtesy to the user; it never fails an action
  if (shown?.observed) await page.waitForTimeout(CURSOR_LEAD_MS);
  return true;
}
/**
 * Serialized into the page by every action, and resolved in the *same* isolated world each time:
 * evaluate() names the world `sash` for the frame, and Chrome keeps a named world for the
 * document's frame, so what `bind` parks on this world's global is still there for `recheck`. That
 * is what makes the binding an element rather than a lookup. The snapshot's `data-jev-idx` is only
 * an attribute: a re-render that clones the control copies it, a control repurposed in place keeps
 * it, and `querySelector` cannot tell either one from the element the coordinates were read from.
 * A navigation builds a new document and a new world, so the slot is simply gone there and the
 * action rejects the same way it did when the attribute died with the old document.
 *
 * `hit` is what the mouse event at (x, y) would reach; it must be the control or something inside
 * it, so a covering overlay or a layout shift still fails here instead of at the user's expense.
 */
function cursorControl({ op, token, id, text, index, x, y, keep }) {
  // One live slot at a time: one action is one action. `bind` dropping whatever the last one left
  // behind is what keeps this from retaining a page's nodes between actions.
  const slots = globalThis.__sashCursorSlots || (globalThis.__sashCursorSlots = new Map());
  const clean = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  // The snapshot's own naming rules (src/snapshot.js), so "what the control said" and "what it says
  // now" mean the same thing on both sides of the wait.
  const label = el => {
    let s = el.getAttribute('aria-label') || '';
    if (!s && el.labels && el.labels[0]) s = el.labels[0].innerText;
    if (!s && el.getAttribute('aria-labelledby')) { const l = document.getElementById(el.getAttribute('aria-labelledby')); if (l) s = l.innerText; }
    if (!s) s = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    if (!s) { const img = el.querySelector('img[alt]'); if (img) s = img.getAttribute('alt'); }
    if (!s) s = el.innerText || el.textContent || '';
    if (!s && el.tagName === 'A') s = el.getAttribute('href') || '';
    return clean(s);
  };
  // What has to stay true about the control for the action to still be the one that was planned:
  // it is the same kind of thing and it says the same thing. Where it sits and what it holds are
  // free to move — a re-render that shifts a control has its own check below.
  const identity = el => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), role: el.getAttribute('role') || '', label: label(el) });
  const name = i => i.label ? `"${i.label}"` : `${i.tag}${i.type ? `[${i.type}]` : ''}`;
  const held = () => {
    const record = slots.get(token);
    if (!record || !record.el.isConnected) throw new Error('the control is no longer available');
    return record;
  };
  if (op === 'bind') {
    const el = document.querySelector(`[data-jev-idx="${id}"]`);
    if (!el || el.disabled) throw new Error('the control is no longer available');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const bx = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const by = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    const hit = document.elementFromPoint(bx, by);
    if (!r.width || !r.height || !(hit === el || el.contains(hit))) throw new Error('the control is covered or not visible');
    slots.clear();
    slots.set(token, { el, identity: identity(el) });
    return { x: bx, y: by };
  }
  if (op === 'recheck') {
    const record = held();
    // A click has nothing left to do with the element (CDP dispatches its mouse event), so its slot
    // goes now. Type and select still have to act on it, so they keep it for their own op.
    if (!keep) slots.delete(token);
    if (record.el.disabled) throw new Error('the control is no longer available');
    const now = identity(record.el);
    const was = record.identity;
    if (now.tag !== was.tag || now.type !== was.type || now.role !== was.role || now.label !== was.label) {
      throw new Error(`the control is no longer ${name(was)}; it now reads ${name(now)}`);
    }
    const hit = document.elementFromPoint(x, y);
    return hit === record.el || record.el.contains(hit);
  }
  if (op === 'type') {
    const { el } = held();
    slots.delete(token);
    if (el.disabled || el.readOnly) throw new Error('this field is not editable');
    el.focus();
    if (el instanceof HTMLInputElement && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(el.type)) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, text);
      if (el.value !== text) throw new Error('the value is not valid for this field');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.type === 'number' && (!text.trim() || !Number.isFinite(Number(text)))) throw new Error('this field requires a number');
      el.select();
    } else throw new Error('this control is not a text field');
    return false;
  }
  if (op === 'select') {
    const { el } = held();
    slots.delete(token);
    if (!(el instanceof HTMLSelectElement) || !el.options[index] || el.options[index].disabled) throw new Error('this option is unavailable');
    el.focus(); el.selectedIndex = index;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  throw new Error('unknown cursor operation');
}
// `keep` is for the two actions that still have to act on the element afterwards (type, select):
// their own op consumes the slot. A click dispatches through CDP and is done with it here.
async function point(page, id, keep = false) {
  if (!Number.isInteger(id) || id < 1) throw new Error('no matching control');
  const token = `a${++actionSeq}`;
  const target = await page.evaluate(cursorControl, { op: 'bind', token, id });
  // The cursor delivery is a window in which the page can move on: a navigation, a re-render that
  // shifts the control or swaps it for a copy, a dialog or overlay landing on top of it, a control
  // repurposed in place. The coordinates were right when they were read; before anything is
  // dispatched at them, prove they still reach that same control, still connected and still saying
  // what it said. A new document is a new world, so its empty slots fail this the same way.
  if (await moveCursor(page, target)) {
    let still;
    try { still = await page.evaluate(cursorControl, { op: 'recheck', token, x: target.x, y: target.y, keep }); }
    catch (err) {
      if (page.signal.aborted) throw err;
      // First line only: an in-page exception's description carries its stack.
      const reason = String(err.message).split('\n')[0].replace(/^Error:\s*/, '');
      throw new Error(`the page changed while the cursor was moving: ${reason}. look at the page again before acting`);
    }
    if (!still) throw new Error('the page changed while the cursor was moving: something else is now at that spot. look at the page again before acting');
  }
  return { ...target, token };
}
export async function click(page, id) {
  const { x, y } = await point(page, id);
  await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
export async function typeText(page, id, text, submit) {
  const { token } = await point(page, id, true);
  // Typed into the bound element, not into whatever carries its index attribute by now.
  const nativeValue = await page.evaluate(cursorControl, { op: 'type', token, text });
  if (!nativeValue) await page.command('Input.insertText', { text });
  if (submit) {
    await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
}
export async function selectOption(page, id, index) {
  const { token } = await point(page, id, true);
  await page.evaluate(cursorControl, { op: 'select', token, index });
}
export async function scroll(page, dir) {
  await page.evaluate(scrollState);
  await page.evaluate(dir => {
    const target = document.querySelector('[data-sash-scroll]') || document.scrollingElement;
    target.scrollBy({ top: dir === 'down' ? 640 : -640, behavior: 'instant' });
  }, dir);
  await page.waitForTimeout(200);
}
export async function settle(page) { await page.waitForTimeout(350); await page.ready(); }
export async function screenshot() { return ''; } // The user is already looking at the real tab.
