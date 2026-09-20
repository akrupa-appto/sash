import { parseModel } from '../src/providers.ts';
export const PROVIDER_KEYS = { openrouter: 'openrouterKey', openai: 'openaiKey', gemini: 'geminiKey', custom: 'customKey' };
export const defaults = {
  provider: 'openrouter', openrouterKey: '', typesafeKey: '', openaiKey: '', geminiKey: '', customKey: '', customBaseUrl: '',
  model: 'deepseek/deepseek-v4.1-flash', jevModel: '',
  textModel: 'anthropic/claude-haiku-4.5', reasoning: 'auto', mode: 'careful', maxSteps: 30,
};
export function normalizeSettings(input = {}) {
  const out = { ...defaults };
  for (const key of ['openrouterKey', 'typesafeKey', 'openaiKey', 'geminiKey', 'customKey', 'customBaseUrl', 'model', 'jevModel', 'textModel']) {
    if (typeof input[key] === 'string') out[key] = input[key].trim();
  }
  out.customBaseUrl = out.customBaseUrl.replace(/\/+$/, '');
  out.provider = input.provider === 'typesafe' ? 'typesafe' : 'openrouter';
  out.mode = input.mode === 'fast' ? 'fast' : 'careful';
  out.reasoning = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoning) ? input.reasoning : 'auto';
  out.maxSteps = Math.min(60, Math.max(1, Number(input.maxSteps) || 30));
  return out;
}
// Jev runs through OpenRouter or TypeSafe. The planner runs on the provider its model names
// (OpenRouter by default, "openai:" or "gemini:" for the official APIs) and needs that provider's key.
// The custom provider is usable only with an https base URL (http is allowed for localhost servers).
export const customOrigin = base => { try { const u = new URL(base); return (u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) ? u.origin : undefined; } catch { return undefined; } };
export function validateSettings(s, mode = s.mode) {
  if (s.provider === 'typesafe' && !s.typesafeKey) throw new Error('add your TypeSafe key in settings');
  if ((s.customBaseUrl || s.customKey) && !customOrigin(s.customBaseUrl)) throw new Error('the custom provider needs an https base URL ending in /v1, such as https://api.groq.com/openai/v1');
  if (s.provider === 'openrouter' && !s.openrouterKey) throw new Error('add your OpenRouter key in settings');
  if (mode === 'careful') {
    if (!s.model) throw new Error('choose a planner model in settings');
    const { provider } = parseModel(s.model);
    const labels = { openrouter: 'OpenRouter', openai: 'OpenAI', gemini: 'Gemini', custom: 'custom provider' };
    if (!s[PROVIDER_KEYS[provider]]) throw new Error(`add your ${labels[provider]} key in settings for the planner model`);
  }
}
export async function readSettings() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return normalizeSettings((await chrome.storage.local.get('settings')).settings);
}
