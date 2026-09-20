// The in-page feedback layer: a badged favicon and an agent cursor.
//
// checkto had no content scripts until now, so every signal lived in the side panel and a tab
// the user was not looking at said nothing. This script owns two marks on the page itself:
//
//   - the favicon, dimmed to 0.3 with a glyph stamped over it, so the tab strip says which tabs
//     the run touched and which one is holding a result, with the panel closed;
//   - a cursor overlay in a closed shadow root, so the user can see what is about to be clicked.
//
// Chrome injects a fresh copy of this file on every navigation, so nothing here may assume it is
// the first copy or that the worker knows it is alive: the script pulls its own state on load and
// on `pageshow` (bfcache restores run no scripts), and the worker pings before pushing.
import { BadgeState } from './types.js';

// The page's own icon href is stashed on the link element itself, so a second copy of this script
// finds the original rather than stashing an already-badged data URL over it.
const ORIGINAL_HREF = 'data-checkto-favicon';
const CURSOR_HOST = 'data-checkto-cursor';
const SIZE = 32;
const DOT = { [BadgeState.DELIVERABLE]: '#22c55e', [BadgeState.HANDOFF]: '#facc15' };
const CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
  + '<path d="M4 2 18 10.5 11.8 11.8 9 19Z" fill="#111827" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const CURSOR_IMAGE = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(CURSOR_SVG);
// The pointer's tip is the SVG path's first vertex (4,2); the glyph is shifted so that tip, not
// its top-left corner, sits on the point the click is about to land on.
const CURSOR_TIP = { x: 4, y: 2 };
// Motion: transform only, tokens matched by hand to DESIGN.md (`--dur-relaxed: .3s`,
// `--ease-out: cubic-bezier(0,0,.2,1)`) because this script runs on other people's pages, where
// the extension's CSS variables do not exist. browser.js's CURSOR_LEAD_MS waits a hair longer than
// this so the click never lands before the cursor does.
const CURSOR_MOTION = 'transform 280ms cubic-bezier(0,0,.2,1)';
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let wanted = BadgeState.NONE;
let host;
let observer;

/** The link element that owns the tab's icon, creating one when the page relies on /favicon.ico. */
function iconLink() {
  const head = document.head;
  if (!head) return undefined;
  const stashed = head.querySelector(`link[${ORIGINAL_HREF}]`);
  if (stashed) return stashed;
  const existing = head.querySelector('link[rel~="icon" i]');
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'icon';
  // No icon of its own: there is nothing to dim and nothing to restore to, so the empty stash
  // marks this link as ours and `restoreBadge` removes it outright.
  link.setAttribute(ORIGINAL_HREF, '');
  head.appendChild(link);
  return link;
}

/**
 * Load the page's icon for compositing. `crossOrigin` is deliberate: an icon served without CORS
 * headers fails to load instead of tainting the canvas, and a tainted canvas cannot be read back.
 */
function loadIcon(href) {
  return new Promise(resolve => {
    if (!href) return resolve(undefined);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = href;
  });
}

function drawCursorGlyph(ctx) {
  ctx.beginPath();
  ctx.moveTo(8, 4); ctx.lineTo(27, 16); ctx.lineTo(18.5, 17.8); ctx.lineTo(14.5, 27);
  ctx.closePath();
  ctx.fillStyle = '#111827';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
}

function drawDot(ctx, colour) {
  ctx.beginPath();
  ctx.arc(SIZE - 9, SIZE - 9, 8, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fill();
}

/** The page's icon at 0.3 opacity with the state's glyph stamped over it, as a PNG data URL. */
async function badgedIcon(state, href) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const icon = await loadIcon(href);
  if (icon) {
    ctx.globalAlpha = 0.3;
    ctx.drawImage(icon, 0, 0, SIZE, SIZE);
    ctx.globalAlpha = 1;
  }
  if (state === BadgeState.WORKING) drawCursorGlyph(ctx);
  else drawDot(ctx, DOT[state] || '#9ca3af');
  return canvas.toDataURL('image/png');
}

