import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';
import { approvalRequest, credentialRequest } from './extension/requests.js';

// The panel is rendered in a real browser: the bug this guards against was DOM order, not logic.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const root = join(import.meta.dirname, 'dist/checkto-extension');
const server = createServer(async (req, res) => {
  try {
    const path = join(root, new URL(req.url, 'http://x').pathname);
    if (!path.startsWith(root)) throw new Error('outside root');
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// A checkout without `npx playwright install chromium` skips these instead of failing the suite.
const browser = await chromium.launch().catch(() => undefined);
const skip = browser ? false : 'chromium is not installed: npx playwright install chromium';
after(async () => { await browser?.close(); server.close(); });

const steps = [
  {
    step: 1, plan: 'switch to the upload tab', action: 'opened tab: ~/upload',
    log: { ticker: 'Opening tab: ~/upload', expanded: 'Opened tab: ~/upload', fragment: 'opened tab: ~/upload', fragmentCapitalized: 'Opened tab: ~/upload' },
  },
  {
    step: 2, plan: 'click the "upload" button', action: 'CLICK [5] button "upload"',
    log: { ticker: 'Clicking the "upload" button', expanded: 'Clicked the "upload" button', fragment: 'clicked the "upload" button', fragmentCapitalized: 'Clicked the "upload" button' },
  },
];
const started = Date.parse('2026-09-19T12:00:00Z');
const finished = {
  running: false, status: 'done', cost: 0.0002, steps,
  messages: [
    { role: 'user', text: 'upload the file' },
    { role: 'agent', text: 'uploaded it; the file URL opens.', steps, startedAt: started, endedAt: started + 125_000, stopped: false },
  ],
};

async function panel(state) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const ev = () => ({ addListener() {}, removeListener() {} });
    window.chrome = {
      runtime: {
        sendMessage: async message => (message.type === 'getState'
          ? { state: { running: false, status: 'ready', messages: [], steps: [] }, configured: true, mode: 'careful', model: 'glm-5.3-flash', reasoning: 'low' }
          : { ok: true }),
        onMessage: { addListener: f => { window.onState = f; } }, openOptionsPage() {},
      },
      tabs: { query: async () => [{ id: 1, url: 'https://example.test/', title: 'Example', active: true, windowId: 1, index: 0 }], onCreated: ev(), onRemoved: ev(), onUpdated: ev(), onActivated: ev() },
      storage: { onChanged: ev() },
    };
  });
  await page.goto(`${base}/panel.html`);
  await page.waitForFunction(() => window.onState);
  // A live run's age is measured against the page's own clock at the moment it renders, so a test
  // that cares about it says how old the run is rather than when it started.
  await page.evaluate(s => {
    if (s.startedAgoMs !== undefined) s.startedAt = Date.now() - s.startedAgoMs;
    window.onState({ type: 'state', state: s });
  }, state);
  return page;
}

test('a finished run shows its answer after its own actions and their duration, not before them', { skip }, async () => {
  const page = await panel(finished);
  const order = await page.evaluate(() => [...document.querySelector('.message.agent').children].map(el => el.className || el.tagName.toLowerCase()));
  assert.deepEqual(order, ['message-label', 'steps', 'duration', 'div']);
  assert.equal(await page.locator('.message.agent > div').last().innerText(), 'uploaded it; the file URL opens.');
  // The collapsed summary reads as one lowercase-joined sentence, not a step count or a stack trace.
  assert.equal(await page.locator('.message.agent .steps summary').innerText(), 'Opened tab: ~/upload, clicked the "upload" button');
  assert.equal(await page.locator('.message.agent .duration').innerText(), 'Worked for 2m');
  // The answer is the last thing in the transcript, so autoscroll lands on it; the live steps/duration
  // elements stay in the DOM but hidden, since no run is in flight.
  assert.equal(await page.locator('#steps-wrap').isHidden(), true);
  assert.equal(await page.locator('#live-duration').isHidden(), true);
  await page.close();
});

test('a run the user stopped reads as the user\'s action, not the agent\'s failure', { skip }, async () => {
  const stopped = {
    ...finished, status: 'stopped',
    messages: [
      finished.messages[0],
      { ...finished.messages[1], text: 'stopped', endedAt: started + 40_000, stopped: true },
    ],
  };
  const page = await panel(stopped);
  assert.equal(await page.locator('.message.agent .duration').innerText(), 'You stopped after 40s');
  await page.close();
});

test('a run shorter than one second shows no duration divider at all', { skip }, async () => {
  const instant = { ...finished, messages: [finished.messages[0], { ...finished.messages[1], endedAt: started + 400 }] };
  const page = await panel(instant);
  assert.equal(await page.locator('.message.agent .duration').count(), 0);
  await page.close();
});

