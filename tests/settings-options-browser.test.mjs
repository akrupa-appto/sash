// Real Chrome, real built extension: the settings controls the owner asked for, read through the
// page's own form. What is asserted here is the payload "save settings" submits, because the form is
// the boundary between this page and the engine layer: extension/settings.js owns normalization and
// the stored keys (approvalMode, siteAccessMode, transcriptionModel), extension/options.js owns the
// controls and the mapping into them.
//
// The speech-to-text list is fetched live from OpenRouter's transcription catalog, so it is held to
// a fixture here (a real capture, trimmed to the fields the picker reads): the live path, the
// intermediate state while the fetch is in flight, and the offline path are each deterministic, and
// no test depends on OpenRouter being up. `offline` is the default every other test runs against —
// that is the fallback list, which is what the rest of this file was written against.
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

// GET https://openrouter.ai/api/v1/models?output_modalities=transcription, captured 2026-09-20 and
// cut to the fields ModelInfo is built from. microsoft/mai-transcribe-2 is the row that proves the
// swap happened: it is not in the fallback list. The three deprecated ids are in here on purpose —
// the catalog still publishes them, and the picker must not show them.
const LIVE_CATALOG = [
  { id: 'meta/muse-voice-transcribe-1.0', name: 'Meta: Muse Voice Transcribe 1.0', context_length: 0, pricing: { prompt: '0.00005', completion: '0' } },
  { id: 'microsoft/mai-transcribe-2', name: 'Microsoft AI: MAI-Transcribe 2', context_length: 0, pricing: { prompt: '0.1', completion: '0' } },
  { id: 'openai/gpt-transcribe', name: 'OpenAI: GPT Transcribe', context_length: 0, pricing: { prompt: '0.000075', completion: '0' } },
  { id: 'deepgram/nova-3', name: 'Deepgram: Nova-3', context_length: 0, pricing: { prompt: '0.0000716666666667', completion: '0' } },
  { id: 'google/chirp-3', name: 'Google: Chirp 3', context_length: 0, pricing: { prompt: '0.000266666666667', completion: '0' } },
  { id: 'openai/whisper-1', name: 'OpenAI: Whisper 1', context_length: 0, pricing: { prompt: '0.0001', completion: '0' } },
  { id: 'openai/gpt-4o-transcribe', name: 'OpenAI: GPT-4o Transcribe', context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' } },
  { id: 'openai/gpt-4o-mini-transcribe', name: 'OpenAI: GPT-4o Mini Transcribe', context_length: 128000, pricing: { prompt: '0.00000125', completion: '0.000005' } },
];
// One synthetic row, and deliberately the only one: the token-priced sentence in catalogFacts is not
// reachable from the real catalog today, because its two token-priced entries are the deprecated
// OpenAI ids this picker refuses to offer. The branch is still worth asserting — the catalog gains
// speech models — but not by putting a made-up completion price on a real model's name, so the row
// carries an id no catalog claims, in the same shape the API publishes.
const TOKEN_PRICED = { id: 'example/token-priced-transcribe', name: 'Example: Token Priced Transcribe', context_length: 64000, pricing: { prompt: '0.0000025', completion: '0.00001' } };
// Offline: the request fails before it reaches a server, the same shape as no network.
const offline = route => route.abort('failed');
// A catalog that answers, optionally late enough that the state before it lands can be read.
const served = (models, delay = 0) => async route => {
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: models }) });
};
// A server that answers with an error: not offline, but still nothing to list.
const refused = status => route => route.fulfill({ status, contentType: 'text/plain', body: 'nope' });

async function settingsPage({ transcription = offline } = {}) {
  const page = await context.newPage();
  const errors = [];
  // Every catalog request the page made, headers included. The route is the only place the request
  // itself is visible, and options.js's refreshTranscriptionModels hands listTranscriptionModels the
  // key typed in the form as its second argument — a stub that answers whatever it is asked would let
  // `listTranscriptionModels(request.signal)` drop that argument with every assertion here still
  // passing, since only the argument the function itself reads is covered. See catalogCarriesTypedKey.
  const catalog = [];
  page.on('pageerror', error => errors.push(error.message));
  // Only the transcription catalog is stubbed: the planner's own model list is left alone.
  await page.route(url => url.href.startsWith('https://openrouter.ai/api/v1/models') && url.href.includes('output_modalities=transcription'), route => {
    catalog.push(route.request().headers());
    return transcription(route);
  });
  const url = `chrome-extension://${extensionId}/settings.html`;
  await page.goto(url).catch(error => { if (page.url() !== url) throw error; });
  // The speech-to-text list is built from the keys typed in the form, so the placeholder option is
  // the signal that options.js has run to completion.
  await page.waitForFunction(() => document.querySelectorAll('#transcriptionModel option').length > 0);
  return { page, errors, catalog };
}
const payload = page => page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('#settings'))));
const optionValues = page => page.$$eval('#transcriptionModel option', options => options.map(option => option.value));
// The newest catalog request must carry the key the form is showing: that is what
// `listTranscriptionModels(signal, key)` as a whole does, not just what its own parameter holds.
// options.js refires this per keystroke, so the last request is the one the value on screen earned.
async function catalogCarriesTypedKey(page, catalog) {
  const newest = catalog.at(-1);
  assert.ok(newest, 'the transcription catalog request must have been made');
  assert.equal(newest.authorization, `Bearer ${await page.locator('#openrouterKey').inputValue()}`);
}

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
  // None of the three choices may promise something a run without a planner cannot do: a fast run
  // asks nothing at any approval mode, so the control itself has to say where these choices apply.
  assert.match(await page.locator('#access-settings').innerText(), /a fast run has no planner, so it never stops to ask/);
  assert.match(await page.locator('#access-settings').innerText(), /only apply in careful mode/);
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
  // Bare ids, not "openrouter:…": parseModel() in src/providers.ts resolves anything without an
  // openai/gemini/custom prefix to OpenRouter and passes the whole string as the model id, so a
  // prefixed spec would be requested as a model literally named "openrouter:openai/gpt-transcribe".
  for (const spec of ['openai/gpt-transcribe', 'meta/muse-voice-transcribe-1.0', 'deepgram/nova-3', 'nvidia/parakeet-tdt-0.6b-v3', 'google/chirp-3']) {
    assert.ok(openrouter.includes(spec), `${spec} must be offered with an OpenRouter key`);
  }
  assert.equal(openrouter.some(spec => spec.startsWith('openrouter:')), false, 'no option may carry an "openrouter:" prefix, which parseModel cannot read');
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

  await page.locator('#transcriptionModel').selectOption('nvidia/parakeet-tdt-0.6b-v3');
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

