import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningChoices, reasoningSummary, findCachedModel } from './public/model-picker.js';

test('reasoning choices follow the model metadata', () => {
  const values = meta => reasoningChoices(meta).map(c => c.value);
  assert.deepEqual(values(undefined), ['auto']);
  assert.deepEqual(values({ mandatory: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'max' }), ['auto', 'low', 'high', 'max']);
  assert.deepEqual(values({ mandatory: false, supported_efforts: ['max', 'high', 'low'] }), ['auto', 'none', 'low', 'high', 'max']);
  assert.deepEqual(values({ mandatory: false, supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'] }), ['auto', 'none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(values({ mandatory: false, supported_efforts: null }), ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(values({ mandatory: false, default_enabled: true }), ['auto', 'none'], 'reasoning without effort selection is on/off only');
  assert.deepEqual(values({ mandatory: true }), ['auto']);
  assert.match(reasoningChoices({ mandatory: true, supported_efforts: ['high', 'low'] })[0].hint, /cannot turn reasoning off/);
  assert.equal(reasoningChoices({ mandatory: false, supported_efforts: ['high', 'low'], default_effort: 'high' }).find(c => c.value === 'high').hint, 'model default');
  assert.equal(reasoningSummary(undefined), 'no reasoning');
  assert.equal(reasoningSummary({ mandatory: true, default_effort: 'max' }), 'reasoning always on · default maximum');
  assert.equal(reasoningSummary({ mandatory: false, default_enabled: false }), 'reasoning off by default');
});

test('a custom model ID already in the cached OpenRouter list gets its real reasoning options, not just auto', () => {
  const cachedModels = [
    { id: 'plain/model', name: 'Plain' },
    { id: 'some-org/custom-model-v2', name: 'Custom Model v2', reasoning: { mandatory: false, supported_efforts: ['high', 'medium', 'low'] } },
  ];
  // Present in the cache: real metadata is found and used.
  const found = findCachedModel(cachedModels, 'some-org/custom-model-v2');
  assert.equal(found?.name, 'Custom Model v2');
  assert.deepEqual(reasoningChoices(found?.reasoning).map(c => c.value), ['auto', 'none', 'low', 'medium', 'high']);
  // Not present in the cache: falls back to the generic "auto only" custom-ID metadata.
  const missing = findCachedModel(cachedModels, 'unknown-org/unknown-model');
  assert.equal(missing, undefined);
  assert.deepEqual(reasoningChoices(missing ? missing.reasoning : { supported_efforts: null, mandatory: false }).map(c => c.value), ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  // No cache yet for the provider (undefined list): does not throw, behaves as not found.
  assert.equal(findCachedModel(undefined, 'some-org/custom-model-v2'), undefined);
});
