// Host access is optional (see optional_host_permissions). Ask for it at the moment the
// agent actually needs a site, and let the wording carry the weight: one site is a plain
// question, every site is a deliberately scarier one.

export function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

export function originPattern(url) {
  const origin = originOf(url);
  return origin ? `${origin}/*` : '';
}

export function originPrompt(origin) {
  return {
    scope: 'origin',
    origin,
    title: `allow checkto to access ${origin}?`,
    detail: `checkto will read and act on pages on ${origin} while a task is running. you can take this back in chrome's extension settings.`,
    allow: 'allow this site',
    deny: 'not now',
  };
}

export function allSitesPrompt() {
  return {
    scope: 'all-sites',
    origin: 'every site',
    title: 'allow checkto to access EVERY site you visit?',
    detail: 'this is much broader than allowing one site. checkto could read and act on any page in this browser, including your email, your bank, and anything you are signed in to. only do this if you understand the risk. allowing one site at a time is safer.',
    allow: 'i understand the risk, allow all sites',
    deny: 'no, keep it to one site',
  };
}

async function granted(origins) {
  return Boolean(await chrome.permissions.contains({ origins }));
}

// ask(prompt) -> truthy when the human said yes. No ask, no request: access is never
// granted silently.
export async function ensureOriginAccess(url, ask) {
  const origins = [originPattern(url)];
  if (!origins[0]) throw new Error('checkto cannot work on this page. open a regular website tab.');
  if (await granted(origins)) return true;
  const prompt = originPrompt(originOf(url));
  if (typeof ask !== 'function' || !(await ask(prompt))) throw new Error(`checkto needs your permission to use ${prompt.origin}. say yes to "${prompt.title}" and try again.`);
  if (!(await chrome.permissions.request({ origins }))) throw new Error(`chrome did not grant access to ${prompt.origin}. try again and accept chrome's prompt.`);
  return true;
}

export async function ensureAllSitesAccess(ask) {
  const origins = ['https://*/*'];
  if (await granted(origins)) return true;
  const prompt = allSitesPrompt();
  if (typeof ask !== 'function' || !(await ask(prompt))) throw new Error('checkto does not have access to every site. allow one site at a time instead.');
  if (!(await chrome.permissions.request({ origins }))) throw new Error("chrome did not grant access to every site. try again and accept chrome's prompt.");
  return true;
}
