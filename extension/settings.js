import { parseModel } from '../src/providers.ts';
export const PROVIDER_KEYS = { openrouter: 'openrouterKey', openai: 'openaiKey', gemini: 'geminiKey', custom: 'customKey' };
export const defaults = {
  provider: 'openrouter', openrouterKey: '', typesafeKey: '', openaiKey: '', geminiKey: '', customKey: '', customBaseUrl: '',
  model: 'deepseek/deepseek-v4.1-flash', jevModel: '',
  textModel: 'anthropic/claude-haiku-4.5', reasoning: 'auto', mode: 'careful', maxSteps: 30,
  // Voice dictation (stage 2). voiceProvider empty = dictate with whatever provider backs the
  // planner model (BYOK, same as transcribe.ts's own default); set to one of PROVIDER_KEYS' keys to
  // use a different configured provider for audio than for planning.
  voiceEnabled: false, voiceMode: 'prewarm', voiceProvider: '',
  // Speech-to-text is a different job from chat, so it gets its own model choice. Empty means "the
  // provider backing the planner model, that provider's own default transcription model"; anything
  // else is a provider spec like "openai:gpt-transcribe" or a bare OpenRouter id like
  // "openai/gpt-transcribe" (see providers.ts parseModel: no prefix means OpenRouter).
  transcriptionModel: '',
  // approvals: 'every' asks before every action that changes the page, 'risky' only for what the
  // planner judges worth authorising (the original behaviour), 'none' never asks.
  approvalMode: 'every',
  // site access: 'ask' shows Chrome's per-site card the first time, 'all' means the user already
  // granted every site from settings, so no card is needed.
  siteAccessMode: 'ask',
};
export function normalizeSettings(input = {}) {
  const out = { ...defaults };
  for (const key of ['openrouterKey', 'typesafeKey', 'openaiKey', 'geminiKey', 'customKey', 'customBaseUrl', 'model', 'jevModel', 'textModel']) {
    if (typeof input[key] === 'string') out[key] = input[key].trim();
  }
  if (typeof input.transcriptionModel === 'string') out.transcriptionModel = input.transcriptionModel.trim();
  out.customBaseUrl = out.customBaseUrl.replace(/\/+$/, '');
  out.provider = input.provider === 'typesafe' ? 'typesafe' : 'openrouter';
  out.approvalMode = ['every', 'risky', 'none'].includes(input.approvalMode) ? input.approvalMode : 'every';
  out.siteAccessMode = input.siteAccessMode === 'all' ? 'all' : 'ask';
  out.mode = input.mode === 'fast' ? 'fast' : 'careful';
  out.reasoning = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoning) ? input.reasoning : 'auto';
  out.maxSteps = Math.min(60, Math.max(1, Number(input.maxSteps) || 30));
  out.voiceEnabled = input.voiceEnabled === true || input.voiceEnabled === 'on' || input.voiceEnabled === 'true';
  out.voiceMode = ['dictate', 'prewarm', 'eager'].includes(input.voiceMode) ? input.voiceMode : 'prewarm';
  out.voiceProvider = ['openrouter', 'openai', 'gemini', 'custom'].includes(input.voiceProvider) ? input.voiceProvider : '';
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
