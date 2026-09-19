// Shared DOM reader. Runs in the controlled page, never with API credentials.
export const pageReady = () => !Array.from(document.querySelectorAll(
  '[aria-busy="true"], button:disabled, input[type="submit"]:disabled, [role="button"][aria-disabled="true"]',
)).some(el => el.getClientRects().length && (
  el.getAttribute("aria-busy") === "true" || /^(saving|loading|submitting|processing|uploading)(\s*[.…]+)?$/i.test((el.textContent || el.getAttribute("value") || "").trim())
));

export const collectSnapshot = (maxEls) => {
  const pageReady = () => !Array.from(document.querySelectorAll(
  '[aria-busy="true"], button:disabled, input[type="submit"]:disabled, [role="button"][aria-disabled="true"]',
)).some(el => el.getClientRects().length && (
  el.getAttribute("aria-busy") === "true" || /^(saving|loading|submitting|processing|uploading)(\s*[.…]+)?$/i.test((el.textContent || el.getAttribute("value") || "").trim())
));

  const sel = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
  document.querySelectorAll('[data-jev-idx]').forEach(e => e.removeAttribute('data-jev-idx'));
  const vw = innerWidth, vh = innerHeight;
  const clean = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el)) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none' && el.tagName !== 'INPUT') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (el.disabled) continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    // skip nested interactive (e.g. span[role=button] inside a button)
    if (el.parentElement && el.parentElement.closest(sel) && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') {
      const p = el.parentElement.closest(sel);
      if (p && p.getBoundingClientRect().width <= r.width + 4) continue;
    }
    seen.add(el);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    let role = el.getAttribute('role') || tag;
    let kind = 'click';
    if (tag === 'select') { role = 'select'; kind = 'select'; }
    else if (tag === 'textarea' || el.isContentEditable) { role = 'textbox'; kind = 'type'; }
    else if (tag === 'input') {
      if (['checkbox','radio','submit','button','reset','image','file'].includes(type)) { role = type || 'button'; kind = 'click'; }
      else { role = type ? type : 'textbox'; kind = 'type'; }
    } else if (role === 'textbox' || role === 'combobox' || role === 'searchbox') { kind = 'type'; }
    else if (tag === 'a') role = 'link';
    let name = el.getAttribute('aria-label') || '';
    if (!name && el.labels && el.labels[0]) name = el.labels[0].innerText;
    if (!name && el.getAttribute('aria-labelledby')) { const l = document.getElementById(el.getAttribute('aria-labelledby')); if (l) name = l.innerText; }
    if (!name) name = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    if (!name) { const img = el.querySelector('img[alt]'); if (img) name = img.getAttribute('alt'); }
    if (!name) name = el.innerText || el.textContent || '';
    if (!name && tag === 'a') name = el.getAttribute('href') || '';
    name = clean(name);
    let value;
    // never read secret field contents: the snapshot is sent to a third-party model
    const secret = role === 'password' || (tag === 'input' && type === 'password');
    if (kind === 'type' && !secret) value = clean(el.value !== undefined ? el.value : el.innerText);
    if (kind === 'select') value = clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '');
    if (role === 'checkbox' || role === 'radio' || role === 'switch') value = (el.checked || el.getAttribute('aria-checked') === 'true') ? 'checked' : 'unchecked';
    const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const options = kind === 'select' ? Array.from(el.options).slice(0, 40).map(o => clean(o.text)) : undefined;
    out.push({ el, role, name, value, kind, options, contentEditable: el.isContentEditable || undefined, inViewport, pos: inViewport ? undefined : (r.bottom <= 0 ? 'above' : 'below'), top: r.top });
  }
  // document order, so "the last item in the list" is the last element listed
  const kept = out.slice(0, maxEls);
  kept.forEach((o, i) => o.el.setAttribute('data-jev-idx', String(i + 1)));
  const text = (document.body.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  const se = document.scrollingElement || document.documentElement;
  return {
    busy: !(pageReady)(),
    url: location.href,
    title: document.title,
    text,
    scroll: { y: Math.round(se.scrollTop), max: Math.max(0, Math.round(se.scrollHeight - innerHeight)) },
    elements: kept.map((o, i) => ({ id: i + 1, role: o.role, name: o.name, value: o.value, kind: o.kind, options: o.options, contentEditable: o.contentEditable, inViewport: o.inViewport, pos: o.pos })),
  };
};
