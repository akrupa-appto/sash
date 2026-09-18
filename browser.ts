import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type El = {
  id: number;
  role: string; // link | button | textbox | select | checkbox | ...
  name: string;
  value?: string;
  kind: "click" | "type" | "select";
  options?: string[]; // native select options
  inViewport: boolean;
  pos?: "above" | "below"; // when not in viewport: which way to scroll to reach it
};

export type Snapshot = {
  url: string;
  title: string;
  text: string;
  elements: El[];
  scroll: { y: number; max: number }; // max = furthest scrollY possible; 0 means the page fits the viewport
  fingerprint: string; // changes when the visible page state changes
};

const MAX_ELEMENTS = 240; // Jev choice questions allow up to 255 options
const MAX_TEXT = 8000;

export async function launch(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ channel: "chromium", headless: true }); // full chromium, new headless mode
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    locale: "en-US",
  });
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  return { browser, context, page };
}

// Runs inside the page. Tags interactive elements with data-jev-idx and returns a compact list.
const SNAPSHOT_JS = `(maxEls) => {
  const sel = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-jev-idx]').forEach(e => e.removeAttribute('data-jev-idx'));
  const vw = innerWidth, vh = innerHeight;
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el)) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none' && el.tagName !== 'INPUT') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (el.disabled) continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    // skip nested interactive (e.g. span[role=button] inside a button)
    if (el.parentElement && el.parentElement.closest(sel) && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') {
      const p = el.parentElement.closest(sel);
      if (p && p.getBoundingClientRect().width <= r.width + 4) continue;
    }
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    let role = el.getAttribute('role') || tag;
    let kind = 'click';
    if (tag === 'select') { role = 'select'; kind = 'select'; }
    else if (tag === 'textarea' || el.isContentEditable) { role = 'textbox'; kind = 'type'; }
    else if (tag === 'input') {
      if (['checkbox','radio','submit','button','reset','image','file'].includes(type)) { role = type || 'button'; kind = 'click'; }
      else { role = type ? type : 'textbox'; kind = 'type'; }
    } else if (role === 'textbox' || role === 'combobox' || role === 'searchbox') { kind = 'type'; }
    else if (tag === 'a') role = 'link';
    let name = el.getAttribute('aria-label') || '';
    if (!name && el.labels && el.labels[0]) name = el.labels[0].innerText;
    if (!name && el.getAttribute('aria-labelledby')) { const l = document.getElementById(el.getAttribute('aria-labelledby')); if (l) name = l.innerText; }
    if (!name) name = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    if (!name) { const img = el.querySelector('img[alt]'); if (img) name = img.getAttribute('alt'); }
    if (!name) name = el.innerText || el.textContent || '';
    if (!name && tag === 'a') name = el.getAttribute('href') || '';
    name = clean(name);
    let value;
    if (kind === 'type') value = clean(el.value !== undefined ? el.value : el.innerText);
    if (kind === 'select') value = clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') value = (el.checked || el.getAttribute('aria-checked') === 'true') ? 'checked' : 'unchecked';
    const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const options = kind === 'select' ? Array.from(el.options).slice(0, 40).map(o => clean(o.text)) : undefined;
    out.push({ el, role, name, value, kind, options, inViewport, pos: inViewport ? undefined : (r.bottom <= 0 ? 'above' : 'below'), top: r.top });
  }
  // document order, so "the last item in the list" is the last element listed
  const kept = out.slice(0, maxEls);
  kept.forEach((o, i) => o.el.setAttribute('data-jev-idx', String(i + 1)));
  const text = (document.body.innerText || '').replace(/[ \\t]+/g, ' ').replace(/\\n{2,}/g, '\\n').trim();
  const se = document.scrollingElement || document.documentElement;
  return {
    url: location.href,
    title: document.title,
    text,
    scroll: { y: Math.round(se.scrollTop), max: Math.max(0, Math.round(se.scrollHeight - innerHeight)) },
    elements: kept.map((o, i) => ({ id: i + 1, role: o.role, name: o.name, value: o.value, kind: o.kind, options: o.options, inViewport: o.inViewport, pos: o.pos })),
  };
}`;

// eslint-disable-next-line no-new-func
const SNAPSHOT_FN = new Function("return " + SNAPSHOT_JS)() as (maxEls: number) => any;

export async function snapshot(page: Page): Promise<Snapshot> {
  const raw = await page.evaluate(SNAPSHOT_FN, MAX_ELEMENTS);
  const fingerprint = createHash("sha1")
    .update(raw.url)
    .update(String(Math.round(raw.scroll.y / 50)))
    .update(raw.text.slice(0, 6000))
    .update(raw.elements.map((e: El) => `${e.role}|${e.name}|${e.value ?? ""}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
  return { ...raw, text: raw.text.slice(0, MAX_TEXT), fingerprint } as Snapshot;
}

export function describe(e: El): string {
  const v = e.value ? ` = "${e.value}"` : "";
  return `[${e.id}] ${e.role} "${e.name}"${v}`;
}

function loc(page: Page, id: number) {
  return page.locator(`[data-jev-idx="${id}"]`).first();
}

export async function click(page: Page, id: number) {
  const l = loc(page, id);
  await l.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  try {
    await l.click({ timeout: 5000 });
  } catch {
    await l.click({ timeout: 3000, force: true });
  }
}

export async function typeText(page: Page, id: number, text: string, submit: boolean) {
  const l = loc(page, id);
  await l.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await l.click({ timeout: 5000 }).catch(() => {});
  const editable = await l.evaluate((el: any) => el.isContentEditable).catch(() => false);
  if (editable) {
    await l.press("Control+A").catch(() => {});
    await l.pressSequentially(text, { delay: 5 });
  } else {
    await l.fill(text, { timeout: 5000 });
  }
  if (submit) await l.press("Enter", { timeout: 3000, noWaitAfter: true }).catch(() => {});
}

export async function selectOption(page: Page, id: number, optionIndex: number) {
  await loc(page, id).selectOption({ index: optionIndex }, { timeout: 5000 });
}

export async function scroll(page: Page, dir: "up" | "down") {
  await page.mouse.wheel(0, dir === "down" ? 640 : -640);
  await page.waitForTimeout(150); // let smooth scrolling and lazy content land
}

export async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(250);
}

export async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "jpeg", quality: 55 });
  return buf.toString("base64");
}
