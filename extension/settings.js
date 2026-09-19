export const defaults = {
  provider: 'openrouter', openrouterKey: '', typesafeKey: '',
  model: 'deepseek/deepseek-v4.1-flash', jevModel: '',
  textModel: 'anthropic/claude-haiku-4.5', reasoning: 'auto', mode: 'careful', maxSteps: 30,
};
export function normalizeSettings(input = {}) {
  const out = { ...defaults };
  for (const key of ['openrouterKey', 'typesafeKey', 'model', 'jevModel', 'textModel']) {
    if (typeof input[key] === 'string') out[key] = input[key].trim();
  }
  out.provider = input.provider === 'typesafe' ? 'typesafe' : 'openrouter';
  out.mode = input.mode === 'fast' ? 'fast' : 'careful';
  out.reasoning = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.reasoning) ? input.reasoning : 'auto';
  out.maxSteps = Math.min(60, Math.max(1, Number(input.maxSteps) || 30));
  return out;
}
export function validateSettings(s, mode = s.mode) {
  if (s.provider === 'typesafe' && !s.typesafeKey) throw new Error('add your TypeSafe key in settings');
  if ((s.provider === 'openrouter' || mode === 'careful') && !s.openrouterKey) throw new Error('add your OpenRouter key in settings');
  if (mode === 'careful' && !s.model) throw new Error('choose a planner model in settings');
}
export async function readSettings() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return normalizeSettings((await chrome.storage.local.get('settings')).settings);
}
