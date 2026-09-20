import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot } from '../src/snapshot.js';

// Minimal DOM stand-in: collectSnapshot only needs querySelectorAll, computed
// styles, rects and a couple of document/window globals.
function el({ tag, type, name, value }) {
  const attrs = { type, name };
  return {
    tagName: tag.toUpperCase(),
    type,
    value,
    labels: [],
    isContentEditable: false,
    disabled: false,
    innerText: '',
    textContent: '',
    parentElement: null,
    getAttribute: k => (attrs[k] === undefined ? null : attrs[k]),
    setAttribute: () => {},
    removeAttribute: () => {},
    querySelector: () => null,
    getClientRects: () => [],
    getBoundingClientRect: () => ({ top: 10, bottom: 40, left: 10, right: 200, width: 190, height: 30 }),
  };
}

function withDom(elements, fn) {
  const saved = { ...globalThis };
  globalThis.document = {
    title: 'Login',
    body: { innerText: 'Login' },
    scrollingElement: { scrollTop: 0, scrollHeight: 600 },
    documentElement: {},
    getElementById: () => null,
    querySelectorAll: sel => (sel === '[data-jev-idx]' ? [] : elements),
  };
  globalThis.location = { href: 'https://example.test/login' };
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 600;
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto' });
  try { return fn(); } finally {
    for (const k of ['document', 'location', 'innerWidth', 'innerHeight', 'getComputedStyle']) globalThis[k] = saved[k];
  }
}

test('password field values are never put in the snapshot sent to the planner', () => {
  const user = el({ tag: 'input', type: 'text', name: 'username', value: 'adam' });
  const pass = el({ tag: 'input', type: 'password', name: 'password', value: 'hunter2' });
  const snap = withDom([user, pass], () => collectSnapshot(20));

  const passwordEl = snap.elements.find(e => e.name === 'password');
  assert.ok(passwordEl, 'the password field must still appear so the agent can see the login form');
  assert.equal(passwordEl.role, 'password');
  assert.equal(passwordEl.kind, 'type');
  assert.ok(!passwordEl.value, 'password value must be omitted');
  assert.ok(!JSON.stringify(snap).includes('hunter2'), 'no snapshot field may carry the secret');

  assert.equal(snap.elements.find(e => e.name === 'username').value, 'adam');
});
