import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningChoices, reasoningSummary } from './public/model-picker.js';

test('reasoning choices follow the model metadata', () => {
  const values = meta => reasoningChoices(meta).map(c => c.value);
  assert.deepEqual(values(undefined), ['auto']);
  assert.deepEqual(values({ mandatory: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'max' }), ['auto', 'low', 'high', 'max']);
  assert.deepEqual(values({ mandatory: false, supported_efforts: ['max', 'high', 'low'] }), ['auto', 'none', 'low', 'high', 'max']);
  assert.deepEqual(values({ mandatory: false, supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'] }), ['auto', 'none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(values({ mandatory: false, supported_efforts: null }), ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.match(reasoningChoices({ mandatory: true, supported_efforts: ['high', 'low'] })[0].hint, /cannot turn reasoning off/);
  assert.equal(reasoningChoices({ mandatory: false, supported_efforts: ['high', 'low'], default_effort: 'high' }).find(c => c.value === 'high').hint, 'model default');
  assert.equal(reasoningSummary(undefined), 'no reasoning');
  assert.equal(reasoningSummary({ mandatory: true, default_effort: 'max' }), 'reasoning always on · default maximum');
  assert.equal(reasoningSummary({ mandatory: false, default_enabled: false }), 'reasoning off by default');
});
