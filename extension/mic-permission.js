// One-time full-tab permission request. getUserMedia does not reliably prompt from a side panel
// document (Chrome cannot anchor the prompt there), so this page exists purely to ask once from a
// normal tab. A first-run grant commonly needs this before the offscreen document can reuse it.
const button = document.getElementById('grant');
const status = document.getElementById('status');

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'requesting…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    status.textContent = 'microphone access granted. you can close this tab and use voice dictation in the side panel.';
    await chrome.runtime.sendMessage({ type: 'dictation:permission-granted' }).catch(() => {});
  } catch (err) {
    status.textContent = `microphone access was not granted (${err?.message || err}). voice dictation will not work until this is allowed.`;
    button.disabled = false;
  }
});
