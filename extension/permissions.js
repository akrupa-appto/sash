// Host access is optional (see optional_host_permissions). Ask for it at the moment the
// agent actually needs a site, and let the wording carry the weight: one site is a plain
// question, every site is a deliberately scarier one.
//
// Chrome only grants an optional permission from inside a user gesture, and a service worker
// never has one: calling chrome.permissions.request() here fails with "This function must be
// called during a user gesture". So the worker asks, the panel's Allow click does the asking of
// Chrome, and the worker then reads the answer back off chrome.permissions.contains().
// https://developer.chrome.com/docs/extensions/reference/api/permissions

// sash acts on any http(s) tab (see isWebsite() in panel.js), so "all sites" has to actually
// cover both schemes — granting only https://*/* would still block sash on an ordinary
// http:// site even after the user accepted the scarier "every site" prompt.
export const ALL_SITES = ['https://*/*', 'http://*/*'];

export function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

export function originPattern(url) {
  try {
    const parsed = new URL(url);
    // Chrome match patterns do not accept ports. Access is necessarily host-wide across ports,
    // while the prompt still names the exact origin the task opened.
    return /^https?:$/.test(parsed.protocol) ? `${parsed.protocol}//${parsed.hostname}/*` : '';
  } catch { return ''; }
}

export function originPrompt(origin) {
  return {
    scope: 'origin',
    origin,
    origins: [originPattern(origin)],
    title: `allow sash to access ${origin}?`,
    detail: `sash will read and act on pages on ${origin} while a task is running. Chrome grants access to every port on this host. you can take this back in chrome's extension settings.`,
    allow: 'allow this site',
    deny: 'not now',
  };
}

export function allSitesPrompt() {
  return {
    scope: 'all-sites',
    origin: 'every site',
    origins: ALL_SITES,
    title: 'allow sash to access EVERY site you visit?',
    detail: 'this is much broader than allowing one site. sash could read and act on any page in this browser, including your email, your bank, and anything you are signed in to. only do this if you understand the risk. allowing one site at a time is safer.',
    allow: 'i understand the risk, allow all sites',
    deny: 'no, keep it to one site',
  };
}

async function granted(origins) {
  return Boolean(await chrome.permissions.contains({ origins }));
}

// ask(prompt) -> truthy once the human has said yes AND Chrome has been asked from that click.
// Nothing here calls chrome.permissions.request: no ask, no access, and a yes that Chrome did
// not actually grant still fails.
async function ensureAccess(origins, prompt, ask, refused, ungranted) {
  if (await granted(origins)) return true;
  if (typeof ask !== 'function' || !(await ask(prompt))) throw new Error(refused);
  if (!(await granted(origins))) throw new Error(ungranted);
  return true;
}

export async function ensureOriginAccess(url, ask) {
  const origins = [originPattern(url)];
  if (!origins[0]) throw new Error('sash cannot work on this page. open a regular website tab.');
  const prompt = originPrompt(originOf(url));
  return ensureAccess(origins, prompt, ask,
    `sash needs your permission to use ${prompt.origin}. say yes to "${prompt.title}" and try again.`,
    `chrome did not grant access to ${prompt.origin}. try again and accept chrome's prompt.`);
}

export async function ensureAllSitesAccess(ask) {
  return ensureAccess(ALL_SITES, allSitesPrompt(), ask,
    'sash does not have access to every site. allow one site at a time instead.',
    'sash does not have access to every site. try again and accept chrome\'s prompt.');
}
