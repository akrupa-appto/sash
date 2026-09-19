import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textModel } from './jev.ts';

const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of ['TEXT_MODEL', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PLANNER_MODEL']) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};

test('the text model honours an explicit choice and otherwise falls back to a connected provider', () => {
  assert.equal(withEnv({ OPENROUTER_API_KEY: 'k' }, textModel), 'anthropic/claude-haiku-4.5');
  assert.equal(withEnv({ OPENAI_API_KEY: 'k', PLANNER_MODEL: 'openai:gpt-5.2' }, textModel), 'openai:gpt-5.2');
  assert.equal(withEnv({ OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'r', TEXT_MODEL: 'openai:gpt-5-mini' }, textModel), 'openai:gpt-5-mini');
  assert.throws(() => withEnv({ OPENROUTER_API_KEY: 'r', TEXT_MODEL: 'gemini:gemini-2.5-flash' }, textModel), /GEMINI_API_KEY needed for the text model/);
  assert.throws(() => withEnv({ PLANNER_MODEL: 'openai:gpt-5.2' }, textModel), /OPENROUTER_API_KEY/);
});
