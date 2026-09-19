// Who owns a tab. One session at a time: a tab a session drove must not be stolen mid-run by another.
// State lives in this module only — background.js is a single service-worker instance, so a Map is
// the whole store until a later unit persists it to chrome.storage.

/** @typedef {{tabId: number, sessionId: string, turnId: string|undefined, instanceId: string|undefined, openedByUs: boolean, mutedByUs: boolean}} Lease */

const leases = new Map();

/** Claim a tab for a session. Re-claiming from the same session refreshes the turn. */
export function claim(tabId, { sessionId, turnId, instanceId, openedByUs = false } = {}) {
  const held = leases.get(tabId);
  if (held && held.sessionId !== sessionId) throw new Error(`Tab ${tabId} is already part of browser session ${held.sessionId}`);
  const lease = {
    tabId, sessionId, turnId, instanceId,
    openedByUs: held ? held.openedByUs || openedByUs : openedByUs,
    mutedByUs: held ? held.mutedByUs : false,
  };
  leases.set(tabId, lease);
  return lease;
}

/** Drop a tab's lease. Returns whether one was held. */
export function release(tabId) {
  return leases.delete(tabId);
}

/** The current lease for a tab, or undefined. */
export function get(tabId) {
  return leases.get(tabId);
}
