import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const extension = path.resolve('dist/sash-extension');

// `fakeUi` is Chrome's automatic permission answer: without it the first getUserMedia has to ask, and
// headless Chromium has nowhere to show that prompt, so it comes back as "Permission dismissed" — the
// state the full-tab grant page exists for. `grantMic: false` skips the pre-granted page so a test can
// exercise that first-run path.
async function withInstalledExtension(run, { fakeUi = true, grantMic = true } = {}) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--use-fake-device-for-media-stream',
      ...(fakeUi ? ['--use-fake-ui-for-media-stream'] : []),
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    let permission;
    if (grantMic) {
      permission = await context.newPage();
      const permissionUrl = `chrome-extension://${extensionId}/mic-permission.html`;
      // Chrome may open options_ui once on first install and race this page's first navigation.
      await permission.goto(permissionUrl).catch(() => {});
      if (permission.url() !== permissionUrl) await permission.goto(permissionUrl);
      await permission.locator('#grant').click();
      await permission.waitForFunction(() => document.querySelector('#status').textContent.includes('granted'));
    }
    await run({ context, worker, extensionId, permission });
  } finally {
    await context.close();
  }
}

const offscreenCount = worker => worker.evaluate(async () =>
  (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
const send = (page, message) => page.evaluate(message => chrome.runtime.sendMessage(message), message);
const settings = overrides => ({
  openrouterKey: 'planner-key',
  model: 'deepseek/deepseek-v4.1-flash',
  voiceEnabled: true,
  voiceMode: 'dictate',
  ...overrides,
});

test('installed extension sends fake-device audio to the explicitly selected voice provider and cleans up', { timeout: 30_000 }, async () => {
  await withInstalledExtension(async ({ worker, permission }) => {
    await permission.evaluate(value => chrome.storage.local.set({ settings: value }), settings({
      openaiKey: 'voice-key',
      voiceProvider: 'openai',
    }));

    const started = await send(permission, { type: 'dictation:start' });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(await offscreenCount(worker), 1);
    // Browser-context routes do not see extension-process fetches. Attach Fetch interception to the
    // offscreen document's own DevTools target so this proves the request that context actually made.
    await worker.evaluate(async () => {
      const target = (await chrome.debugger.getTargets()).find(item => item.url.endsWith('/offscreen.html'));
      if (!target) throw new Error('offscreen DevTools target not found');
      const debuggee = { targetId: target.id };
      globalThis.__voiceRequests = [];
      chrome.debugger.onEvent.addListener((source, method, params) => {
        if (source.targetId !== target.id || method !== 'Fetch.requestPaused') return;
        globalThis.__voiceRequests.push(params.request);
        void chrome.debugger.sendCommand(debuggee, 'Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: btoa(JSON.stringify({ text: 'synthetic transcript' })),
        });
      });
      await chrome.debugger.attach(debuggee, '1.3');
      await chrome.debugger.sendCommand(debuggee, 'Fetch.enable', { patterns: [{ urlPattern: 'https://api.openai.com/v1/audio/transcriptions' }] });
    });
    await permission.waitForTimeout(300);

    const stopped = await send(permission, { type: 'dictation:stop' });
    assert.deepEqual(stopped, { ok: true, text: 'synthetic transcript' });
    const requests = await worker.evaluate(() => globalThis.__voiceRequests);
    assert.equal(requests.length, 1, 'one final transcription request is made');
    assert.equal(requests[0].headers.Authorization, 'Bearer voice-key', 'the selected voice key is used instead of the planner key');
    assert.match(requests[0].headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert.ok(requests[0].postData?.length > 200, 'the multipart request contains recorded audio bytes');
    assert.match(requests[0].postData, /name="model"\r\n\r\ngpt-transcribe\r\n/, 'the provider default is sent as the actual model, never a capability sentinel');
    assert.match(requests[0].postData, /name="file"; filename="dictation\.webm"/);
    assert.equal(await offscreenCount(worker), 0, 'the offscreen mic context closes after successful transcription');
  });
});

test('installed extension reports a missing key for the selected voice provider and still cleans up', { timeout: 30_000 }, async () => {
  await withInstalledExtension(async ({ worker, permission }) => {
    await permission.evaluate(value => chrome.storage.local.set({ settings: value }), settings({ voiceProvider: 'openai' }));
    const started = await send(permission, { type: 'dictation:start' });
    assert.equal(started.ok, true, JSON.stringify(started));
    await permission.waitForTimeout(300);

    const stopped = await send(permission, { type: 'dictation:stop' });
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /OpenAI needs an API key to transcribe audio/);
    assert.equal(await offscreenCount(worker), 0, 'the offscreen mic context closes after failed transcription');
  });
});

// Chrome's own plumbing for a message channel that went away mid-request. It is never the provider's
// failure and must never be shown to the user as one.
const CHROME_PLUMBING = /message channel closed|listener indicated an asynchronous response|receiving end does not exist|offscreen document closed|message port closed/i;

test('a quick tap on the mic never surfaces Chrome\'s channel plumbing and leaves no session behind', { timeout: 30_000 }, async () => {
  await withInstalledExtension(async ({ context, worker, extensionId, permission }) => {
    await permission.evaluate(value => chrome.storage.local.set({ settings: value }), settings({
      openaiKey: 'voice-key',
      voiceProvider: 'openai',
    }));
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.waitForSelector('#goal');
    await panel.waitForTimeout(300);
    assert.equal(await panel.locator('#mic').isVisible(), true, 'the mic must be usable for this tap to mean anything');

    // A real tap on the real button: press and release with nothing in between, so the stop reaches
    // the worker while the mic is still opening. Before the fix the stop's teardown closed the
    // offscreen document with the start's reply outstanding, and the panel printed Chrome's string.
    await panel.locator('#mic').dispatchEvent('pointerdown');
    await panel.locator('#mic').dispatchEvent('pointerup');
    await panel.waitForTimeout(2500);

    const json = JSON.stringify(await panel.evaluate(async () => ({
      error: document.querySelector('#error').textContent,
      title: document.querySelector('#error').getAttribute('title'),
      dictation: (await chrome.runtime.sendMessage({ type: 'getState' })).state?.dictation,
    })));
    assert.doesNotMatch(json, CHROME_PLUMBING, `Chrome's plumbing must not reach the panel or its state, got: ${json}`);
    assert.equal(await offscreenCount(worker), 0, 'the tap leaves no offscreen document (and so no hot mic) behind');
  });
});

// With no mic grant yet, the first press cannot open the mic and the worker opens the full-tab grant
// page. Before the fix every further press opened another copy of it (and Chrome logged "Navigation to
// .../mic-permission.html is interrupted by another navigation to .../mic-permission.html"); the page
// that is already open has to be the one the user is sent back to.
test('a repeated mic permission failure focuses the grant page instead of opening a second one', { timeout: 30_000 }, async () => {
  await withInstalledExtension(async ({ context, worker, extensionId }) => {
    await worker.evaluate(value => chrome.storage.local.set({ settings: value }), settings({
      openaiKey: 'voice-key',
      voiceProvider: 'openai',
    }));
    const permissionUrl = `chrome-extension://${extensionId}/mic-permission.html`;
    const permissionPages = () => context.pages().filter(page => page.url() === permissionUrl);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.waitForSelector('#goal');
    await panel.waitForTimeout(300);

    const first = await send(panel, { type: 'dictation:start' });
    assert.equal(first.ok, false, JSON.stringify(first));
    assert.equal(first.needsPermissionTab, true, JSON.stringify(first));
    await panel.waitForTimeout(500);
    assert.equal(permissionPages().length, 1, 'the first failure opens the one-time grant page');

    const second = await send(panel, { type: 'dictation:start' });
    assert.equal(second.needsPermissionTab, true, JSON.stringify(second));
    await panel.waitForTimeout(500);
    assert.equal(permissionPages().length, 1, 'a second failure must focus that page, never open another copy');
  }, { fakeUi: false, grantMic: false });
});
