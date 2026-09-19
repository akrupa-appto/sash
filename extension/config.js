// Replaces the server's environment module in the extension build only.
export const env = {};
export function debugLog() {}
export function configure(settings) {
  clearConfig();
  if (settings.provider === 'typesafe') env.TYPESAFE_API_KEY = settings.typesafeKey;
  env.OPENROUTER_API_KEY = settings.openrouterKey;
  if (settings.openaiKey) env.OPENAI_API_KEY = settings.openaiKey;
  if (settings.geminiKey) env.GEMINI_API_KEY = settings.geminiKey;
  env.PLANNER_MODEL = settings.model;
  if (settings.jevModel) env.JEV_MODEL = settings.jevModel;
  if (settings.textModel) env.TEXT_MODEL = settings.textModel;
}
export function clearConfig() { for (const key of Object.keys(env)) delete env[key]; }
