import { collectSnapshot, pageReady } from "./snapshot.js";
import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type El = {
  id: number;
  role: string; // link | button | textbox | select | checkbox | ...
  name: string;
  value?: string;
  kind: "click" | "type" | "select";
  options?: string[]; // native select options
  contentEditable?: boolean;
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



export async function launch(): Promise<{ browser: Browser; context: BrowserContext; page: Page; liveViewUrl: string; anchorId: string; close: () => Promise<void> }> {
  const key = process.env.ANCHOR_API_KEY || process.env.ANCHORBROWSER_API_KEY;
  if (!key) throw new Error("Anchor Browser needs ANCHOR_API_KEY in the server's .env file");
  const headers = { "anchor-api-key": key, "content-type": "application/json" };
  const response = await fetch("https://api.anchorbrowser.io/v1/sessions", {
    method: "POST", headers, signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      browser: { headless: { active: false }, viewport: { width: 1280, height: 800 } },
      session: { timeout: { max_duration: 60, idle_timeout: 3 }, live_view: { read_only: true }, recording: { active: true } },
    }),
  });
  if (!response.ok) throw new Error(`Anchor Browser could not start a session (${response.status})`);
  const { data } = await response.json();
  if (!data?.id) throw new Error("Anchor Browser returned no session ID");
  const endRemote = async () => {
    const r = await fetch(`https://api.anchorbrowser.io/v1/sessions/${encodeURIComponent(data.id)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok && r.status !== 404) throw new Error(`Anchor Browser could not close the session (${r.status})`);
  };
  let browser: Browser | undefined;
  try {
    const paused = await fetch(`https://api.anchorbrowser.io/v1/sessions/${encodeURIComponent(data.id)}/recordings/pause`, { method: "POST", headers, signal: AbortSignal.timeout(15000) });
    if (!paused.ok) throw new Error("could not initialize recording controls");
    if (!data.cdp_url || !data.live_view_url) throw new Error("Anchor Browser returned an incomplete session");
    browser = await chromium.connectOverCDP(data.cdp_url, { timeout: 30000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Anchor Browser returned no browser context");
    const page = context.pages()[0] ?? await context.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      try { await endRemote(); } finally { await browser!.close().catch(() => {}); }
    })();
    return { browser, context, page, liveViewUrl: data.live_view_url, anchorId: data.id, close };
  } catch {
    await endRemote().catch(() => {});
    await browser?.close().catch(() => {});
    // CDP errors can include a credential-bearing websocket URL.
    throw new Error("could not connect to Anchor Browser; try starting a new chat");
  }
}


export async function snapshot(page: Page): Promise<Snapshot> {
  let raw;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await page.evaluate(collectSnapshot, MAX_ELEMENTS);
      if (raw.busy) {
        // A client-side save may not generate a network request. Only pay for
        // another remote wait/read when the snapshot actually observes progress.
        await page.waitForFunction(pageReady, undefined, { timeout: 10000 }).catch(() => {});
        raw = await page.evaluate(collectSnapshot, MAX_ELEMENTS);
      }
      break;
    } catch (err) {
      // Navigation can replace the document between settling and reading it.
      // Retry only this read; replaying a click could submit the same form twice.
      if (attempt >= 2 || !/Execution context was destroyed|Cannot find context with specified id/.test((err as Error).message)) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
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
  const before = page.url();
  const href = await l.evaluate((el) => {
    const a = el.closest("a[href]") as HTMLAnchorElement | null;
    return a && !a.hasAttribute("download") && (!a.target || a.target === "_self") && /^https?:/.test(a.href) ? a.href : null;
  }, undefined, { timeout: 3000 });
  // Locator.click already scrolls and waits for actionability. A forced retry
  // can target stale controls after an asynchronous page replacement.
  // Keep actionability short, but give a link's destination time to load.
  // Waiting separately avoids timing out the click during a slow response.
  const navigates = !!href && href !== before;
  await l.click({ timeout: 5000, ...(navigates ? { noWaitAfter: true } : {}) });
  if (navigates) {
    await page.waitForURL(url => url.href !== before, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
}

export async function typeText(page: Page, id: number, text: string, submit: boolean, contentEditable = false) {
  const l = loc(page, id);
  // fill handles focus and replacement for plain fields. Avoid
  // three extra CDP round trips (scroll, click, inspect) for every form field.
  if (contentEditable) {
    // Rich editors may require keyboard events for their internal state.
    // Anchor's browser platform can differ from the Node client's platform.
    // Native selection avoids sending the wrong platform's select-all shortcut.
    await l.selectText({ timeout: 5000 });
    await l.pressSequentially(text, { delay: 5, timeout: 5000 });
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
  // Give debounced click handlers time to start their requests before checking
  // networkidle; the previous document may already be idle when the click returns.
  await page.waitForTimeout(250);
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
}

export async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "jpeg", quality: 55 });
  return buf.toString("base64");
}