test('the live action list only shows while the run is in flight, and ticks a "Working" duration once a second has passed', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAgoMs: 2000, messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#steps-wrap').isVisible(), true);
  assert.equal(await page.locator('#steps-label').innerText(), 'Opened tab: ~/upload, clicked the "upload" button');
  assert.equal(await page.locator('.message.agent').count(), 0);
  assert.equal(await page.locator('#live-duration').innerText(), 'Working');
  await page.close();
});

test('a live run younger than one second shows no duration yet', { skip }, async () => {
  const page = await panel({ ...finished, running: true, status: 'working', startedAgoMs: 0, messages: finished.messages.slice(0, 1) });
  assert.equal(await page.locator('#live-duration').isHidden(), true);
  await page.close();
});

// ---- the pending request card.
const waiting = requests => ({ running: false, status: 'needs_input', cost: 0, steps: [], messages: [{ role: 'user', text: 'do it' }], requests });
// Every answer the panel sends, captured in the page.
const captureSent = page => page.evaluate(() => {
  window.sent = [];
  chrome.runtime.sendMessage = async message => { window.sent.push(message); return { ok: true }; };
});

test('a page that blocked the run says in the panel which check stopped it', { skip }, async () => {
  const page = await panel({ ...finished, status: 'blocked', blockedReason: 'captcha_failed' });
  assert.equal(await page.locator('#blocked').isVisible(), true);
  assert.match(await page.locator('#blocked').innerText(), /captcha/);
  assert.equal(await page.locator('#status-text').innerText(), 'needs your attention');
  // A run that ended cleanly says nothing about being blocked.
  await page.evaluate(s => window.onState({ type: 'state', state: s }), finished);
  assert.equal(await page.locator('#blocked').isHidden(), true);
  await page.close();
});

test('several blocking conditions at once still render one card, the highest priority one', { skip }, async () => {
  const page = await panel(waiting([
    { id: 'plan-1', type: 'plan', question: 'does this plan look right?' },
    { id: 'elicit-1', type: 'elicitation', question: 'which folder?' },
    approvalRequest({ action: 'send the message', origin: 'https://example.test' }),
    { id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'] },
    { id: 'input-1', type: 'user_input', question: 'what name should i put on it?' },
  ]));
  assert.equal(await page.locator('.request-card').count(), 1);
  assert.equal(await page.locator('.request-card').getAttribute('data-request-type'), 'user_input');
  assert.match(await page.locator('.request-question').innerText(), /what name should i put on it/);
  // Drop the winner and the next one down takes the single slot, in priority order.
  await page.evaluate(s => window.onState({ type: 'state', state: s }), waiting([
    { id: 'plan-1', type: 'plan', question: 'does this plan look right?' },
    approvalRequest({ action: 'send the message', origin: 'https://example.test' }),
    { id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'] },
  ]));
  assert.equal(await page.locator('.request-card').count(), 1);
  assert.equal(await page.locator('.request-card').getAttribute('data-request-type'), 'option_picker');
  await page.close();
});

test('a mid-run question offers the choices and a free-text answer beside them', { skip }, async () => {
  const page = await panel(waiting([{ id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'], allowFreeText: true }]));
  assert.deepEqual(await page.locator('.request-options button').allInnerTexts(), ['first', 'second']);
  assert.equal(await page.locator('.request-text').count(), 1);
  await captureSent(page);
  await page.locator('.request-options button').first().click();
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: 'pick-1', outcome: 'submitted', choice: 'first' }]);
  await page.close();
});

test('a picker that allows no answer of its own shows the choices and nothing to type into', { skip }, async () => {
  const page = await panel(waiting([{ id: 'pick-2', type: 'option_picker', question: 'which one?', options: ['first', 'second'] }]));
  assert.deepEqual(await page.locator('.request-options button').allInnerTexts(), ['first', 'second']);
  assert.equal(await page.locator('.request-text').count(), 0);
  // Declining is still on offer: a card with no way out of it is the thing this protocol avoids.
  assert.deepEqual(await page.locator('.request-actions button').allInnerTexts(), ['skip']);
  await page.close();
});

test('an answer already on its way is sent once, however often the button is pressed', { skip }, async () => {
  const page = await panel(waiting([{ id: 'pick-1', type: 'option_picker', question: 'which tab did you mean?', options: ['first', 'second'], allowFreeText: true }]));
  // Hold the answer in flight, the way a busy worker would.
  await page.evaluate(() => {
    window.sent = [];
    chrome.runtime.sendMessage = async message => { window.sent.push(message); return new Promise(() => {}); };
  });
  const first = page.locator('.request-options button').first();
  await first.click();
  assert.equal(await first.isDisabled(), true);
  await page.locator('.request-options button').nth(1).click({ force: true });
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: 'pick-1', outcome: 'submitted', choice: 'first' }]);
  await page.close();
});

