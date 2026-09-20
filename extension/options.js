import { defaults, normalizeSettings, readSettings, validateSettings, PROVIDER_KEYS, customOrigin } from './settings.js';
import { createModelPicker } from '../public/model-picker.js';
import { listModels, listTranscriptionModels, PROVIDERS, providerLabel } from '../src/providers.ts';
import { configure, clearConfig } from '../src/env.ts';
import { transcribeCapability } from '../src/transcribe.ts';
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
  // set it explicitly. The same applies to the approval and site-access radios (the generic loop
  // cannot check one from a stored string if this build does not offer that string) and to
  // transcriptionModel, whose options are built from the keys typed above (see
  // renderTranscriptionOptions). voiceProvider is not restored here: it is derived from the chosen
  // speech model, so the picker stays the one place that decides it.
  form.elements.voiceEnabled.value = settings.voiceEnabled ? 'on' : 'off';
  document.querySelector('#typesafe-field').hidden = settings.provider !== 'typesafe';
  restoreChoice('approvalMode', settings.approvalMode, 'every');
  restoreChoice('siteAccessMode', settings.siteAccessMode, 'ask');
  renderTranscriptionOptions({ stored: settings.transcriptionModel, savedProvider: settings.voiceProvider, keepUnlisted: true });
  // The rows above are on screen already; this only swaps the OpenRouter group if the live
  // transcription catalog answers. It never blocks the paint and never empties the select.
  refreshTranscriptionModels();
  renderVoiceModes();
  ensurePicker()?.warm(current().model).then(renderModel).catch(() => {});
  renderModel();
}
// A stored value that is not one of the choices this build offers (written by an older or a newer
// build) must not leave the control blank: a select falls back to its first option, a radio group to
// its first choice. RadioNodeList and HTMLSelectElement both accept `.value` for this, so one pass
// covers both. The values themselves are the engine layer's (extension/settings.js).
function restoreChoice(name, value, fallback) {
  const field = form.elements[name];
  if (!field) return;
  const values = field.options ? [...field.options].map(o => o.value) : [...field].map(input => input.value);
  field.value = values.includes(value) ? value : fallback;
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
// Speech-to-text is its own job with its own models: a chat model cannot transcribe audio, so this
// is a separate list, not a filtered view of the planner picker above.
//
// These rows are the fallback, not the catalog. With an OpenRouter key typed, the page fetches
// OpenRouter's live transcription catalog (listTranscriptionModels — the API's own
// output_modalities=transcription filter) and replaces the OpenRouter group with it; what is written
// here is what that group shows before the fetch lands, and what it keeps if the fetch fails
// (offline, non-200). So this list is never the whole picture and must not claim to be: a row only
// belongs here if it is still in the live catalog, and the live rows carry the catalog's own names
// and prices rather than the notes below.
//
// The OpenRouter rows are bare model ids, not `openrouter:…`: parseModel() in src/providers.ts only
// recognises the openai/gemini/custom prefixes and resolves everything else to OpenRouter with the
// whole string as the model id, so a prefixed spec would be sent as a model literally named
// "openrouter:openai/gpt-transcribe". A bare spec means OpenRouter, by design.
// `tag` is the one-line note shown inside a fallback option, `detail` the sentence shown under the
// select once it is chosen. The recommended row keeps its detail once the live catalog lands.
const TRANSCRIPTION_CHOICES = [
  { spec: 'openai/gpt-transcribe', provider: 'openrouter', label: 'GPT Transcribe (OpenAI)', tag: 'recommended', detail: "OpenAI's current speech-to-text model, reached through OpenRouter. the best all-round choice here." },
  { spec: 'meta/muse-voice-transcribe-1.0', provider: 'openrouter', label: 'Muse Voice Transcribe (Meta)', tag: 'newest', detail: "the newest speech model in OpenRouter's catalog." },
  { spec: 'deepgram/nova-3', provider: 'openrouter', label: 'Nova 3 (Deepgram)', tag: 'steady pick', detail: 'Deepgram\'s production speech model; a long-standing, widely used choice.' },
  { spec: 'nvidia/parakeet-tdt-0.6b-v3', provider: 'openrouter', label: 'Parakeet TDT (NVIDIA)', tag: 'cheapest here', detail: 'a small NVIDIA model; the lowest cost per minute of these five.' },
  { spec: 'google/chirp-3', provider: 'openrouter', label: 'Chirp 3 (Google)', tag: 'earlier Google model', detail: 'Google\'s earlier speech model; the Gemini 3.5 entry is its newer replacement.' },
  { spec: 'openai:gpt-transcribe', provider: 'openai', label: 'GPT Transcribe', tag: 'your OpenAI key', detail: "OpenAI's current speech model on your own key, with no OpenRouter mark-up." },
  { spec: 'gemini:gemini-3.5-transcribe', provider: 'gemini', label: 'Gemini 3.5 Transcribe', tag: 'your Gemini key', detail: "Google's current speech model on your own key." },
  { spec: 'custom:whisper-1', provider: 'custom', label: 'your custom server\'s speech model', tag: '', detail: 'the model id your custom server expects; it must implement /v1/audio/transcriptions.' },
];
// A provider saved before this picker existed (voiceProvider set, no model yet) becomes that
// provider's recommended model rather than being dropped on the next save.
const RECOMMENDED_TRANSCRIPTION = { openrouter: 'openai/gpt-transcribe', openai: 'openai:gpt-transcribe', gemini: 'gemini:gemini-3.5-transcribe', custom: 'custom:whisper-1' };
// The recommended model is pinned to the top of the OpenRouter group, live or fallback: it is the one
// this page points people at, and the one "same provider as my planner model" resolves to in
// practice. Order is therefore ours, not the catalog's.
// OpenAI has deprecated these three (removal 2027-02-26) and they must not come back — the owner
// rejected them by name (DECISIONS.md). OpenRouter still lists all three and publishes no
// deprecation signal for them (`expiration_date` is null on every entry in that catalog), so naming
// them is the only way a live list can stay honest about what is safe to offer.
const DEPRECATED_SPEECH_MODELS = new Set(['openai/whisper-1', 'openai/gpt-4o-transcribe', 'openai/gpt-4o-mini-transcribe']);
// The live catalog, the key it was fetched with, and the request in flight. Nothing here is a
// promise that a fetch happened: null means "no live list", which is the first paint, a failed
// fetch, and a page with no OpenRouter key — all three render the fallback rows.
let liveTranscription = null;
let liveTranscriptionKey = '';
let liveTranscriptionRequest = null;
// providerOfSpec mirrors parseModel's rule for the three prefixed providers and treats everything
// else as OpenRouter, which is what a bare "openai/gpt-transcribe"-style spec means, and what ""
// means too ("same as the planner model"). This is why no row above carries an `openrouter:` prefix.
function providerOfSpec(spec) {
  return Object.keys(PROVIDERS).find(id => PROVIDERS[id].prefix && spec.startsWith(PROVIDERS[id].prefix)) || (spec ? 'openrouter' : '');
}
// voiceProvider is the setting the voice engine still reads (extension/background.js,
// offscreen.js). It is derived from the chosen model rather than shown as a second control, so the
// two can never disagree: "" = whatever provider backs the planner model.
function syncVoiceProvider() {
  form.elements.voiceProvider.value = providerOfSpec(form.elements.transcriptionModel.value.trim());
}
function choiceOption(text, value) {
  const option = document.createElement('option'); option.textContent = text; option.value = value; return option;
}
// 0.000075 as OpenRouter writes it, not 7.5e-5 and not a float's whole tail.
const trimmed = value => String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
// What the catalog itself publishes about a live row, in the units it publishes them in: OpenRouter
// prices audio by the second, so price (kept as USD per 1M units like every ModelInfo) comes back
// down to one. Nothing is shown for a field the payload left out — an unlisted model gets its name
// and no story.
function catalogFacts(model) {
  const facts = [];
  const perSecond = model.price ? model.price.input / 1e6 : 0;
  if (perSecond) facts.push(`$${trimmed(perSecond)} per second of audio`);
  if (model.context) facts.push(`${model.context} token context`);
  return facts.join(' · ');
}
// One row as the select wants it: `label` is the option text, `detail` the sentence under the select.
// The fallback rows carry their own tag inside the label; a live row is labelled with the catalog's
// name and no tag we wrote, because that name is the honest one.
const transcriptionRows = providerId => providerId !== 'openrouter'
  ? TRANSCRIPTION_CHOICES.filter(row => row.provider === providerId).map(row => ({ spec: row.spec, label: row.tag ? `${row.label} — ${row.tag}` : row.label, detail: row.detail }))
  : openrouterRows();
// The OpenRouter group's rows: the live catalog once a fetch has landed, the fallback rows until then
// (and forever, if it never lands). Everything the live catalog superseded is gone from the list —
// the fallback's own notes and the deprecated ids both.
function openrouterRows() {
  const fallback = TRANSCRIPTION_CHOICES.filter(row => row.provider === 'openrouter');
  if (!liveTranscription?.length) return fallback.map(row => ({ spec: row.spec, label: row.tag ? `${row.label} — ${row.tag}` : row.label, detail: row.detail }));
  const recommended = RECOMMENDED_TRANSCRIPTION.openrouter;
  const recommendedDetail = fallback.find(row => row.spec === recommended)?.detail;
  const live = liveTranscription.filter(model => !DEPRECATED_SPEECH_MODELS.has(model.id) && model.id !== recommended);
  const pinned = liveTranscription.find(model => model.id === recommended);
  return [pinned, ...live].filter(Boolean).map(model => ({
    spec: model.id,
    label: model.name || model.id,
    // The recommended row keeps the sentence this page wrote about it; every other live row is
    // described by its own catalog entry.
    detail: model.id === recommended ? recommendedDetail : [model.name || model.id, catalogFacts(model)].filter(Boolean).join(' — '),
  }));
}
// Fetched with whichever OpenRouter key is typed above, and only when one is: a page with no key has
// nothing to list. Typing a key fires this per keystroke, so a newer request aborts the one before
// it, and a reply that arrives after that is dropped rather than painted. A failure leaves the
// fallback rows exactly as they were — a stale list is fine, a broken picker is not.
function refreshTranscriptionModels() {
  const key = form.elements.openrouterKey.value.trim();
  if (!key) { liveTranscriptionRequest?.abort(); liveTranscriptionRequest = null; liveTranscriptionKey = ''; liveTranscription = null; return; }
  if (key === liveTranscriptionKey) return;
  liveTranscriptionKey = key;
  liveTranscriptionRequest?.abort();
  const request = new AbortController();
  liveTranscriptionRequest = request;
  listTranscriptionModels(request.signal).then(models => {
    if (request.signal.aborted) return;
    liveTranscription = models;
    // Re-rendered under the same rule as the first paint, so the swap cannot change what is selected
    // — including a saved model this list does not offer (see keepUnlisted below).
    renderTranscriptionOptions({ keepUnlisted: true });
  }).catch(() => {});
}
// Only providers a key is typed for above are offered, same rule as the model picker's own
// `connected()`; "same as my planner model" (empty value) is always first.
function renderTranscriptionOptions({ stored = form.elements.transcriptionModel.value, savedProvider = '', keepUnlisted = false } = {}) {
  const select = form.elements.transcriptionModel;
  const chosen = stored || RECOMMENDED_TRANSCRIPTION[savedProvider] || '';
  const connectedIds = new Set(connected().map(p => p.id));
  const nodes = [choiceOption('same provider as my planner model, its default speech model', '')];
  const offered = [];
  for (const id of ['openrouter', 'openai', 'gemini', 'custom']) {
    const rows = transcriptionRows(id);
    if (!connectedIds.has(id) || !rows.length) continue;
    offered.push(...rows.map(row => row.spec));
    const group = document.createElement('optgroup');
    group.label = id === 'custom' ? 'your custom server' : PROVIDERS[id].label;
    group.append(...rows.map(row => choiceOption(row.label, row.spec)));
    nodes.push(group);
  }
  // A saved model this build does not offer (an id from an earlier build, or one still saved after
  // its provider key was removed) stays visible and selected. Silently swapping the user's speech
  // model for a different one is worse than showing a line this page has no blurb for.
  if (keepUnlisted && chosen && !offered.includes(chosen)) {
    const group = document.createElement('optgroup');
    group.label = 'your saved choice';
    group.append(choiceOption(chosen, chosen));
    nodes.push(group);
  }
  select.replaceChildren(...nodes);
  // A key removed above takes its models out of the list; a selection that is no longer offered
  // falls back to "same as my planner model" instead of sitting on an option that is gone.
  select.value = chosen && (offered.includes(chosen) || keepUnlisted) ? chosen : '';
  syncVoiceProvider();
  renderTranscriptionDetail();
}
// The sentence under the select: what the chosen model actually is, in plain words — a live row
// describes itself from the catalog, the rows this file wrote use their own sentence.
function renderTranscriptionDetail() {
  const select = form.elements.transcriptionModel;
  const choice = select.value ? transcriptionRows(providerOfSpec(select.value)).find(row => row.spec === select.value) : undefined;
  const capability = currentVoiceCapability();
  document.querySelector('#transcription-detail').textContent = select.value
    ? (choice ? choice.detail : `your saved choice: ${select.value}.`)
    : (capability.canTranscribe ? `that is ${providerLabel(capability.provider)} today, using its own default speech model.` : (capability.reason || ''));
}
// Computed live from whatever is typed in the form right now, exactly like ensurePicker()'s own
// fetchModels() does — nothing here is saved until "save settings", so this must never read from
// chrome.storage.
function currentVoiceCapability() {
  configure(normalizeSettings(Object.fromEntries(new FormData(form))));
  try {
    // The chosen speech model names its own provider; empty means the planner's provider, exactly
    // as transcribe.ts resolves an absent spec.
    return transcribeCapability(form.elements.transcriptionModel.value.trim() || undefined);
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
// A key typed (or removed) above, or a different speech model chosen, changes which providers and
// modes are honestly offerable right now — recomputed live, the same way the model picker's own
// list is. A changed OpenRouter key also refetches the speech catalog it lists.
['openrouterKey', 'openaiKey', 'geminiKey', 'customKey', 'customBaseUrl'].forEach(id => form.elements[id].addEventListener('input', () => { refreshTranscriptionModels(); renderTranscriptionOptions(); renderVoiceModes(); }));
form.elements.transcriptionModel.addEventListener('change', () => { syncVoiceProvider(); renderTranscriptionDetail(); renderVoiceModes(); });
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