/** Put the page's own icon back and forget that we ever touched it. */
export function restoreBadge() {
  wanted = BadgeState.NONE;
  const link = document.head?.querySelector(`link[${ORIGINAL_HREF}]`);
  if (!link) return;
  const original = link.getAttribute(ORIGINAL_HREF);
  link.removeAttribute(ORIGINAL_HREF);
  if (original) link.href = original;
  else link.remove();
}

export async function applyBadge(state) {
  if (!state || state === BadgeState.NONE) return restoreBadge();
  wanted = state;
  const link = iconLink();
  if (!link) return;
  if (!link.hasAttribute(ORIGINAL_HREF)) link.setAttribute(ORIGINAL_HREF, link.getAttribute('href') ?? '');
  const url = await badgedIcon(state, link.getAttribute(ORIGINAL_HREF) || undefined);
  // Drawing is async; a state that arrived while we were drawing wins.
  if (wanted === state) link.href = url;
}

/** Re-attach the overlay host if the page's own scripts wipe it out of the document. */
function watchHost() {
  observer?.disconnect();
  observer = new MutationObserver(() => {
    if (host && !host.isConnected) document.documentElement.appendChild(host);
  });
  observer.observe(document.documentElement, { childList: true });
}

/**
 * Put the cursor at `point` (viewport pixels). A cursor already on screen slides there, so the
 * user's eye can follow the hand to what is about to be clicked; one that was not on screen
 * appears in place, never sliding in from the corner. Reduced motion snaps every time.
 */
export function showCursor(point) {
  if (!host) {
    host = document.createElement('div');
    host.setAttribute(CURSOR_HOST, '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    // Closed, so page scripts cannot reach in; built node by node, so pages enforcing Trusted Types
    // do not reject an innerHTML assignment.
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `img{display:block;width:24px;height:24px;transform:translate(${-CURSOR_TIP.x}px,${-CURSOR_TIP.y}px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}@media print{:host{display:none!important}}`;
    const img = document.createElement('img');
    img.alt = '';
    img.src = CURSOR_IMAGE;
    shadow.append(style, img);
  }
  const arriving = !host.isConnected;
  if (arriving) document.documentElement.appendChild(host);
  watchHost();
  host.style.transition = arriving || reducedMotion() ? 'none' : CURSOR_MOTION;
  host.style.transform = `translate(${Number(point?.x) || 0}px, ${Number(point?.y) || 0}px)`;
}

export function hideCursor() {
  observer?.disconnect();
  observer = undefined;
  host?.remove();
  host = undefined;
}

/**
 * Apply one snapshot of worker state. `observed` is the tab being the active tab in its window:
 * the worker keeps tracking the cursor's position for unobserved tabs, this only stops painting it.
 */
export function apply(state) {
  const { badge = BadgeState.NONE, observed = false, cursor } = state || {};
  void applyBadge(badge);
  if (observed && cursor) showCursor(cursor);
  else hideCursor();
}

async function pull() {
  const reply = await chrome.runtime.sendMessage({ type: 'CONTENT_STATE_REQUEST' }).catch(() => undefined);
  if (reply?.state) apply(reply.state);
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  // The liveness answer: without it the worker cannot tell a surviving injection from a dead one.
  if (message?.type === 'CONTENT_PING') { reply({ ok: true }); return false; }
  if (message?.type === 'CONTENT_STATE') { apply(message.state); reply({ ok: true }); return false; }
  return false;
});

void pull();
// A bfcache restore runs no scripts and keeps the old DOM, so the overlay state is re-read here.
window.addEventListener('pageshow', () => { void pull(); });
// Never let a stale badge or a cursor aimed at the old document outlive the page.
window.addEventListener('pagehide', () => { restoreBadge(); hideCursor(); });
