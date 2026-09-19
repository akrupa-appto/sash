// Model picker: a modal that lists a provider's models and shows only the reasoning levels each model
// accepts. Metadata comes from OpenRouter's models API (its per-model `reasoning` object) or, for the
// official OpenAI and Gemini APIs, from documented model families. Shared by the web app and the extension.

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABELS = { none: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'maximum' };

// Choices for the reasoning control of one model, lowest first. "auto" is always first: the fastest
// setting the model accepts (off where allowed, the lowest level otherwise).
export function reasoningChoices(meta) {
  if (!meta) return [{ value: 'auto', label: 'auto', hint: 'this model has no reasoning control' }];
  // null = every effort is accepted; undefined = the model reasons but exposes no effort selection (on/off only).
  let efforts = meta.supported_efforts === null ? EFFORTS.filter(e => e !== 'none') : meta.supported_efforts === undefined ? [] : [...meta.supported_efforts];
  if (!meta.mandatory && !efforts.includes('none')) efforts.push('none');
  if (meta.mandatory) efforts = efforts.filter(e => e !== 'none');
  efforts.sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const lowest = efforts.find(e => e !== 'none');
  return [
    { value: 'auto', label: 'auto', hint: meta.mandatory ? `fastest: ${EFFORT_LABELS[lowest] ?? 'lowest'} (this model cannot turn reasoning off)` : 'fastest: reasoning off' },
    ...efforts.map(e => ({ value: e, label: EFFORT_LABELS[e], hint: e === meta.default_effort ? 'model default' : '' })),
  ];
}

export function reasoningSummary(meta) {
  if (!meta) return 'no reasoning';
  if (meta.mandatory) return `reasoning always on${meta.default_effort ? ` · default ${EFFORT_LABELS[meta.default_effort]}` : ''}`;
  if (meta.default_enabled === false || meta.default_effort === 'none') return 'reasoning off by default';
  return `reasoning on${meta.default_effort ? ` · default ${EFFORT_LABELS[meta.default_effort]}` : ''}`;
}