test('the OpenRouter speech list is its live catalog: recommended first, catalog names, official-API rows kept, selection held across the swap', { skip }, async () => {
  const { page, errors, catalog } = await settingsPage({ transcription: served([...LIVE_CATALOG, TOKEN_PRICED], 300) });
  await page.locator('#openaiKey').fill('openai-test-key');
  await page.locator('#geminiKey').fill('gemini-test-key');
  await page.locator('#openrouterKey').fill('openrouter-test-key');
  // While the fetch is in flight the picker is the fallback list, not an empty one.
  const before = await optionValues(page);
  assert.ok(before.includes('google/chirp-3'), 'the fallback rows are on screen before the catalog lands');
  await page.locator('#transcriptionModel').selectOption('google/chirp-3');
  await page.waitForFunction(() => [...document.querySelectorAll('#transcriptionModel option')].some(option => option.value === 'microsoft/mai-transcribe-2'));
  await catalogCarriesTypedKey(page, catalog);

  // The recommended model is pinned first whatever order the catalog published; the rest keep the
  // catalog's own order; the deprecated ids are gone even though the catalog lists them, and the
  // rows for the keys typed above are still there.
  assert.deepEqual(await optionValues(page), [
    '', 'openai/gpt-transcribe', 'meta/muse-voice-transcribe-1.0', 'microsoft/mai-transcribe-2', 'deepgram/nova-3', 'google/chirp-3',
    'example/token-priced-transcribe',
    'openai:gpt-transcribe', 'gemini:gemini-3.5-transcribe',
  ]);
  assert.equal(await page.locator('#transcriptionModel').inputValue(), 'google/chirp-3', 'the swap must not change what is selected');
  const labels = await page.$$eval('#transcriptionModel option', options => options.map(option => option.textContent));
  assert.ok(labels.includes('OpenAI: GPT Transcribe'), `the label is the catalog name: ${labels.join(' | ')}`);
  // Live rows are not tagged with notes this file wrote, and the deprecated ids and their names are
  // absent even though the catalog answered with all three.
  assert.equal(labels.some(label => /recommended|whisper 1|gpt-4o/i.test(label)), false, labels.join(' | '));

  // A live row explains itself from the catalog: its name and the price the catalog published.
  await page.locator('#transcriptionModel').selectOption('microsoft/mai-transcribe-2');
  const detail = await page.locator('#transcription-detail').innerText();
  assert.match(detail, /MAI-Transcribe 2/);
  assert.match(detail, /\$0\.1 per second of audio/);
  // Except when the price is not a per-second one: a row the catalog bills per token (it carries a
  // non-zero completion price, which is the only signal the payload gives) says so, because its input
  // figure is USD per 1M tokens and calling it a per-second rate would be wrong by orders of magnitude.
  await page.locator('#transcriptionModel').selectOption('example/token-priced-transcribe');
  const priced = await page.locator('#transcription-detail').innerText();
  assert.match(priced, /\$2\.5 per 1M input tokens/);
  assert.doesNotMatch(priced, /per second/);
  assert.match(priced, /64000 token context/);
  // The recommended row keeps the sentence this page wrote about it.
  await page.locator('#transcriptionModel').selectOption('openai/gpt-transcribe');
  assert.match(await page.locator('#transcription-detail').innerText(), /best all-round choice/);
  assert.equal((await payload(page)).voiceProvider, 'openrouter', 'a live row still derives its provider');
  assert.deepEqual(errors, []);
  await page.close();
});

test('a catalog that cannot be read leaves the fallback rows in place, offline or refused', { skip }, async () => {
  for (const [name, transcription] of [['offline', offline], ['refused', refused(503)]]) {
    let attempted = 0;
    const { page, errors, catalog } = await settingsPage({ transcription: route => { attempted++; return transcription(route); } });
    await page.locator('#openrouterKey').fill('openrouter-test-key');
    // The request was made and failed; the list is what it was before it.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(attempted > 0, `${name}: the catalog request must have been attempted`);
    await catalogCarriesTypedKey(page, catalog);
    assert.deepEqual(await optionValues(page), [
      '', 'openai/gpt-transcribe', 'meta/muse-voice-transcribe-1.0', 'deepgram/nova-3', 'nvidia/parakeet-tdt-0.6b-v3', 'google/chirp-3',
    ]);
    assert.equal(await page.locator('#transcriptionModel').inputValue(), '', `${name}: a stale list is fine, a broken picker is not`);
    assert.deepEqual(errors, []);
    await page.close();
  }
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
