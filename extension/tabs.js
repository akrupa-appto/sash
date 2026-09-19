// What happens to the tabs a run controlled: where the ones it opened live while it works,
// how each one is left when it ends, and how the next turn picks the handed-off ones back up.
// The lease says who owns a tab; this module says what that ownership does.

import { BadgeState } from './types.js';
import * as lease from './lease.js';

/** How a run left a tab. A tab with neither mark is unmarked, and gets cleaned up. */
export const Disposition = {
  DELIVERABLE: 'deliverable', // holds a result: left open, ungrouped, green dot
  HANDOFF: 'handoff', // waiting on the user: left open, lease held, yellow dot
};

const GROUP_KEY = 'tabGroup';
const GROUP_TITLE = 'checkto';
// chrome.tabGroups' own colour names; the group picks one at random so two profiles do not look alike.
const GROUP_COLORS = ['blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow'];
const BADGE_COLOR = { [BadgeState.WORKING]: '#6b7280', [BadgeState.DELIVERABLE]: '#22c55e', [BadgeState.HANDOFF]: '#facc15' };

// What a handed-off tab looked like when the run let go of it, so the next turn can resume it in place.
const handedOff = new Map();

// Restoring a site's real favicon needs the favicon-badge unit's content script. Until that lands
// this is a no-op, and the contract still runs the restore before a tab is closed, never after.
let restoreFavicon = async () => {};
export function setFaviconRestorer(restore) { restoreFavicon = restore || (async () => {}); }

// Tab housekeeping must never take a run down: a closed tab, a stale group, or a badge Chrome
// refused to paint are all cosmetic next to the answer the run produced.
async function safe(call) { try { return await call(); } catch { return undefined; } }
function originOf(url) { try { return new URL(url).origin; } catch { return undefined; } }

/** Say what the toolbar badge shows for one tab. */
export async function paintBadge(tabId, badgeState) {
  await safe(() => chrome.action.setBadgeText({ tabId, text: BADGE_COLOR[badgeState] ? '●' : '' }));
  if (BADGE_COLOR[badgeState]) await safe(() => chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR[badgeState] }));
}

let groupId;
let joining = Promise.resolve();

async function knownGroupId() {
  if (groupId !== undefined) return groupId;
  const stored = (await safe(() => chrome.storage.local.get(GROUP_KEY)))?.[GROUP_KEY];
  if (Number.isInteger(stored?.id)) groupId = stored.id;
  return groupId;
}

/**
 * Put a tab the agent opened in the "checkto" group, creating the group on the first such tab.
 * The group id is persisted, so a restarted service worker rejoins it instead of making a second one.
 * A tab the user handed over holds a lease with openedByUs false and is never grouped.
 */
export async function groupTab(tabId) {
  if (!lease.get(tabId)?.openedByUs) return undefined;
  // Serialised, so the first tab creates the group and every later one joins that same group.
  const work = joining.then(async () => {
    const existing = await knownGroupId();
    if (existing !== undefined) {
      const joined = await safe(() => chrome.tabs.group({ tabIds: [tabId], groupId: existing }));
      if (joined !== undefined) return existing;
      groupId = undefined; // the stored group is gone (the user closed every tab in it), so make a new one
    }
    const created = await safe(() => chrome.tabs.group({ tabIds: [tabId] }));
    if (created === undefined) return undefined;
    groupId = created;
    const color = GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
    await safe(() => chrome.tabGroups.update(created, { title: GROUP_TITLE, color, collapsed: false }));
    await safe(() => chrome.storage.local.set({ [GROUP_KEY]: { id: created } }));
    return created;
  });
  joining = work.then(() => {}, () => {});
  return work;
}

/** Rename the group to the task. Never collapses it: the user has to be able to see what is running. */
export async function renameGroup(title) {
  const id = await knownGroupId();
  if (id === undefined || typeof title !== 'string' || !title.trim()) return false;
  return await safe(() => chrome.tabGroups.update(id, { title: title.trim().slice(0, 60), collapsed: false })) !== undefined;
}

/** The agent says how it is leaving a tab. Anything it does not mark counts as unmarked. */
export function markTab(tabId, disposition) {
  if (disposition !== Disposition.DELIVERABLE && disposition !== Disposition.HANDOFF) return undefined;
  return lease.mark(tabId, disposition);
}

/**
 * The end-of-run contract, applied to every tab this session holds:
 * - deliverable: left open, ungrouped, green dot, lease released;
 * - handoff: left open, lease held for the next turn, yellow dot;
 * - unmarked and opened by us: favicon restored, then closed;
 * - unmarked and handed over by the user: released, never closed.
 */
export async function endRun(sessionId) {
  const outcome = { deliverable: [], handoff: [], closed: [], released: [] };
  for (const held of lease.list(sessionId)) {
    const { tabId, disposition, openedByUs } = held;
    if (disposition === Disposition.DELIVERABLE) {
      await safe(() => chrome.tabs.ungroup([tabId]));
      await paintBadge(tabId, BadgeState.DELIVERABLE);
      lease.release(tabId);
      outcome.deliverable.push(tabId);
    } else if (disposition === Disposition.HANDOFF) {
      const tab = await safe(() => chrome.tabs.get(tabId));
      handedOff.set(tabId, { origin: originOf(tab?.url), wasActive: tab?.active === true });
      await paintBadge(tabId, BadgeState.HANDOFF);
      outcome.handoff.push(tabId);
    } else if (openedByUs) {
      await restoreFavicon(tabId); // before it closes, so no stale badge is ever seen
      await safe(() => chrome.tabs.remove(tabId));
      handedOff.delete(tabId);
      lease.release(tabId);
      outcome.closed.push(tabId);
    } else {
      await paintBadge(tabId, BadgeState.NONE);
      handedOff.delete(tabId);
      lease.release(tabId);
      outcome.released.push(tabId);
    }
  }
  return outcome;
}

/**
 * Start a turn on the tabs the last one handed off rather than cold: probe each one, resume the
 * survivors under the new turn id where they stand (same origin, same viewport, nothing reloaded),
 * silently drop the ones the user closed, and put the tab that was active back in front.
 */
export async function resumeHandoffIfPresent(sessionId, turnId, instanceId) {
  const resumed = [];
  const dropped = [];
  let active;
  for (const held of lease.list(sessionId)) {
    if (held.disposition !== Disposition.HANDOFF) continue;
    const { tabId, openedByUs } = held;
    const kept = handedOff.get(tabId) || {};
    handedOff.delete(tabId);
    const tab = await safe(() => chrome.tabs.get(tabId));
    if (!tab) { lease.release(tabId); dropped.push(tabId); continue; }
    lease.claim(tabId, { sessionId, turnId, instanceId, openedByUs });
    await paintBadge(tabId, BadgeState.WORKING);
    if (kept.wasActive) active = tabId;
    resumed.push({ tabId, openedByUs, origin: originOf(tab.url) ?? kept.origin });
  }
  if (active !== undefined) await safe(() => chrome.tabs.update(active, { active: true }));
  return { resumed, dropped, active };
}

/** Let go of every tab a session holds, badges and all. Used when the user starts a new chat. */
export async function releaseAll(sessionId) {
  for (const held of lease.list(sessionId)) {
    await paintBadge(held.tabId, BadgeState.NONE);
    handedOff.delete(held.tabId);
    lease.release(held.tabId);
  }
}
