import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claim, release, get } from './extension/lease.js';

test('claim records the lease shape for a free tab', () => {
  const lease = claim(1, { sessionId: 'session-a', turnId: 'turn-1', instanceId: 'instance-1', openedByUs: true });
  assert.deepEqual(lease, { tabId: 1, sessionId: 'session-a', turnId: 'turn-1', instanceId: 'instance-1', openedByUs: true, mutedByUs: false });
  assert.deepEqual(get(1), lease);
  release(1);
});

test('a second session cannot take a tab another session holds', () => {
  claim(2, { sessionId: 'session-a', turnId: 'turn-1', instanceId: 'instance-1' });
  assert.throws(() => claim(2, { sessionId: 'session-b', turnId: 'turn-2', instanceId: 'instance-2' }),
    { message: 'Tab 2 is already part of browser session session-a' });
  assert.equal(get(2).sessionId, 'session-a');
  release(2);
});

test('the same session may re-claim its own tab, keeping openedByUs', () => {
  claim(3, { sessionId: 'session-a', turnId: 'turn-1', openedByUs: true });
  const again = claim(3, { sessionId: 'session-a', turnId: 'turn-2' });
  assert.equal(again.turnId, 'turn-2');
  assert.equal(again.openedByUs, true);
  release(3);
});

test('release clears the lease so another session can claim the tab', () => {
  claim(4, { sessionId: 'session-a', turnId: 'turn-1' });
  assert.equal(release(4), true);
  assert.equal(get(4), undefined);
  assert.equal(claim(4, { sessionId: 'session-b', turnId: 'turn-2' }).sessionId, 'session-b');
  assert.equal(release(4), true);
  assert.equal(release(4), false);
});