const money = n => (n === undefined || Number.isNaN(n) ? '' : n === 0 ? 'free' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const tokens = n => (!n ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
dialog.mp{background:var(--mp-bg,var(--panel,#16181c));color:var(--fg,#e6e6e6);border:1px solid var(--line,#26292f);border-radius:14px;padding:0;width:min(640px,calc(100vw - 24px));max-height:min(80vh,720px);display:none;flex-direction:column;font:inherit;box-shadow:0 24px 80px rgba(0,0,0,.55)}
dialog.mp[open]{display:flex}
dialog.mp::backdrop{background:rgba(0,0,0,.55);backdrop-filter:blur(2px)}
.mp-head{display:flex;flex-direction:column;gap:10px;padding:16px 16px 10px;border-bottom:1px solid var(--line,#26292f)}
.mp-title{display:flex;justify-content:space-between;align-items:center;font-weight:600}
.mp-title button{background:transparent;border:0;color:var(--dim,#8b909a);font-size:18px;padding:0 4px;cursor:pointer}
.mp-tabs{display:flex;gap:4px;border:1px solid var(--line,#26292f);border-radius:8px;padding:3px;align-self:flex-start}
.mp-tabs button{background:transparent;border:0;border-radius:6px;padding:5px 12px;color:var(--dim,#8b909a);font:inherit;font-size:12px;cursor:pointer}
.mp-tabs button[aria-selected=true]{background:var(--mp-active,rgba(255,255,255,.08));color:var(--fg,#e6e6e6)}
.mp-search{width:100%;background:var(--mp-bg,var(--panel,#16181c));color:var(--fg,#e6e6e6);border:1px solid var(--line,#26292f);border-radius:8px;padding:8px 10px;font:inherit}
.mp-list{flex:1;min-height:120px;overflow:auto;padding:6px;scrollbar-width:thin}
.mp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;width:100%;text-align:left;background:transparent;border:0;border-radius:8px;padding:8px 10px;color:var(--fg,#e6e6e6);font:inherit;cursor:pointer}
.mp-row:hover{background:var(--mp-active,rgba(255,255,255,.06))}
.mp-row[aria-selected=true]{background:var(--mp-active,rgba(255,255,255,.1));outline:1px solid var(--acc,#7cf5b1)}
.mp-row b{grid-column:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-row small{grid-column:1;color:var(--dim,#8b909a);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-row .mp-meta{grid-column:2;grid-row:1/3;align-self:center;text-align:right;color:var(--dim,#8b909a);font-size:11px;white-space:nowrap}
@media (max-width:480px){.mp-row{grid-template-columns:minmax(0,1fr)}.mp-row .mp-meta{grid-column:1;grid-row:3;text-align:left}}
.mp-empty{padding:24px;text-align:center;color:var(--dim,#8b909a);font-size:12px}
.mp-foot{border-top:1px solid var(--line,#26292f);padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.mp-custom{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dim,#8b909a)}
.mp-custom input{flex:1;min-width:0;background:var(--mp-bg,var(--panel,#16181c));color:var(--fg,#e6e6e6);border:1px solid var(--line,#26292f);border-radius:8px;padding:7px 10px;font:inherit}
.mp-reasoning{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;color:var(--dim,#8b909a)}
.mp-reasoning .mp-seg{display:flex;flex-wrap:wrap;gap:2px;border:1px solid var(--line,#26292f);border-radius:8px;padding:2px}
.mp-seg button{background:transparent;border:0;border-radius:6px;padding:4px 10px;color:var(--dim,#8b909a);font:inherit;font-size:12px;cursor:pointer}
.mp-seg button[aria-pressed=true]{background:var(--acc,#7cf5b1);color:#000}
.mp-hint{flex-basis:100%;font-size:11px;color:var(--dim,#8b909a);min-height:1.2em}
.mp-actions{display:flex;justify-content:space-between;align-items:center;gap:8px}
.mp-actions .mp-selected{font-size:12px;color:var(--dim,#8b909a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.mp-actions button{background:var(--acc,#7cf5b1);color:#000;border:0;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.mp-actions button:disabled{opacity:.4;cursor:default}
.mp-actions button.mp-cancel{background:transparent;color:var(--dim,#8b909a);border:1px solid var(--line,#26292f);font-weight:400}
.mp-error{color:var(--bad,#f57c7c);font-size:12px}
`;

// providers: [{id,label,prefix}] connected providers. fetchModels(id) resolves a list of
// {id,name,reasoning,context,price}. value: {model, reasoning}. onChange(value, info) fires on "use model".
export function createModelPicker({ providers, fetchModels, value, onChange, allowCustom = true }) {
  if (!document.getElementById('mp-style')) { const st = document.createElement('style'); st.id = 'mp-style'; st.textContent = CSS; document.head.appendChild(st); }
  const dlg = document.createElement('dialog');
  dlg.className = 'mp';
  dlg.setAttribute('aria-label', 'choose a model');
  dlg.innerHTML = `
    <div class="mp-head">
      <div class="mp-title"><span>choose a model</span><button type="button" class="mp-close" aria-label="close">×</button></div>
      <div class="mp-tabs" role="tablist">${providers.map(p => `<button type="button" role="tab" data-provider="${esc(p.id)}">${esc(p.label)}</button>`).join('')}</div>
      <input class="mp-search" type="search" placeholder="search models" aria-label="search models" autocomplete="off">
    </div>
    <div class="mp-list" role="listbox" aria-label="models"></div>
    <div class="mp-foot">
      <label class="mp-custom" ${allowCustom ? '' : 'hidden'}>custom ID <input type="text" placeholder="provider/model-id" spellcheck="false" aria-label="custom model ID"></label>
      <div class="mp-reasoning"><span>reasoning</span><div class="mp-seg" role="group" aria-label="reasoning level"></div><span class="mp-hint"></span></div>
      <div class="mp-actions"><span class="mp-selected"></span><span style="display:flex;gap:8px"><button type="button" class="mp-cancel">cancel</button><button type="button" class="mp-use">use model</button></span></div>
    </div>`;
  document.body.appendChild(dlg);
  const $ = s => dlg.querySelector(s);
  const cache = new Map();
  const state = { provider: providers[0]?.id, model: value?.model || '', reasoning: value?.reasoning || 'auto', info: undefined, custom: false };
  let models = [];
  let loadSeq = 0; // a slower earlier provider load must not overwrite the tab the user switched to

  const providerOf = spec => providers.find(p => p.prefix && spec.startsWith(p.prefix))?.id || (providers.some(p => p.id === 'openrouter') ? 'openrouter' : providers[0]?.id);

  function renderTabs() { dlg.querySelectorAll('[role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.provider === state.provider))); }
  function renderReasoning() {
    // A custom ID has no metadata: every level stays selectable and the provider decides.
    const choices = reasoningChoices(state.custom ? { supported_efforts: null, mandatory: false } : state.info?.reasoning);
    if (!choices.some(c => c.value === state.reasoning)) state.reasoning = 'auto';
    $('.mp-seg').innerHTML = choices.map(c => `<button type="button" data-value="${c.value}" aria-pressed="${String(c.value === state.reasoning)}" title="${esc(c.hint)}">${esc(c.label)}</button>`).join('');
    $('.mp-hint').textContent = choices.find(c => c.value === state.reasoning)?.hint || '';
    $('.mp-selected').textContent = state.model ? `${state.info?.name || state.model} · reasoning ${EFFORT_LABELS[state.reasoning] || state.reasoning}` : 'pick a model';
    $('.mp-use').disabled = !state.model;
  }
  function renderList() {
    const q = $('.mp-search').value.trim().toLowerCase();
    const rows = models.filter(m => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    $('.mp-list').innerHTML = rows.length ? rows.map(m => `<button type="button" class="mp-row" role="option" data-id="${esc(m.id)}" aria-selected="${String(m.id === state.model)}">
        <b>${esc(m.name)}</b><span class="mp-meta">${[m.price ? `${money(m.price.input)} / ${money(m.price.output)} per M` : '', tokens(m.context) ? `${tokens(m.context)} ctx` : ''].filter(Boolean).join(' · ')}</span>
        <small>${esc(m.id.replace(/^(openai|gemini):/, ''))} · ${reasoningSummary(m.reasoning)}</small></button>`).join('')
      : `<p class="mp-empty">${models.length ? 'no models match' : 'no models'}</p>`;
    const sel = $('.mp-row[aria-selected=true]'); if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  async function loadProvider(id) {
    const seq = ++loadSeq;
    state.provider = id; renderTabs();
    $('.mp-list').innerHTML = '<p class="mp-empty">loading models…</p>';
    $('.mp-custom').hidden = !allowCustom || id !== 'openrouter';
    try {
      if (!cache.has(id)) { const list = await fetchModels(id); if (seq !== loadSeq) return; cache.set(id, list); }
      models = cache.get(id);
      if (state.model && !state.info) state.info = models.find(m => m.id === state.model);
    } catch (err) { if (seq !== loadSeq) return; models = []; $('.mp-list').innerHTML = `<p class="mp-empty mp-error">${esc(err.message)}</p>`; renderReasoning(); return; }
    renderList(); renderReasoning();
  }
  function select(id, info) { state.model = id; state.info = info; state.custom = !info; renderList(); renderReasoning(); }

  dlg.querySelectorAll('[role=tab]').forEach(b => b.addEventListener('click', () => loadProvider(b.dataset.provider)));
  $('.mp-search').addEventListener('input', renderList);
  $('.mp-list').addEventListener('click', e => { const row = e.target.closest('.mp-row'); if (row) { $('.mp-custom input').value = ''; select(row.dataset.id, models.find(m => m.id === row.dataset.id)); } });
  $('.mp-custom input').addEventListener('input', e => { const v = e.target.value.trim(); if (v) select(v, undefined); else if (state.custom) { state.model = ''; state.info = undefined; state.custom = false; renderList(); renderReasoning(); } });
  $('.mp-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { state.reasoning = b.dataset.value; renderReasoning(); } });
  $('.mp-close').addEventListener('click', () => dlg.close());
  $('.mp-cancel').addEventListener('click', () => dlg.close());
  $('.mp-use').addEventListener('click', () => { dlg.close(); onChange({ model: state.model, reasoning: state.reasoning }, state.info); });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  return {
    dialog: dlg,
    open(current) {
      if (current) { state.model = current.model || state.model; state.reasoning = current.reasoning || state.reasoning; state.info = undefined; }
      const id = providerOf(state.model || '');
      $('.mp-search').value = '';
      const known = cache.get(id)?.some(m => m.id === state.model);
      $('.mp-custom input').value = state.model && cache.has(id) && !known ? state.model : '';
      dlg.showModal();
      loadProvider(id).then(() => { if (state.model && !models.some(m => m.id === state.model) && id === 'openrouter') $('.mp-custom input').value = state.model; $('.mp-search').focus(); });
    },
    label(current) {
      const m = current?.model || '';
      const info = [...cache.values()].flat().find(x => x.id === m);
      return m ? `${info?.name || m.replace(/^(openai|gemini):/, '')} · reasoning ${EFFORT_LABELS[current.reasoning] || current.reasoning || 'auto'}` : 'choose a model';
    },
    // Load a provider's list ahead of time so labels can show model names before the dialog opens.
    async warm(spec) { const id = providerOf(spec || ''); if (!cache.has(id)) cache.set(id, await fetchModels(id)); },
  };
}
