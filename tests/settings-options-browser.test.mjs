// Real Chrome, real built extension: the settings controls the owner asked for, read through the
// page's own form. What is asserted here is the payload "save settings" submits, because the form is
// the boundary between this page and the engine layer: extension/settings.js owns normalization and
// the stored keys (approvalMode, siteAccessMode, transcriptionModel), extension/options.js owns the
// controls and the mapping into them.
//
// Deliberately not asserted here: that a saved value comes back after a reload. normalizeSettings()
// drops keys it does not know yet, so the round trip only exists once the engine layer lands those
// three keys in extension/settings.js. This file is written to pass both before and after that lands,
// rather than encoding the current gap as expected behavior.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
const extension = path.resolve('dist/checkto-extension');
// A checkout without `npx playwright install chromium` skips these instead of failing the suite,
// the same way access-settings-native.test.mjs does.
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true, viewport: { width: 760, height: 1600 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
}).catch(() => undefined);
const skip = context ? false : 'chromium is not installed: npx playwright install chromium';
after(() => context?.close());
const worker = context
  ? (context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 }))
  : undefined;
const extensionId = worker ? new URL(worker.url()).host : '';

async function settingsPage() {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `chrome-extension://${extensionId}/settings.html`;
  await page.goto(url).catch(error => { if (page.url() !== url) throw error; });
  // The speech-to-text list is built from the keys typed in the form, so the placeholder option is
  // the signal that options.js has run to completion.
  await page.waitForFunction(() => document.querySelectorAll('#transcriptionModel option').length > 0);
  return { page, errors };
}
const payload = page => page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('#settings'))));
const optionValues = page => page.$$eval('#transcriptionModel option', options => options.map(option => option.value));

