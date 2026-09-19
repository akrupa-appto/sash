import { defaults, normalizeSettings, readSettings, validateSettings } from './settings.js';
const form = document.querySelector('#settings');
const status = document.querySelector('#status');
function show(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
function render(settings) {
  for (const key of Object.keys(defaults)) form.elements[key].value = settings[key];
  document.querySelector('#typesafe-field').hidden = settings.provider !== 'typesafe';
}
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
  button.setAttribute('aria-label', `${hidden ? 'hide' : 'show'} ${input.id === 'openrouterKey' ? 'OpenRouter' : 'TypeSafe'} key`);
}));
document.querySelector('#clear-keys').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'stop' });
    const settings = await readSettings();
    settings.openrouterKey = ''; settings.typesafeKey = '';
    await chrome.storage.local.set({ settings });
    render(settings); show('saved keys removed.');
  } catch (err) { show(err.message, true); }
});