test('the handoff form is typed, starts empty, and keeps nothing once it is sent', { skip }, async () => {
  const request = credentialRequest({
    origin: 'https://example.test',
    fields: [
      { id: 1, label: 'Email', inputType: 'email', required: true },
      { id: 2, label: 'Password', inputType: 'password', required: true },
    ],
    signInOptions: ['Continue with Google'],
    submit: { id: 3, label: 'Sign in' },
  });
  const page = await panel(waiting([request]));
  assert.equal(await page.locator('.request-card').getAttribute('data-request-kind'), 'credential');
  assert.deepEqual(
    await page.locator('.request-field input').evaluateAll(els => els.map(e => [e.type, e.autocomplete, e.value])),
    [['email', 'email', ''], ['password', 'current-password', '']],
  );
  await captureSent(page);
  await page.locator('.request-field input').nth(0).fill('me@pcstyle.dev');
  await page.locator('.request-field input').nth(1).fill('hunter2');
  await page.locator('.request-fields button[type=submit]').click();
  const sent = await page.evaluate(() => window.sent);
  assert.deepEqual(sent, [{ type: 'answer', id: request.id, outcome: 'submitted', values: { Email: 'me@pcstyle.dev', Password: 'hunter2' } }]);
  // The panel holds no copy of what was typed once it has gone to the worker.
  assert.deepEqual(await page.locator('.request-field input').evaluateAll(els => els.map(e => e.value)), ['', '']);
  await page.close();
});

test('the widest approval scope is confirmed a second time with the warning spelled out', { skip }, async () => {
  const request = approvalRequest({ action: 'act on any site you open', origin: '*' });
  const page = await panel(waiting([request]));
  assert.deepEqual(await page.locator('.request-actions button').allInnerTexts(), ['allow once', 'allow for this conversation', 'always allow', 'deny']);
  await captureSent(page);
  await page.locator('button[data-scope=always]').click();
  assert.deepEqual(await page.evaluate(() => window.sent), [], 'the widest scope is not granted on the first click');
  assert.match(await page.locator('.confirm-warning').innerText(), /any site you open/);
  await page.locator('.request-actions button').first().click();
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: request.id, outcome: 'submitted', scope: 'always' }]);
  // A single-origin approval is granted on the first click, with no second dialog.
  const oneSite = approvalRequest({ action: 'send the message', origin: 'https://example.test' });
  await page.evaluate(s => window.onState({ type: 'state', state: s }), waiting([oneSite]));
  await captureSent(page);
  await page.locator('button[data-scope=always]').click();
  assert.deepEqual(await page.evaluate(() => window.sent), [{ type: 'answer', id: oneSite.id, outcome: 'submitted', scope: 'always' }]);
  await page.close();
});

test('a run waiting on the user reads as asking, not as ordinary chat text', { skip }, async () => {
  const page = await panel({
    running: false, status: 'needs_input', steps: [],
    messages: [{ role: 'user', text: 'open the readme' }, { role: 'agent', text: 'which README do you mean?', steps }],
    requests: [{ id: 'ask-1', type: 'user_input', question: 'which README do you mean?' }],
  });
  assert.equal(await page.locator('#status-text').innerText(), 'waiting for your answer');
  assert.equal(await page.locator('.message.agent.asking > div').last().innerText(), 'which README do you mean?');
  await page.close();
});

// A pending request used to leave the ordinary chat box fully live: typing "yes" and hitting enter
// silently destroyed the request instead of answering it (the run handler wiped `requests` on a new
// run without declining it first). The composer must go inert, and a submit forced straight at the
// form -- not just a disabled button -- must still be refused.
test('the composer goes inert while a request is pending, and a submit cannot start a run over it', { skip }, async () => {
  const request = { id: 'approve-1', type: 'approval', action: 'submit this $500 order', scopes: [{ id: 'once', label: 'allow once' }], denyLabel: 'deny' };
  const page = await panel(waiting([request]));
  assert.equal(await page.locator('#goal').isDisabled(), true);
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.match(await page.locator('#goal').getAttribute('placeholder'), /answer the request above/);
  await captureSent(page);
  await page.evaluate(() => {
    document.querySelector('#goal').value = 'yes';
    document.querySelector('#task-form').dispatchEvent(new Event('submit', { cancelable: true }));
  });
  assert.deepEqual(await page.evaluate(() => window.sent), [], 'no run message is sent while a request is pending');
  assert.equal(await page.locator('.request-card').count(), 1, 'the pending request card is still there, not silently dropped');
  await page.close();
});

test('once the pending request clears, the composer is available again', { skip }, async () => {
  const page = await panel(waiting([{ id: 'ask-1', type: 'user_input', question: 'which folder?' }]));
  assert.equal(await page.locator('#goal').isDisabled(), true);
  await page.evaluate(s => window.onState({ type: 'state', state: s }), finished);
  assert.equal(await page.locator('#goal').isDisabled(), false);
  assert.equal(await page.locator('#goal').getAttribute('placeholder'), 'say what you need');
  await page.close();
});
