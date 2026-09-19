import { defaults, normalizeSettings, readSettings, validateSettings, PROVIDER_KEYS, customOrigin } from './settings.js';
import { createModelPicker } from '../public/model-picker.js';
import { listModels, PROVIDERS, providerLabel } from '../providers.ts';
import { configure, clearConfig } from '../env.ts';
const form = document.querySelector('#settings');
const status = document.querySelector('#status');
function show(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
let picker, pickerProviders = '';
function render(settings) {
  for (const key of Object.keys(defaults)) form.elements[key].value = settings[key];
  document.querySelector('#typesafe-field').hidden = settings.provider !== 'typesafe';
  ensurePicker()?.warm(current().model).then(renderModel).catch(() => {});
  renderModel();
}
const current = () => ({ model: form.elements.model.value, reasoning: form.elements.reasoning.value || 'auto' });
const connected = () => Object.keys(PROVIDERS)
  .filter(id => form.elements[PROVIDER_KEYS[id]].value.trim() && (id !== 'custom' || customOrigin(form.elements.customBaseUrl.value.trim())))
  .map(id => ({ id, label: id === 'custom' ? `Custom · ${new URL(form.elements.customBaseUrl.value.trim()).hostname}` : PROVIDERS[id].label, prefix: PROVIDERS[id].prefix }));
// The custom server's origin must be granted by the user; Chrome shows the prompt on this user gesture.
async function grantCustomOrigin() {
  const origin = customOrigin(form.elements.customBaseUrl.value.trim());
  if (!origin || !form.elements.customKey.value.trim()) return true;
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}
function renderModel() {
  const label = document.querySelector('#model-label');
  label.textContent = picker ? picker.label(current()) : (current().model ? `${current().model} · reasoning ${current().reasoning}` : 'choose a model');
}
// One picker per set of connected providers; keys typed above change which tabs it shows.
function ensurePicker() {
  const providers = connected();
  const signature = providers.map(p => p.id).join(',');
  if (!providers.length) { picker?.dialog.remove(); picker = undefined; pickerProviders = ''; return undefined; }
  if (picker && signature === pickerProviders) return picker;
  picker?.dialog.remove();
  pickerProviders = signature;
  picker = createModelPicker({
    providers,
    // Lists come straight from each provider with the keys typed above; nothing is saved until "save settings".
    fetchModels: async id => { configure(normalizeSettings(Object.fromEntries(new FormData(form)))); try { return await listModels(id); } finally { clearConfig(); } },
    value: current(),
    onChange: next => { form.elements.model.value = next.model; form.elements.reasoning.value = next.reasoning; renderModel(); },
  });
  return picker;
}
document.querySelector('#model-button').addEventListener('click', async () => {
  const p = ensurePicker();
  if (!p) return show('add an OpenRouter, OpenAI, Gemini, or custom provider key first, then choose a model.', true);
  if (!(await grantCustomOrigin())) return show('Chrome did not allow access to the custom provider site.', true);
  p.open(current());
});
readSettings().then(render).catch(err => show(err.message, true));
form.elements.provider.addEventListener('change', () => { document.querySelector('#typesafe-field').hidden = form.elements.provider.value !== 'typesafe'; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings = normalizeSettings(Object.fromEntries(new FormData(form)));
    validateSettings(settings);
    if (!(await grantCustomOrigin())) throw new Error('Chrome did not allow access to the custom provider site; the custom provider will not work until you allow it.');
    await chrome.storage.local.set({ settings });
    render(settings);
    show('saved on this device. open checkto from the toolbar to start.');
  } catch (err) { show(err.message, true); }
});
document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => {
  const input = document.getElementById(button.dataset.reveal);
  const hidden = input.type === 'password'; input.type = hidden ? 'text' : 'password';
  button.textContent = hidden ? 'hide' : 'show';
  button.setAttribute('aria-label', `${hidden ? 'hide' : 'show'} ${{ openrouterKey: 'OpenRouter', typesafeKey: 'TypeSafe', openaiKey: 'OpenAI', geminiKey: 'Gemini', customKey: 'custom' }[input.id]} key`);
}));
document.querySelector('#clear-keys').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'stop' });
    const settings = await readSettings();
    settings.openrouterKey = ''; settings.typesafeKey = ''; settings.openaiKey = ''; settings.geminiKey = ''; settings.customKey = '';
    await chrome.storage.local.set({ settings });
    render(settings); show('saved keys removed.');
  } catch (err) { show(err.message, true); }
});
