import { collectSnapshot, pageReady } from '../snapshot.js';

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
  document.querySelectorAll('[data-checkto-scroll]').forEach(el => el.removeAttribute('data-checkto-scroll'));
  target.setAttribute('data-checkto-scroll', 'true');
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
  async title() { return this.evaluate(() => document.title); }
  context() { return { pages: () => this.pages.filter(p => p.attached && p.initialized) }; }
  async attach() {
    this.signal.throwIfAborted();
    if (!supportedUrl(this.currentUrl)) throw new Error('open a regular website first; Chrome settings, the web store, and extension pages cannot be controlled');
    await chrome.tabs.update(this.tabId, { active: true });
    const tab = await chrome.tabs.get(this.tabId);
    if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId, { focused: true });
    this.signal.throwIfAborted();
    try { await chrome.debugger.attach({ tabId: this.tabId }, '1.3'); }
    catch (err) { throw new Error(`could not control this tab: ${err.message}. close DevTools or another browser-control extension on this tab, then try again.`); }
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
    const { executionContextId } = await this.command('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'checkto' });
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

async function point(page, id) {
  if (!Number.isInteger(id) || id < 1) throw new Error('no matching control');
  return page.evaluate(id => {
    const el = document.querySelector(`[data-jev-idx="${id}"]`);
    if (!el || el.disabled) throw new Error('the control is no longer available');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!r.width || !r.height || !(hit === el || el.contains(hit))) throw new Error('the control is covered or not visible');
    return { x, y };
  }, id);
}
export async function click(page, id) {
  const { x, y } = await point(page, id);
  await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
export async function typeText(page, id, text, submit) {
  await point(page, id);
  const nativeValue = await page.evaluate(({ id, text }) => {
    const el = document.querySelector(`[data-jev-idx="${id}"]`);
    if (!el || el.disabled || el.readOnly) throw new Error('this field is not editable');
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
  }, { id, text });
  if (!nativeValue) await page.command('Input.insertText', { text });
  if (submit) {
    await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
}
export async function selectOption(page, id, index) {
  await point(page, id);
  await page.evaluate(({ id, index }) => {
    const el = document.querySelector(`[data-jev-idx="${id}"]`);
    if (!(el instanceof HTMLSelectElement) || !el.options[index] || el.options[index].disabled) throw new Error('this option is unavailable');
    el.focus(); el.selectedIndex = index;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, index });
}
export async function scroll(page, dir) {
  await page.evaluate(scrollState);
  await page.evaluate(dir => {
    const target = document.querySelector('[data-checkto-scroll]') || document.scrollingElement;
    target.scrollBy({ top: dir === 'down' ? 640 : -640, behavior: 'instant' });
  }, dir);
  await page.waitForTimeout(200);
}
export async function settle(page) { await page.waitForTimeout(350); await page.ready(); }
export async function screenshot() { return ''; } // The user is already looking at the real tab.
