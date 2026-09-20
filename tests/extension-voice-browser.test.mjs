import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const extension = path.resolve('dist/checkto-extension');

async function withInstalledExtension(run) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const permission = await context.newPage();
    const permissionUrl = `chrome-extension://${extensionId}/mic-permission.html`;
    // Chrome may open options_ui once on first install and race this page's first navigation.
    await permission.goto(permissionUrl).catch(() => {});
    if (permission.url() !== permissionUrl) await permission.goto(permissionUrl);
    await permission.locator('#grant').click();
    await permission.waitForFunction(() => document.querySelector('#status').textContent.includes('granted'));
    await run({ context, worker, permission });
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
    assert.match(requests[0].postData, /name="model"\r\n\r\nwhisper-1\r\n/, 'the provider default is sent as the actual model, never a capability sentinel');
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
