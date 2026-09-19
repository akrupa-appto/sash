import { defaults, normalizeSettings, readSettings, validateSettings, PROVIDER_KEYS } from './settings.js';
import { createModelPicker } from '../public/model-picker.js';
import { listModels, PROVIDERS } from '../providers.ts';
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
const connected = () => Object.keys(PROVIDERS).filter(id => form.elements[PROVIDER_KEYS[id]].value.trim()).map(id => ({ id, label: PROVIDERS[id].label, prefix: PROVIDERS[id].prefix }));
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
document.querySelector('#model-button').addEventListener('click', () => {
  const p = ensurePicker();
  if (!p) return show('add an OpenRouter, OpenAI, or Gemini key first, then choose a model.', true);
  p.open(current());
});
readSettings().then(render).catch(err => show(err.message, true));
form.elements.provider.addEventListener('change', () => { document.querySelector('#typesafe-field').hidden = form.elements.provider.value !== 'typesafe'; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const settings = normalizeSettings(Object.fromEntries(new FormData(form)));
    validateSettings(settings);
    await chrome.storage.local.set({ settings });
    render(settings);
    show('saved on this device. open checkto from the toolbar to start.');
  } catch (err) { show(err.message, true); }
});
document.querySelectorAll('[data-reveal]').forEach(button => button.addEventListener('click', () => {
  const input = document.getElementById(button.dataset.reveal);
  const hidden = input.type === 'password'; input.type = hidden ? 'text' : 'password';
  button.textContent = hidden ? 'hide' : 'show';
  button.setAttribute('aria-label', `${hidden ? 'hide' : 'show'} ${{ openrouterKey: 'OpenRouter', typesafeKey: 'TypeSafe', openaiKey: 'OpenAI', geminiKey: 'Gemini' }[input.id]} key`);
}));
document.querySelector('#clear-keys').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'stop' });
    const settings = await readSettings();
    settings.openrouterKey = ''; settings.typesafeKey = ''; settings.openaiKey = ''; settings.geminiKey = '';
    await chrome.storage.local.set({ settings });
    render(settings); show('saved keys removed.');
  } catch (err) { show(err.message, true); }
});