test('the in-page nav reaches every section of the one-pager', { skip }, async () => {
  const { page, errors } = await settingsPage();
  const targets = await page.$$eval('.settings-nav a', links => links.map(link => link.getAttribute('href')));
  assert.deepEqual(targets, ['#connections', '#agent-preferences', '#voice', '#access-settings']);
  for (const target of targets) assert.equal(await page.locator(target).count(), 1, `${target} must be a real section`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('action approvals offers three plain-language choices and defaults to asking every time', { skip }, async () => {
  const { page } = await settingsPage();
  const values = await page.$$eval('input[name=approvalMode]', radios => radios.map(radio => radio.value));
  assert.deepEqual(values, ['every', 'risky', 'none']);
  assert.equal(await page.locator('input[name=approvalMode]:checked').inputValue(), 'every');
  // Each choice explains itself in place — a setting with this much consequence must not be a bare
  // word in a dropdown — and the loud default says so out loud.
  for (const value of values) assert.equal(await page.locator(`label.choice:has(input[value=${value}])`).locator('small').count(), 1);
  assert.match(await page.locator('#access-settings').innerText(), /prompts a lot on purpose/);
  assert.match(await page.locator('label.choice:has(input[value=risky])').innerText(), /spending/);
  assert.match(await page.locator('label.choice:has(input[value=risky])').innerText(), /sending/);
  assert.match(await page.locator('label.choice:has(input[value=none])').innerText(), /can send or spend|sending and spending/);
  await page.locator('input[name=approvalMode][value=none]').check();
  assert.equal((await payload(page)).approvalMode, 'none');
  await page.close();
});

test('site access chooses between asking per site and allowing every site, kept separate from approvals', { skip }, async () => {
  const { page } = await settingsPage();
  const values = await page.$$eval('input[name=siteAccessMode]', radios => radios.map(radio => radio.value));
  assert.deepEqual(values, ['ask', 'all']);
  assert.equal(await page.locator('input[name=siteAccessMode]:checked').inputValue(), 'ask');
  const copy = await page.locator('#access-settings').innerText();
  assert.match(copy, /Chrome's access to a site, not individual actions/);
  assert.match(copy, /allow every site without asking/);
  await page.locator('input[name=siteAccessMode][value=all]').check();
  const saved = await payload(page);
  assert.equal(saved.siteAccessMode, 'all');
  assert.equal(saved.approvalMode, 'every', 'the two controls never write each other');
  await page.close();
});

test('speech-to-text is a separate picker: only configured providers are offered, and never a deprecated id', { skip }, async () => {
  const { page } = await settingsPage();
  // Nothing typed yet: the only honest choice is to defer to the planner's provider.
  assert.deepEqual(await optionValues(page), ['']);
  assert.match(await page.locator('#voice').innerText(), /a text model cannot listen to audio/);

  await page.locator('#openrouterKey').fill('openrouter-test-key');
  const openrouter = await optionValues(page);
  for (const spec of ['openrouter:openai/gpt-transcribe', 'openrouter:meta/muse-voice-transcribe-1.0', 'openrouter:deepgram/nova-3', 'openrouter:nvidia/parakeet-tdt-0.6b-v3', 'openrouter:google/chirp-3']) {
    assert.ok(openrouter.includes(spec), `${spec} must be offered with an OpenRouter key`);
  }
  assert.equal(openrouter.includes('openai:gpt-transcribe'), false, 'an OpenAI model needs an OpenAI key');

  await page.locator('#openaiKey').fill('openai-test-key');
  await page.locator('#geminiKey').fill('gemini-test-key');
  const all = await optionValues(page);
  assert.ok(all.includes('openai:gpt-transcribe') && all.includes('gemini:gemini-3.5-transcribe'));

  // The owner rejected this list by name. None of it may reappear, as a value or as visible text.
  for (const rejected of ['whisper-1', 'openai:whisper-1', 'openai/gpt-4o-transcribe', 'openai:gpt-4o-transcribe', 'openai:gpt-4o-mini-transcribe', 'gemini:gemini-2.5-flash', 'openai:gemini-2.5-flash']) {
    assert.equal(all.includes(rejected), false, `${rejected} must not be offered`);
  }
  const labels = await page.$$eval('#transcriptionModel option', options => options.map(option => option.textContent));
  assert.doesNotMatch(labels.join(' | '), /whisper|gpt-4o|2\.5/);
  assert.match(labels.join(' | '), /recommended/);

  // Choosing a model is also how the provider for audio is chosen: one control, so the two cannot
  // disagree. voiceProvider is still a real stored setting (extension/background.js reads it).
  await page.locator('#transcriptionModel').selectOption('openai:gpt-transcribe');
  const chosen = await payload(page);
  assert.equal(chosen.transcriptionModel, 'openai:gpt-transcribe');
  assert.equal(chosen.voiceProvider, 'openai');
  assert.match(await page.locator('#transcription-detail').innerText(), /OpenAI's current speech model/);

  await page.locator('#transcriptionModel').selectOption('openrouter:nvidia/parakeet-tdt-0.6b-v3');
  assert.equal((await payload(page)).voiceProvider, 'openrouter');
  await page.locator('#transcriptionModel').selectOption('');
  const fallback = await payload(page);
  assert.equal(fallback.transcriptionModel, '');
  assert.equal(fallback.voiceProvider, '', '"same as my planner model" is the empty spec, as transcribe.ts reads it');

  // A key removed above takes its models with it.
  await page.locator('#openrouterKey').fill('');
  assert.deepEqual(await optionValues(page), ['', 'openai:gpt-transcribe', 'gemini:gemini-3.5-transcribe']);
  await page.close();
});

test('the new controls do not break the narrow layout', { skip }, async () => {
  const { page, errors } = await settingsPage();
  await page.locator('#openaiKey').fill('openai-test-key');
  await page.setViewportSize({ width: 390, height: 1600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('#transcriptionModel').isVisible(), true);
  assert.deepEqual(errors, []);
  await page.close();
});
