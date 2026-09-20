// Approval records and Chrome host permissions are independent grants. Keep their native APIs
// authoritative: never infer access from a saved form or mutate the worker's storage directly.
export function mountAccessSettings() {
  const approvals = document.querySelector('#approval-list');
  const sites = document.querySelector('#site-access-list');
  const status = document.querySelector('#access-status');
  const refresh = document.querySelector('#refresh-access');
  let busy = false;
  function announce(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }
  function empty(list, text) {
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = text;
    list.replaceChildren(p);
  }
  function row(list, title, detail, remove) {
    const item = document.createElement('div'); item.className = 'access-row';
    const copy = document.createElement('div'); copy.className = 'access-copy';
    const name = document.createElement('strong'); name.textContent = title;
    const description = document.createElement('small'); description.textContent = detail;
    copy.append(name, description);
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'secondary'; button.textContent = 'revoke';
    button.setAttribute('aria-label', `revoke ${title} · ${detail}`);
    button.addEventListener('click', () => transact(remove));
    item.append(copy, button); list.append(item);
  }
  async function load() {
    const [reply, permissions] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'grants:list' }), chrome.permissions.getAll(),
    ]);
    if (!reply?.ok || !Array.isArray(reply.grants)) throw new Error('could not load saved approvals.');
    approvals.replaceChildren();
    if (!reply.grants.length) empty(approvals, 'no saved approvals.');
    for (const grant of reply.grants) {
      const origin = !grant.origin || grant.origin === '*' ? 'all sites' : grant.origin;
      row(approvals, grant.action || grant.question || 'approved action',
        `${origin} · ${grant.scope === 'always' ? 'always' : 'this conversation'}`, async () => {
          const result = await chrome.runtime.sendMessage({ type: 'grants:revoke', key: grant.key });
          if (!result?.ok) throw new Error('approval could not be revoked. refresh to check whether it still exists.');
          return 'approval revoked. checkto will ask again next time.';
        });
    }
    const manifest = chrome.runtime.getManifest();
    const required = new Set([
      ...(manifest.host_permissions || []),
      ...((manifest.permissions || []).filter(p => p.includes('://') || p === '<all_urls>')),
      ...((manifest.content_scripts || []).flatMap(cs => cs.matches || [])),
    ]);
    const origins = (permissions.origins || []).filter(origin => !required.has(origin)).sort();
    sites.replaceChildren();
    if (!origins.length) empty(sites, 'no optional site access.');
    for (const origin of origins) {
      row(sites, origin, origin === '<all_urls>' || /^https?:\/\/\*\/\*$/.test(origin)
        ? 'all sites matching this pattern' : 'allowed site', async () => {
          // debugger permission is independent of host permission: removing a host grant alone
          // does not guarantee an attached task stops controlling the page.
          const stopped = await chrome.runtime.sendMessage({ type: 'stop' });
          if (!stopped?.ok) throw new Error('could not stop the current task. site access was not changed.');
          if (!(await chrome.permissions.remove({ origins: [origin] }))) throw new Error('Chrome did not remove this site access.');
          return 'site access revoked and the current task stopped. another listed permission may still allow this site.';
        });
    }
  }
  async function transact(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('#access-settings button').forEach(button => { button.disabled = true; });
    announce('updating access…');
    try {
      const message = action ? await action() : '';
      await load();
      announce(message);
    } catch {
      // Do not echo worker/provider exceptions into the page: those may contain configured keys.
      announce('could not update access. refresh to check the current grants, then try again.', true);
    } finally {
      busy = false;
      document.querySelectorAll('#access-settings button').forEach(button => { button.disabled = false; });
    }
  }
  refresh.addEventListener('click', () => transact());
  void transact();
}
