import { defaults, normalizeSettings, readSettings, validateSettings, PROVIDER_KEYS, customOrigin } from './settings.js';
import { createModelPicker } from '../public/model-picker.js';
import { listModels, PROVIDERS, providerLabel } from '../src/providers.ts';
import { configure, clearConfig } from '../src/env.ts';
import { defaultTranscriptionSpec, transcribeCapability } from '../src/transcribe.ts';
import { VOICE_MODE_ORDER, VOICE_MODES, supportedVoiceModes } from './voice.js';
import { mountAccessSettings } from './access-settings.js';
mountAccessSettings();
const form = document.querySelector('#settings');
const status = document.querySelector('#status');
function show(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
let picker, pickerProviders = '';
function render(settings) {
  for (const key of Object.keys(defaults)) form.elements[key].value = settings[key];
  // voiceEnabled is a boolean under the hood, not a string matching one of the select's own option
  // values, so the generic loop above leaves it on whatever the select's default happens to be;
  // set it explicitly. voiceProvider's options are built dynamically from the keys typed above (see
  // renderVoiceProviderOptions), so it needs the same explicit pass, done with the stored value
  // rather than trusting .value, which the generic loop could only set against the placeholder option.
  form.elements.voiceEnabled.value = settings.voiceEnabled ? 'on' : 'off';
  document.querySelector('#typesafe-field').hidden = settings.provider !== 'typesafe';
  renderVoiceProviderOptions(settings.voiceProvider);
  renderVoiceModes();
  ensurePicker()?.warm(current().model).then(renderModel).catch(() => {});
  renderModel();
}
const current = () => ({ model: form.elements.model.value, reasoning: form.elements.reasoning.value || 'auto' });
const connected = () => Object.keys(PROVIDERS)
  .filter(id => form.elements[PROVIDER_KEYS[id]].value.trim() && (id !== 'custom' || customOrigin(form.elements.customBaseUrl.value.trim())))
  .map(id => ({ id, label: id === 'custom' ? `Custom · ${new URL(form.elements.customBaseUrl.value.trim()).hostname}` : PROVIDERS[id].label, prefix: PROVIDERS[id].prefix }));
// The custom server's origin must be granted by the user. The request is made straight from the click
// handler, with no await before it, so Chrome still counts it as a user gesture; an already-granted
// origin resolves true without a prompt.
function grantCustomOrigin() {
  const origin = customOrigin(form.elements.customBaseUrl.value.trim());
  if (!origin || !form.elements.customKey.value.trim()) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}
function renderModel() {
  const label = document.querySelector('#model-label');
  label.textContent = picker ? picker.label(current()) : (current().model ? `${current().model} · reasoning ${current().reasoning}` : 'choose a model');
}
// The dictation provider dropdown offers only providers a key is typed for above, same as the model
// picker's own `connected()`; "same as the planner model" (empty value) is always offered first.
function renderVoiceProviderOptions(selected = form.elements.voiceProvider.value) {
  const select = form.elements.voiceProvider;
  select.replaceChildren(...[{ id: '', label: 'same as the planner model above' }, ...connected()].map(p => {
    const option = document.createElement('option'); option.value = p.id; option.textContent = p.label; return option;
  }));
  select.value = [...select.options].some(o => o.value === selected) ? selected : '';
}
// Computed live from whatever is typed in the form right now, exactly like ensurePicker()'s own
// fetchModels() does — nothing here is saved until "save settings", so this must never read from
// chrome.storage.
function currentVoiceCapability() {
  configure(normalizeSettings(Object.fromEntries(new FormData(form))));
  try {
    const provider = form.elements.voiceProvider.value;
    return transcribeCapability(provider ? defaultTranscriptionSpec(provider) : undefined);
  } finally { clearConfig(); }
}
// One button per mode, in VOICE_MODE_ORDER, each showing its real behaviour — never a mode the
// configured provider can't actually do (see voice.js's own header comment on "eager" for why every
// mode is either fully honest about its granularity or not offered at all, never silently downgraded).
function renderVoiceModes() {
  const capability = currentVoiceCapability();
  const supported = supportedVoiceModes(capability);
  // A provider swapped out from under a previously saved mode falls back to the first supported one
  // instead of leaving an unusable mode selected underneath the visible buttons.
  if (supported.length && !supported.includes(form.elements.voiceMode.value)) form.elements.voiceMode.value = supported[0];
  document.querySelector('#voice-modes').replaceChildren(...VOICE_MODE_ORDER.map(id => {
    const mode = VOICE_MODES[id];
    const available = supported.includes(id);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'voice-mode-option'; button.dataset.mode = id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(available && form.elements.voiceMode.value === id));
    button.disabled = !available;
    const label = document.createElement('strong'); label.textContent = mode.label;
    const detail = document.createElement('small'); detail.textContent = mode.description;
    button.append(label, detail);
    button.addEventListener('click', () => { form.elements.voiceMode.value = id; renderVoiceModes(); });
    return button;
  }));
  const note = document.querySelector('#voice-capability');
  note.textContent = capability.canTranscribe
    ? `dictation provider: ${providerLabel(capability.provider)}`
    : (capability.reason || 'voice dictation needs a connected provider.');
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
// A key typed (or removed) above, or a different dictation provider chosen, changes which modes are
// honestly offerable right now — recomputed live, the same way the model picker's own list is.
['openrouterKey', 'openaiKey', 'geminiKey', 'customKey', 'customBaseUrl'].forEach(id => form.elements[id].addEventListener('input', () => { renderVoiceProviderOptions(); renderVoiceModes(); }));
form.elements.voiceProvider.addEventListener('change', renderVoiceModes);
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
