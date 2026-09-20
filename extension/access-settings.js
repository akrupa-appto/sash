// Approval records and Chrome host permissions are independent grants. Keep their native APIs
// authoritative: never infer access from a saved form or mutate the worker's storage directly.
//
// Chrome treats host_permissions, <all_urls>, and every content_scripts match as *required*: it
// reports them from permissions.getAll() but rejects permissions.remove() for them and for any
// narrower site they cover ("You cannot remove required permissions"). This manifest's content
// script matches http://*/* and https://*/*, so nearly every granted site is covered. Only
// Chrome's own site-access controls (chrome://extensions) change that; classify by coverage,
// not string equality, and never offer a revoke button that can only fail.
//
// A content script's exclude_matches does not change that: excludes narrow where the script is
// injected, not what Chrome considers required. Probed against the real built extension in
// disposable Chromium with an extra exclude_matches on the content script -- removing
// https://example.test/* and https://*/* still threw "You cannot remove required permissions."
// Do not "fix" removability by reading excludes here without re-running that probe.
export function requiredPatterns(manifest) {
  return [
    ...(manifest.host_permissions || []),
    ...((manifest.permissions || []).filter(p => p.includes('://') || p === '<all_urls>')),
    ...((manifest.content_scripts || []).flatMap(cs => cs.matches || [])),
  ];
}
// Chrome match pattern: <scheme>://<host><path>. Returns null for a pattern Chrome would reject.
export function parsePattern(pattern) {
  if (pattern === '<all_urls>') return { all: true };
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/i.exec(pattern);
  if (!match) return null;
  const schemes = match[1] === '*' ? ['http', 'https'] : [match[1].toLowerCase()];
  return { schemes, host: match[2].toLowerCase(), path: match[3] };
}
function hostCovers(required, host) {
  if (required === '*' || required === host) return true;
  if (!required.startsWith('*.')) return false;
  const base = required.slice(2);
  return host === base || host.endsWith(`.${base}`) || host === `*.${base}`;
}
// True when Chrome would treat `origin` as inside the required set: every scheme it names is
// covered by some required pattern whose host and path are at least as broad.
export function isRequired(origin, required) {
  const wanted = parsePattern(origin);
  const patterns = required.map(parsePattern).filter(Boolean);
  if (patterns.some(p => p.all)) return true;
  if (!wanted || wanted.all) return Boolean(wanted?.all && patterns.some(p => p.all));
  return wanted.schemes.every(scheme => patterns.some(p => p.schemes.includes(scheme)
    && hostCovers(p.host, wanted.host) && (p.path === '/*' || p.path === wanted.path)));
}
export function mountAccessSettings() {
  const approvals = document.querySelector('#approval-list');
  const sites = document.querySelector('#site-access-list');
  const status = document.querySelector('#access-status');
  const refresh = document.querySelector('#refresh-access');
  const manage = document.querySelector('#manage-site-access');
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
    item.append(copy);
    if (remove) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'secondary'; button.textContent = 'revoke';
      button.setAttribute('aria-label', `revoke ${title} · ${detail}`);
      button.addEventListener('click', () => transact(remove));
      item.append(button);
    } else {
      item.classList.add('is-required');
      const tag = document.createElement('span'); tag.className = 'access-tag'; tag.textContent = 'required';
      item.append(tag);
    }
    list.append(item);
  }
  function describe(origin) {
    return origin === '<all_urls>' || /^(\*|https?):\/\/\*\/\*$/.test(origin) ? 'all sites matching this pattern' : 'allowed site';
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
    const required = requiredPatterns(chrome.runtime.getManifest());
    const granted = [...(permissions.origins || [])].sort();
    const optional = granted.filter(origin => !isRequired(origin, required));
    const locked = granted.filter(origin => isRequired(origin, required));
    sites.replaceChildren();
    if (!granted.length) empty(sites, 'no site access.');
    for (const origin of optional) {
      row(sites, origin, describe(origin), async () => {
          // debugger permission is independent of host permission: removing a host grant alone
          // does not guarantee an attached task stops controlling the page.
          const stopped = await chrome.runtime.sendMessage({ type: 'stop' });
          if (!stopped?.ok) throw new Error('could not stop the current task. site access was not changed.');
          if (!(await chrome.permissions.remove({ origins: [origin] }))) throw new Error('Chrome did not remove this site access.');
          return 'site access revoked and the current task stopped. another listed permission may still allow this site.';
        });
    }
    // Required coverage is listed, not hidden: the user should see exactly what checkto can
    // reach, and that the only place to narrow it is Chrome's own site-access control.
    for (const origin of locked) row(sites, origin, `${describe(origin)} · comes with the extension`);
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
  // chrome:// URLs cannot be linked from an extension page; tabs.create is the sanctioned route.
  manage?.addEventListener('click', () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }, () => {
      if (chrome.runtime.lastError) announce('could not open Chrome\'s extension page. open chrome://extensions and pick checkto.', true);
    });
  });
  void transact();
}
