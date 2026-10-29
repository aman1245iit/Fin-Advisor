// Fin Advisor – adviser co-pilot front end. One client case flows through five screens.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (x) => (x == null || !isFinite(x) ? '–' : '₹' + Math.round(x).toLocaleString('en-IN'));
const inrShort = (x) => {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e7) return '₹' + (x / 1e7).toFixed(2) + ' Cr';
  if (a >= 1e5) return '₹' + (x / 1e5).toFixed(2) + ' L';
  return inr(x);
};
const pct = (x, d = 1) => (x == null || !isFinite(x) ? 'n/a' : (x * 100).toFixed(d).replace(/^-(0\.?0*)$/, '$1') + '%');
// Indian-style money axis: ticks in ₹ lakh / crore instead of Plotly's "M".
function moneyAxis(values) {
  const max = Math.max(...values.filter(isFinite), 1);
  const raw = max / 5, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const tickvals = [];
  for (let v = 0; v <= max * 1.05; v += step) tickvals.push(v);
  return { tickvals, ticktext: tickvals.map((v) => (v === 0 ? '₹0' : inrShort(v).replace('.00 ', ' '))) };
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SLEEVE_ORDER = ['largecap', 'flexicap', 'midcap', 'smallcap', 'debt', 'liquid', 'gold', 'hybrid'];
const sleeveColor = (k) => cssVar(`--s-${k}`);

const SCREENS = [
  { id: 'onboard', n: 1, label: 'Client onboarding' },
  { id: 'risk', n: 2, label: 'Risk profile' },
  { id: 'plan', n: 3, label: 'Financial planning' },
  { id: 'funds', n: 4, label: 'Fund research' },
  { id: 'research', n: 5, label: 'Research & documents' },
  { id: 'review', n: 6, label: 'Adviser review' },
];
const PIPELINE = ['Client profile submitted', 'Risk & suitability checks', 'Goal-based plan', 'Fund research & backtest', 'Guardrail validation', 'Draft on adviser dashboard', 'Adviser review', 'Approve / reject', 'Client output released'];

const state = { meta: null, me: null, cases: [], view: null, chat: [], screen: 'onboard', formDraft: null, option: 'recommended', docFilter: 'all', docSearch: null };

// Per-browser preferences (theme, approval signature, start screen); storage may be unavailable.
const pref = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} },
};

const toSignIn = () => location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`);
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  // Session expired or signed out elsewhere (sign-in errors from Settings forms are 401s too, without signIn).
  if (r.status === 401 && j.signIn) { toSignIn(); throw new Error('Please sign in.'); }
  if (!r.ok) throw Object.assign(new Error(j.error || (j.errors || []).join('; ') || r.statusText), { data: j, status: r.status });
  return j;
}
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}

// ---------- Blank profile ----------
const BASE = {
  name: '', age: '', location: '', employmentStatus: 'salaried', incomeStability: 'stable', monthlyIncome: '', monthlyExpenses: '', monthlyEmi: 0, outstandingLoans: 0,
  existingInvestments: 0, savingsToInvest: 0, emergencySavings: 0, dependants: 0, dependantsNote: '', hasLifeCover: 'yes', hasHealthCover: 'yes',
  horizonYears: '', experience: 'basic', lossReaction: 'hold', fluctuationComfort: 'somewhat_uncomfortable', maxLoss: '20', preferredRisk: 'medium',
  specialRequest: 'none', notes: '', adviserConflicts: '', goals: [],
};
// ---------- Navigation ----------
function renderSteps() {
  const has = !!state.view;
  $('#steps').innerHTML = SCREENS.map((s) => `<button data-go="${s.id}" ${s.id !== 'onboard' && !has ? 'disabled' : ''} ${state.screen === s.id ? 'aria-current="page"' : ''}><span class="n">${s.n}</span>${s.label}</button>`).join('');
  $$('#steps button').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
}
// Hash changes made by the app itself (tabs, case picker, buttons) set appNav, so a change
// without it is the browser's Back/Forward. Leaving Client onboarding that way goes to the front page.
let appNav = false;
function navigate(hash) {
  if (location.hash === hash) return;
  appNav = true;
  location.hash = hash;
}
function go(screen) { navigate(`#/${screen}${state.view ? `/${state.view.id}` : ''}`); }
async function route() {
  const [, screen = 'onboard', id] = location.hash.split('/');
  state.screen = SCREENS.some((s) => s.id === screen) ? screen : 'onboard';
  if (id && (!state.view || state.view.id !== +id)) {
    // Another adviser's case answers 404, the same as one that does not exist.
    try { await loadCase(+id, false); }
    catch (e) {
      if (e.status !== 404) throw e;
      state.view = null;
      if (pref.get('lastCase') === id) pref.set('lastCase', null);
      toast(`Case #${id} was not found among your clients.`, true);
      history.replaceState(null, '', '#/onboard');
      state.screen = 'onboard';
    }
  }
  if (!id && state.screen === 'onboard' && state.view && !state.keepCase) state.view = null;
  state.keepCase = false;
  if (state.screen !== 'onboard' && !state.view) state.screen = 'onboard';
  renderSteps(); renderPicker(); render();
  window.scrollTo({ top: 0 });
}
async function loadCase(id, rerender = true) {
  state.view = await api(`/api/cases/${id}`);
  state.chat = await api(`/api/cases/${id}/research`);
  pref.set('lastCase', String(id)); // for the "reopen last case" start-screen setting
  if (rerender) { renderSteps(); renderPicker(); render(); }
}
async function refreshCases() { state.cases = await api('/api/cases'); renderPicker(); }
function renderPicker() {
  const sel = $('#casePicker');
  sel.innerHTML = `<option value="">${state.cases.length ? 'Open a client case…' : 'No cases yet'}</option>` +
    state.cases.map((c) => `<option value="${c.id}" ${state.view?.id === c.id ? 'selected' : ''}>#${c.id} ${esc(c.client_name)} · ${c.status.replace(/_/g, ' ').toLowerCase()}</option>`).join('');
}

function pipelineHtml() {
  const v = state.view;
  let done = 0;
  if (v?.draft) {
    done = 6;
    if (v.reviews.length) done = 7;
    if (['APPROVED', 'REJECTED'].includes(v.draft.status)) done = 8;
    if (v.draft.status === 'APPROVED') done = 9;
  }
  return `<div class="pipeline">${PIPELINE.map((p, i) => `${i ? '<i>→</i>' : ''}<span class="${i < done ? 'done' : i === done ? 'now' : ''}">${p}</span>`).join('')}</div>`;
}

function render() {
  const el = $('#app');
  ({ onboard: renderOnboard, risk: renderRisk, plan: renderPlan, funds: renderFunds, research: renderResearch, review: renderReview })[state.screen](el);
}

// ---------- Screen 1: Onboarding ----------
const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${k}" ${String(v) === String(k) ? 'selected' : ''}>${l}</option>`).join('');
function field(label, name, value, type = 'number', extra = '') {
  return `<label class="f">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${type === 'number' ? 'step="any" min="0"' : ''} ${extra}></label>`;
}
function selectField(label, name, value, pairs) { return `<label class="f">${label}<select name="${name}">${opt(pairs, value)}</select></label>`; }

function goalRow(g = {}, i) {
  const types = Object.entries(state.meta.rules.GOAL_TYPES).map(([k, v]) => [k, v.label]);
  return `<tr data-i="${i}">
    <td><input name="g_name" value="${esc(g.name ?? '')}" placeholder="Goal name" required></td>
    <td><select name="g_type">${opt(types, g.type ?? 'other')}</select></td>
    <td><input name="g_cost" type="number" min="0" step="any" value="${g.currentCost ?? ''}" placeholder="₹ today" required></td>
    <td><input name="g_years" type="number" min="1" max="50" step="any" value="${g.years ?? ''}" required></td>
    <td><input name="g_saved" type="number" min="0" step="any" value="${g.existingSavings ?? 0}"></td>
    <td><input name="g_infl" type="number" min="0" max="30" step="0.1" value="${g.inflation != null ? +(g.inflation * 100).toFixed(2) : 6}"></td>
    <td><input name="g_ret" type="number" min="0" max="50" step="0.1" value="${g.assumedReturn != null ? +(g.assumedReturn * 100).toFixed(2) : 10}"></td>
    <td><button type="button" class="btn small ghost" data-del="${i}" aria-label="Remove goal">✕</button></td>
  </tr>`;
}

// Retired and non-earning clients may have no income: savings and pension are what they live on.
const NON_EARNING = ['retired', 'not_earning'];
function incomeField(c) {
  return NON_EARNING.includes(c.employmentStatus)
    ? field('Monthly pension, rent & interest (₹, 0 if none)', 'monthlyIncome', c.monthlyIncome)
    : field('Monthly income (₹)', 'monthlyIncome', c.monthlyIncome, 'number', 'required');
}

function renderOnboard(el) {
  const c = state.formDraft ?? state.view?.client ?? { ...BASE, goals: [{ name: '', type: 'retirement', currentCost: '', years: '', existingSavings: 0, inflation: 0.06, assumedReturn: 0.1 }] };
  const editing = !!state.view;
  el.innerHTML = `
  <div class="screen-head">
    <div><h2>${editing ? `Edit client – case #${state.view.id}` : 'New client'}</h2>
    <p>Enter the client once. Every module (risk, planning, funds, research and review) reads from this single profile. ${editing ? 'Saving creates a new draft version for review.' : ''}</p></div>
  </div>
  ${editing ? `<div class="card" style="margin-bottom:16px">${pipelineHtml()}</div>` : ''}
  <form id="clientForm" class="grid" novalidate>
    <div class="card"><fieldset><legend>Client & financial information</legend><div class="fields">
      ${field('Client name', 'name', c.name, 'text', 'required')}
      ${field('Age', 'age', c.age, 'number', 'required')}
      ${field('Location', 'location', c.location, 'text')}
      ${selectField('Employment status', 'employmentStatus', c.employmentStatus ?? 'salaried', Object.entries(state.meta.rules.EMPLOYMENT_STATUS ?? { salaried: 'Salaried' }))}
      ${selectField('Income stability', 'incomeStability', c.incomeStability, [['stable', 'Stable (salary/pension)'], ['variable', 'Variable (business/bonus)'], ['irregular', 'Irregular'], ['none', 'No regular income']])}
      ${incomeField(c)}
      ${field('Monthly expenses (₹)', 'monthlyExpenses', c.monthlyExpenses, 'number', 'required')}
      ${field('Monthly EMIs (₹)', 'monthlyEmi', c.monthlyEmi)}
      ${field('Outstanding loans & liabilities (₹)', 'outstandingLoans', c.outstandingLoans)}
      ${field('Existing investments (₹)', 'existingInvestments', c.existingInvestments)}
      ${field('Savings not yet invested – bank, FDs (₹)', 'savingsToInvest', c.savingsToInvest ?? 0)}
      ${field('Emergency savings (₹)', 'emergencySavings', c.emergencySavings)}
      ${field('Number of dependants', 'dependants', c.dependants)}
      ${field('Dependants (who)', 'dependantsNote', c.dependantsNote, 'text', 'placeholder="e.g. Parents"')}
      ${selectField('Term life cover', 'hasLifeCover', c.hasLifeCover, [['yes', 'Yes'], ['no', 'No']])}
      ${selectField('Health insurance', 'hasHealthCover', c.hasHealthCover, [['yes', 'Yes'], ['no', 'No']])}
      ${field('Investment horizon (years)', 'horizonYears', c.horizonYears, 'number', 'required')}
    </div></fieldset></div>

    <div class="card"><fieldset><legend>Investment behaviour (risk tolerance questionnaire)</legend><div class="fields">
      ${selectField('Investment experience', 'experience', c.experience, [['none', 'None'], ['basic', 'Basic (FDs, a few SIPs)'], ['moderate', 'Moderate (equity funds 3+ yrs)'], ['extensive', 'Extensive (through market crashes)']])}
      ${selectField('If the portfolio fell 20% in a year…', 'lossReaction', c.lossReaction, [['sell_all', 'Sell everything'], ['sell_some', 'Sell some'], ['hold', 'Hold and wait'], ['buy_more', 'Invest more']])}
      ${selectField('Comfort with fluctuations', 'fluctuationComfort', c.fluctuationComfort, [['very_uncomfortable', 'Very uncomfortable'], ['somewhat_uncomfortable', 'Somewhat uncomfortable'], ['comfortable', 'Comfortable'], ['very_comfortable', 'Very comfortable']])}
      ${selectField('Largest 1-year fall acceptable', 'maxLoss', c.maxLoss, [['5', '5%'], ['10', '10%'], ['20', '20%'], ['30', '30% or more']])}
      ${selectField('Preferred level of risk', 'preferredRisk', c.preferredRisk, [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}
      ${selectField('Specific product request', 'specialRequest', c.specialRequest, Object.entries(state.meta.rules.SPECIAL_REQUESTS))}
      <label class="f wide">Client's own words / notes<textarea name="notes" placeholder="Anything the client asked for, e.g. return expectations">${esc(c.notes)}</textarea></label>
      <label class="f wide">Adviser conflicts of interest (disclosed in report)<input name="adviserConflicts" type="text" value="${esc(c.adviserConflicts)}" placeholder="Leave blank if none"></label>
    </div></fieldset></div>

    <div class="card"><fieldset><legend>Financial goals</legend>
      <div class="goals-wrap"><table class="goals-table"><thead><tr><th>Goal</th><th>Type</th><th>Current cost (₹)</th><th>Years</th><th>Savings for it (₹)</th><th>Inflation %</th><th>Assumed return %</th><th></th></tr></thead>
      <tbody id="goalRows">${c.goals.map(goalRow).join('')}</tbody></table></div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn small" id="addGoal">+ Add goal</button>
      <span class="hint">Inflation defaults by goal type (education & medical 8%, others 6%) and can be edited. RBI's CPI target is 4% ± 2%.</span></div>
    </fieldset></div>

    <div class="row"><span class="hint">No investment amount is needed: after analysing the finances the co-pilot recommends how much to invest each month and as a lump sum.</span><span class="spacer"></span>
      ${editing ? (state.view.reviews.some((r) => r.action === 'approve')
        ? '<button type="button" class="btn danger-btn" disabled title="This client has an approved plan, so their records must be kept">Delete client</button>'
        : '<button type="button" class="btn danger-btn" id="deleteCase" title="Permanently remove this client and all their data">Delete client</button>') : ''}
      <button type="submit" class="btn primary">${editing ? 'Save & resubmit for review' : 'Run co-pilot →'}</button></div>
  </form>`;

  $('[name=employmentStatus]', el).addEventListener('change', (e) => {
    const lab = $('[name=monthlyIncome]', el).closest('label');
    lab.outerHTML = incomeField({ ...readForm(), employmentStatus: e.target.value });
    if (NON_EARNING.includes(e.target.value) && !(+$('[name=monthlyIncome]', el).value > 0)) $('[name=incomeStability]', el).value = 'none';
  });
  $('#addGoal', el).addEventListener('click', () => {
    state.formDraft = readForm(); state.formDraft.goals.push({ name: '', type: 'other', currentCost: '', years: '', existingSavings: 0, inflation: 0.06, assumedReturn: 0.1 });
    renderOnboard(el);
  });
  $('#goalRows', el).addEventListener('click', (e) => {
    const i = e.target.dataset.del;
    if (i == null) return;
    state.formDraft = readForm(); state.formDraft.goals.splice(+i, 1); renderOnboard(el);
  });
  $('#goalRows', el).addEventListener('change', (e) => {
    if (e.target.name !== 'g_type') return;
    const infl = state.meta.rules.GOAL_TYPES[e.target.value]?.inflation;
    if (infl != null) e.target.closest('tr').querySelector('[name=g_infl]').value = +(infl * 100).toFixed(2);
  });
  $('#deleteCase', el)?.addEventListener('click', async (e) => {
    const { id, client } = state.view;
    if (!confirm(`Permanently delete ${client.name} (case #${id})? This removes the profile, every draft and review, the research conversation and the client report link. It cannot be undone.`)) return;
    e.target.disabled = true;
    try {
      await api(`/api/cases/${id}`, { method: 'DELETE' });
      if (pref.get('lastCase') === String(id)) pref.set('lastCase', null);
      state.view = null; state.formDraft = null; state.chat = [];
      await refreshCases();
      navigate('#/onboard'); route();
      toast(`${client.name} deleted`);
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  });
  $('#clientForm', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const client = readForm();
    const btn = e.submitter; btn.disabled = true; btn.textContent = 'Working…';
    try {
      const v = editing ? await api(`/api/cases/${state.view.id}`, { method: 'PUT', body: { client } }) : await api('/api/cases', { method: 'POST', body: { client } });
      state.view = v; state.formDraft = null; state.chat = await api(`/api/cases/${v.id}/research`);
      await refreshCases();
      toast(`Draft v${v.draft.version} generated and sent to the adviser dashboard`);
      go('risk');
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Try again'; }
  });
}

function readForm() {
  const f = $('#clientForm');
  const fd = new FormData(f);
  const c = {};
  for (const [k, v] of fd.entries()) if (!k.startsWith('g_')) c[k] = v;
  for (const k of ['age', 'monthlyIncome', 'monthlyExpenses', 'monthlyEmi', 'outstandingLoans', 'existingInvestments', 'savingsToInvest', 'emergencySavings', 'dependants', 'horizonYears']) c[k] = c[k] === '' ? '' : +c[k];
  if (NON_EARNING.includes(c.employmentStatus) && c.monthlyIncome === '') c.monthlyIncome = 0;
  c.goals = $$('#goalRows tr', f).map((tr) => ({
    name: $('[name=g_name]', tr).value.trim(), type: $('[name=g_type]', tr).value,
    currentCost: +$('[name=g_cost]', tr).value, years: +$('[name=g_years]', tr).value, existingSavings: +$('[name=g_saved]', tr).value || 0,
    inflation: +$('[name=g_infl]', tr).value / 100, assumedReturn: +$('[name=g_ret]', tr).value / 100,
  }));
  return c;
}

// ---------- Plotly helpers ----------
function baseLayout(extra = {}) {
  const ink = cssVar('--ink-2'), grid = cssVar('--grid');
  return {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Inter, system-ui, sans-serif', size: 12, color: ink },
    margin: { l: 56, r: 16, t: 10, b: 40 },
    xaxis: { gridcolor: grid, zeroline: false, linecolor: grid, ...extra.xaxis },
    yaxis: { gridcolor: grid, zeroline: false, linecolor: grid, ...extra.yaxis },
    hovermode: 'x unified', hoverlabel: { bgcolor: cssVar('--card'), bordercolor: cssVar('--line'), font: { color: cssVar('--ink') } },
    showlegend: false,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['xaxis', 'yaxis'].includes(k))),
  };
}
const plotCfg = { displayModeBar: false, responsive: true };
// Legend keys: a short line for line series (dashed where the line is dashed), a square for fills.
function legendHtml(items, kind = 'line') {
  return `<div class="legend">${items.map(([label, color, dash, k = kind]) => `<span>${k === 'line'
    ? `<i style="display:inline-block;width:16px;margin-right:6px;vertical-align:3px;border-top:2px ${dash ? 'dashed' : 'solid'} ${color}"></i>`
    : `<i class="swatch" style="background:${color}"></i>`}${esc(label)}</span>`).join('')}</div>`;
}

// ---------- Screen 2: Risk ----------
function flagsHtml(flags, withJustify = false, values = {}) {
  if (!flags.length) return '<p class="muted">No conflicts or warnings.</p>';
  return flags.map((f) => `<div class="flag ${f.severity}"><span class="ic" aria-hidden="true">${f.severity === 'high' ? '!' : f.severity === 'medium' ? '?' : 'i'}</span>
    <div class="meta"><b>${f.severity.toUpperCase()}</b> · ${esc(f.source ?? '')} · ${esc(f.code)}${f.id ? ` · ${f.id}` : ''}</div>
    <div>${esc(f.message)}</div>
    ${withJustify && f.severity === 'high' ? `<textarea data-justify="${f.id}" placeholder="Adviser justification for ${f.id} (required to approve, min 15 characters)">${esc(values[f.id] ?? '')}</textarea>` : ''}
  </div>`).join('');
}

function renderRisk(el) {
  const d = state.view.draft, r = d.risk;
  el.innerHTML = `
  <div class="screen-head"><div><h2>Risk profile · ${esc(state.view.client.name)}</h2>
  <p>Risk capacity (can they afford risk?) and risk tolerance (are they comfortable with it?) are scored separately. ${esc(r.final.rule)}</p></div></div>
  <div class="grid g3">
    <div class="card"><div class="kpi"><span class="label">Risk capacity</span><span class="value">${r.capacity.level}</span><span class="note">${r.capacity.score}/100 · Low &lt; 40 ≤ Medium &lt; 70 ≤ High</span></div></div>
    <div class="card"><div class="kpi"><span class="label">Risk tolerance</span><span class="value">${r.tolerance.level}</span><span class="note">${r.tolerance.score}/15 · ${esc(r.tolerance.bands)}</span></div></div>
    <div class="card hero"><div class="kpi"><span class="label">Overall proposed risk level</span><span class="value">${r.final.level}</span><span class="note">Reason: ${esc(r.reasons[0])}</span></div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Conflict-resolution matrix</h3><p class="sub">Each cell shows the proposed level = lower of capacity and tolerance. The dot is this client.</p>
      <div id="matrix" class="chart short"></div></div>
    <div class="card"><h3>Conflicts requiring review</h3>${flagsHtml(d.guardrails.flags.filter((f) => f.source === 'Risk profile'))}
      <h3 style="margin-top:16px">Why this classification</h3><ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Risk capacity factors</h3><p class="sub">Financial ability to absorb losses · each factor scored out of 10 and counted equally · average × 10 = score out of 100</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Factor</th><th class="n">Value</th><th>Score (out of 10)</th></tr></thead><tbody>
      ${r.capacity.factors.map((f) => `<tr><td>${esc(f.label)}</td><td class="n">${fmtFactor(f)}</td><td style="min-width:150px"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="factor-bar" style="flex:1"><i style="width:${(f.points / f.max) * 100}%"></i></div><span class="small"><b>${f.points}</b>/${f.max}</span></div></td></tr>`).join('')}
      <tr><td><b>Capacity score</b></td><td></td><td><b>${r.capacity.score}/100 → ${r.capacity.level}</b> <span class="small muted">(average of the factor scores × 10)</span></td></tr></tbody></table></div></div>
    <div class="card"><h3>Risk tolerance questionnaire</h3><p class="sub">Behaviour and comfort with volatility</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Question</th><th>Answer</th><th class="n">Points</th></tr></thead><tbody>
      ${r.tolerance.answers.map((a) => `<tr><td>${esc(a.label)}</td><td>${esc(String(a.answer ?? '').replace(/_/g, ' '))}${a.label.includes('fall') && /^\d+$/.test(a.answer) ? '%' : ''}</td><td class="n">${a.points}/${a.max}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td></td><td class="n"><b>${r.tolerance.score}/15 → ${r.tolerance.level}</b></td></tr></tbody></table></div></div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Key financial ratios</h3><div class="grid g4">
    ${r.financials.monthlyDraw > 0 && r.financials.nonEarning
      ? `<div class="kpi"><span class="label">Drawn from savings</span><span class="value">${inrShort(r.financials.monthlyDraw)}/mo</span><span class="note">${r.financials.savingsCoverYears != null ? `savings cover ${r.financials.savingsCoverYears.toFixed(1)} years` : ''}</span></div>`
      : `<div class="kpi"><span class="label">Monthly surplus</span><span class="value">${inrShort(r.financials.surplus)}</span><span class="note">${pct(r.financials.surplusRatio, 0)} of income</span></div>`}
    <div class="kpi"><span class="label">Emergency cover</span><span class="value">${r.financials.emergencyMonths.toFixed(1)} mo</span><span class="note">target ${r.financials.emergencyTargetMonths ?? 6} months</span></div>
    <div class="kpi"><span class="label">EMI burden</span><span class="value">${pct(r.financials.emiRatio, 0)}</span><span class="note">of income</span></div>
    <div class="kpi"><span class="label">Loans ÷ annual income</span><span class="value">${r.financials.debtToAnnualIncome.toFixed(1)}×</span><span class="note">outstanding</span></div>
  </div></div>`;
  drawMatrix(r);
}
function fmtFactor(f) {
  if (typeof f.value === 'string') return esc(f.value);
  if (f.label.includes('%')) return pct(f.value, 0);
  if (f.label.includes('months') || f.key === 'savingsCoverYears') return f.value.toFixed(1);
  return f.value;
}
function drawMatrix(r) {
  const levels = ['Conservative', 'Moderate', 'Aggressive'];
  const caps = ['Low', 'Medium', 'High'];
  const z = caps.map((_, ci) => levels.map((_, ti) => Math.min(ci, ti)));
  const text = z.map((row) => row.map((v) => levels[v]));
  const ramp = [cssVar('--m-0'), cssVar('--m-1'), cssVar('--m-2')];
  // Numeric axes so the client marker can sit in the cell's corner, clear of the label.
  const ix = levels.indexOf(r.tolerance.level), iy = caps.indexOf(r.capacity.level);
  Plotly.newPlot('matrix', [
    { type: 'heatmap', z, x: [0, 1, 2], y: [0, 1, 2], text, texttemplate: '%{text}', textfont: { color: cssVar('--ink') }, showscale: false, xgap: 3, ygap: 3,
      colorscale: [[0, ramp[0]], [0.5, ramp[1]], [1, ramp[2]]], hovertemplate: '%{text}<extra></extra>', opacity: 0.85 },
    { type: 'scatter', mode: 'markers+text', x: [ix + 0.3], y: [iy + 0.28], text: ['client'], textposition: 'middle left', textfont: { size: 11, color: cssVar('--ink') },
      marker: { size: 14, color: cssVar('--saffron'), line: { color: cssVar('--card'), width: 2 } }, hovertemplate: `This client: capacity ${r.capacity.level}, tolerance ${r.tolerance.level}<extra></extra>` },
  ], baseLayout({ hovermode: 'closest',
    xaxis: { title: { text: 'Risk tolerance (behaviour)' }, gridcolor: 'rgba(0,0,0,0)', tickvals: [0, 1, 2], ticktext: levels },
    yaxis: { title: { text: 'Risk capacity (finances)' }, gridcolor: 'rgba(0,0,0,0)', tickvals: [0, 1, 2], ticktext: caps },
    margin: { l: 90, r: 10, t: 6, b: 48 } }), plotCfg);
}

// ---------- Screen 3: Planning ----------
function renderPlan(el) {
  const d = state.view.draft, p = d.plan;
  const fit = p.surplus > 0 ? p.totalSip / p.surplus : Infinity;
  const legacy = p.goals.some((g) => !g.monteCarlo);
  const opts = d.investOptions ?? [];
  if (!opts.some((o) => o.id === state.option)) state.option = 'recommended';
  el.innerHTML = `
  <div class="screen-head"><div><h2>Financial plan</h2><p>Inflation-adjusted targets, monthly SIPs, a rule-based allocation that glides from growth to safety, a range of likely outcomes, and several ways to invest. Assumed returns are planning inputs, never promises.</p></div></div>
  ${legacy ? `<div class="flag medium" style="margin-bottom:16px"><span class="ic">?</span><div class="meta"><b>OLDER DRAFT</b></div><div>This draft was generated by an earlier version, so outcome ranges, investment options and the de-risking schedule are missing. Open screen 1 and choose “Save & resubmit” to regenerate it.</div></div>` : ''}
  <div class="grid g4">
    <div class="card"><div class="kpi"><span class="label">Total monthly SIP</span><span class="value">${inrShort(p.totalSip)}</span><span class="note">recommended, all goals</span></div></div>
    <div class="card"><div class="kpi"><span class="label">Monthly surplus</span><span class="value">${inrShort(p.surplus)}</span><span class="note">SIP uses ${isFinite(fit) ? pct(fit, 0) : '—'} of it</span></div></div>
    ${p.investRange ? `<div class="card hero"><div class="kpi"><span class="label">Suggested monthly investment</span><span class="value">${p.investRange.monthly.high > 0 ? rangeShort(p.investRange.monthly) : 'No SIP'}</span><span class="note">${p.investRange.monthly.high > 0 ? 'worked out from the finances' : p.investRange.withdrawals ? 'invest a lump sum, withdraw by SWP' : 'no surplus to invest'}</span></div></div>`
      : `<div class="card"><div class="kpi"><span class="label">Stated investment amount</span><span class="value">${inrShort(p.budget)}</span><span class="note">older draft</span></div></div>`}
    <div class="card"><div class="kpi"><span class="label">Risk level used</span><span class="value">${d.risk.final.level}</span><span class="note">from screen 2</span></div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Suggested starting allocation</h3><p class="sub">All goals combined, weighted by SIP</p><div id="alloc" class="chart short"></div></div>
    <div class="card"><h3>Planning conventions</h3>
      <div class="formula">Future cost   FV = C × (1 + i)^n
Monthly rate  r = (1 + R)^(1/12) − 1   (effective annual convention)
SIP           P = FV_gap × r ÷ ((1 + r)^N − 1)   (end of month)
Gap           FV_gap = FV − savings × (1 + R)^n
Glide         equity = long-term equity × clamp((years left − ${state.meta.rules.GLIDE_END ?? 3}) ÷ ${(state.meta.rules.GLIDE_START ?? 10) - (state.meta.rules.GLIDE_END ?? 3)})</div>
      <p class="small muted">The <b>recommended SIP</b> is the higher of the flat-rate SIP and the glide-path SIP, because expected return falls as money moves to debt near the goal. Hitting the target with it is roughly a coin flip (that is what an “expected” return means), so each goal also shows the SIP needed for 80% confidence.</p>
      <details><summary>Return and volatility assumptions</summary><table class="data"><thead><tr><th>Asset</th><th class="n">Return</th><th class="n">Volatility</th></tr></thead><tbody>${Object.entries(p.assumptions).filter(([k]) => k !== 'hybrid').map(([k, v]) => `<tr><td><i class="swatch" style="background:${sleeveColor(k)}"></i>${k}</td><td class="n">${pct(v, 2)}</td><td class="n">${pct((p.volatility ?? state.meta.rules.ASSET_VOLATILITY ?? {})[k], 1)}</td></tr>`).join('')}</tbody></table></details>
    </div>
  </div>
  ${p.investRange ? investRangeHtml(p.investRange) : ''}
  ${opts.length ? optionsHtml(opts) : ''}
  ${p.goals.map((g, i) => goalCard(g, i, opts)).join('')}`;
  drawAlloc('alloc', p.combinedAllocation);
  p.goals.forEach((g, i) => { drawProjection(`proj${i}`, g); drawGlide(`glide${i}`, g); });
  $$('[data-option]', el).forEach((b) => b.addEventListener('click', () => { state.option = b.dataset.option; renderPlan(el); }));
  $$('[data-apply]', el).forEach((b) => b.addEventListener('click', () => applyOption(b.dataset.apply)));
}

// "1.2L–2L" style range; "up to X" when the low end is zero.
function rangeShort({ low, high }) { return low > 0 && low !== high ? `${inrShort(low)}–${inrShort(high)}` : low > 0 ? inrShort(high) : `up to ${inrShort(high)}`; }
function rangeFull({ low, high }) { return low > 0 && low !== high ? `${inr(low)} – ${inr(high)}` : low > 0 ? inr(high) : `up to ${inr(high)}`; }

function investRangeHtml(r) {
  const w = r.withdrawals;
  return `<div class="section-title"><h3>How much to invest</h3><span>Recommended by the co-pilot from income, expenses, savings and goals. The client was not asked for an amount.</span></div>
  <div class="grid ${w ? 'g3' : 'g2'}">
    <div class="card"><div class="kpi"><span class="label">Every month (SIP)</span><span class="value">${r.monthly.high > 0 ? rangeFull(r.monthly) : 'None'}</span>
      <span class="note">${r.monthly.high > 0 ? `goals need ${inr(r.monthly.need)} · 80% confidence ${inr(r.monthly.need80)} · affordable ${inr(r.monthly.affordLow)}–${inr(r.monthly.affordHigh)}` : 'income does not leave a monthly surplus'}</span></div></div>
    <div class="card"><div class="kpi"><span class="label">One-time (lump sum)</span><span class="value">${r.lumpSum.high > 0 ? rangeFull(r.lumpSum) : 'None'}</span>
      <span class="note">${r.lumpSum.high > 0 ? `from savings not yet invested, after the ${inr(r.lumpSum.emergencyTarget)} emergency fund` : 'no uninvested savings beyond the emergency fund'}</span></div></div>
    ${w ? `<div class="card"><div class="kpi"><span class="label">Monthly withdrawal (SWP)</span><span class="value ${w.rate > 0.06 ? 'crit' : w.rate > 0.04 ? 'warn' : 'good'}">${inr(w.monthly)}</span>
      <span class="note">${isFinite(w.rate) ? pct(w.rate, 1) : '—'} a year of ${inrShort(w.corpus)} investable savings · ${inrShort(w.bucket)} kept in liquid funds</span></div></div>` : ''}
  </div>
  <div class="card" style="margin-top:16px"><h3>How the range was worked out</h3><ul>${r.basis.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`;
}

function optionsHtml(opts) {
  const visible = opts.filter((o) => !o.sameAs);
  return `<div class="section-title"><h3>Where to invest – options</h3><span>Same suitability-based allocation; different fund choices. Only funds that passed screening are used.</span></div>
  <div class="options">${visible.map((o) => `<div class="card option ${state.option === o.id ? 'on' : ''}">
    <div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(o.title)}</h3>${o.id === 'recommended' ? '<span class="pill status">in draft</span>' : ''}</div>
    <p class="small muted" style="margin:6px 0 10px">${esc(o.blurb)}</p>
    <div class="opt-stats">
      <div><span>Weighted TER</span><b>${o.ter.toFixed(2)}%</b></div>
      <div><span>Funds / AMCs</span><b>${o.fundCount} / ${o.amcs.length}</b></div>
      <div><span>10y CAGR*</span><b>${o.history ? pct(o.history.cagr, 2) : 'n/a'}</b></div>
      <div><span>Max drawdown*</span><b>${o.history ? pct(o.history.maxDrawdown) : 'n/a'}</b></div>
    </div>
    <ul class="small opt-funds">${o.sleeves.map((s) => `<li><i class="swatch" style="background:${sleeveColor(s.sleeve)}"></i>${s.weight}% · ${esc(s.fund ?? '—')}${s.passive ? ' <span class="tag">index</span>' : ''}</li>`).join('')}</ul>
    <div class="row" style="margin-top:8px"><button class="btn small" data-option="${o.id}">${state.option === o.id ? '✓ Showing below' : 'Show per goal'}</button>
    ${o.id !== 'recommended' && o.applicable && state.view.draft.status !== 'APPROVED' ? `<button class="btn small primary" data-apply="${o.id}" title="Creates a new draft version using these funds">Use in draft</button>` : ''}
    ${!o.applicable ? '<span class="small muted">Discuss with the client; changes the number of funds, so apply it by editing fund picks on screen 6.</span>' : ''}</div>
  </div>`).join('')}</div>
  <p class="small muted">*Historical backtest of each option's starting mix over the last 10 years (annual rebalancing, direct-plan NAVs; younger funds use a disclosed same-sleeve proxy). Past performance does not guarantee future returns. ${opts.filter((o) => o.sameAs).map((o) => `“${esc(o.title)}” is identical to “${esc(o.sameAs)}” for this client.`).join(' ')}</p>`;
}

async function applyOption(id) {
  const o = state.view.draft.investOptions.find((x) => x.id === id);
  if (!o?.overrides) return;
  try {
    state.view = await api(`/api/cases/${state.view.id}`, { method: 'PUT', body: { overrides: o.overrides } });
    await refreshCases();
    state.option = 'recommended';
    toast(`“${o.title}” applied – draft v${state.view.draft.version} sent for review`);
    renderPlan($('#app'));
  } catch (e) { toast(e.message, true); }
}

function goalCard(g, i, opts) {
  const mc = g.monteCarlo, dr = g.derisk;
  const opt = opts.find((o) => o.id === state.option) ?? null;
  const lines = opt?.goals?.find((x) => x.name === g.name)?.lines ?? g.instructions.lines;
  const prob = mc ? mc.successProb : null;
  const probCls = prob == null ? '' : prob >= 0.75 ? 'good' : prob >= 0.5 ? 'warn' : 'crit';
  return `<div class="section-title"><h3>${esc(g.name)}</h3><span>${esc(g.typeLabel)} · ${g.years} years · ${pct(g.inflation)} inflation · ${pct(g.assumedReturn)} assumed return</span></div>
  <div class="grid g4">
    <div class="card"><div class="kpi"><span class="label">Future cost</span><span class="value">${inrShort(g.futureCost)}</span><span class="note">${inrShort(g.currentCost)} today · gap ${inrShort(g.gap)}</span></div></div>
    <div class="card hero"><div class="kpi"><span class="label">Recommended SIP</span><span class="value">${inr(g.recommendedSip)}</span><span class="note">flat ${inr(g.sip)} · glide ${inr(g.sipGlide)}</span></div></div>
    <div class="card"><div class="kpi"><span class="label">Chance of reaching target</span><span class="value ${probCls}">${prob == null ? '–' : pct(prob, 0)}</span><span class="note">${mc ? `at the recommended SIP · ${mc.paths} simulations` : 'regenerate draft to see'}</span></div></div>
    <div class="card"><div class="kpi"><span class="label">SIP for 80% confidence</span><span class="value">${mc ? inr(mc.sipFor[80]) : '–'}</span><span class="note">${mc ? `90%: ${inr(mc.sipFor[90])}` : ''}</span></div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Goal progress projection</h3>
      <p class="sub">${mc ? `Shaded bands: range of simulated outcomes at ${inr(g.recommendedSip)}/month. Pessimistic (10th pct) ${inrShort(mc.endP10)} · median ${inrShort(mc.endP50)} · optimistic (90th pct) ${inrShort(mc.endP90)} vs target ${inrShort(g.futureCost)}.` : 'Corpus at the recommended SIP.'}</p>
      ${legendHtml([['10th–90th percentile', cssVar('--band-outer'), false, 'fill'], ['25th–75th percentile', cssVar('--band-inner'), false, 'fill'], ['Median outcome', cssVar('--s-largecap')], ['Expected (glide path)', cssVar('--s-flexicap'), true], ['Amount invested', cssVar('--muted')], ['Target', cssVar('--crit'), true]])}
      <div id="proj${i}" class="chart"></div>
      ${mc?.shortfallP10 > 0 ? `<p class="small muted">In a weak market (10th percentile) the goal would be short by ${inrShort(mc.shortfallP10)}. Options: raise the SIP towards ${inr(mc.sipFor[80])}, add a lump sum, extend the date, or accept a smaller target.</p>` : mc ? '<p class="small muted">Even the pessimistic path reaches the target.</p>' : ''}</div>
    <div class="card"><h3>Glide path</h3><p class="sub">Allocation held during each year · line = equity %</p>${legendHtml(SLEEVE_ORDER.filter((s) => g.glide.some((y) => y.weights[s])).map((s) => [s, sleeveColor(s)]), 'fill')}<div id="glide${i}" class="chart"></div></div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Where to invest – now</h3>
      ${opts.length > 1 ? `<div class="tabs" role="tablist">${opts.filter((o) => !o.sameAs).map((o) => `<button role="tab" data-option="${o.id}" aria-selected="${state.option === o.id}">${esc(o.title)}</button>`).join('')}</div>` : ''}
      <p class="sub">Monthly SIP and existing savings split for the <b>${esc(opt?.title ?? 'recommended')}</b> option</p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Sleeve</th><th>Fund</th><th class="n">Weight</th><th class="n">TER</th><th class="n">Monthly</th><th class="n">Lump sum</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td><i class="swatch" style="background:${sleeveColor(l.sleeve)}"></i>${esc(l.sleeveLabel)}</td><td>${esc(l.fund)}${l.passive ? ' <span class="tag">index</span>' : ''}</td><td class="n">${l.weight}%</td><td class="n">${l.ter != null ? l.ter + '%' : ''}</td><td class="n">${inr(l.monthly)}</td><td class="n">${inr(l.lumpSum)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted">Why this mix: ${g.currentAllocation.rules.map(esc).join(' · ')}</p></div>
    <div class="card"><h3>How the mix de-risks</h3>${dr ? deriskHtml(g, dr) : `<p class="sub">High-risk assets move to safer ones as the date approaches</p>${g.instructions.shifts.length ? `<ul class="timeline">${g.instructions.shifts.map((s) => `<li>${esc(s.text)}</li>`).join('')}</ul>` : '<p class="muted">Allocation is already at its final, low-risk mix.</p>'}`}</div>
  </div>
  <div class="card" style="margin-top:16px"><details><summary>Supporting calculations & year-by-year table</summary>
    ${Object.values(g.workings).map((w) => `<div class="formula">${esc(w)}</div>`).join('')}
    <div class="table-wrap"><table class="data"><thead><tr><th>Year</th><th>Age</th><th class="n">Equity</th><th class="n">Exp. return</th><th class="n">Volatility</th><th class="n">Invested</th><th class="n">Expected corpus</th>${mc ? '<th class="n">Pessimistic</th><th class="n">Median</th>' : ''}<th class="n">Target</th><th class="n">Funded</th></tr></thead><tbody>
    ${g.projection.map((r, k) => { const gl = g.glide[Math.min(g.glide.length - 1, Math.max(0, Math.ceil(r.year) - 1))]; const m = mc?.series[k]; return `<tr><td>${r.year}</td><td>${r.age ?? ''}</td><td class="n">${gl.equity}%</td><td class="n">${pct(gl.expectedReturn, 2)}</td><td class="n">${gl.volatility != null ? pct(gl.volatility, 1) : ''}</td><td class="n">${inrShort(r.invested)}</td><td class="n">${inrShort(r.glideCorpus)}</td>${mc ? `<td class="n">${inrShort(m?.p10)}</td><td class="n">${inrShort(m?.p50)}</td>` : ''}<td class="n">${inrShort(r.target)}</td><td class="n">${pct(r.glideCorpus / r.target, 0)}</td></tr>`; }).join('')}
    </tbody></table></div>
    ${mc ? `<p class="small muted">${esc(mc.method)} Equity/return columns show the allocation held during that year.</p>` : ''}</details></div>`;
}

function deriskHtml(g, dr) {
  const cls = ['equity', 'debt', 'liquid', 'gold'];
  const color = { equity: cssVar('--s-largecap'), debt: sleeveColor('debt'), liquid: sleeveColor('liquid'), gold: sleeveColor('gold') };
  const mixBar = (m) => `<div class="mixbar">${cls.filter((c) => m[c]).map((c) => `<i style="width:${m[c]}%;background:${color[c]}" title="${c} ${m[c]}%"></i>`).join('')}</div>`;
  const yr = (y) => `Year ${+y.toFixed(1)}${g.glide[0].age ? ` (age ${Math.floor(g.glide[0].age + y)})` : ''}`;
  return `<p class="sub">Three phases; money moves from equity to debt, then to liquid funds, a little each year</p>
  <div class="phases">${dr.phases.map((p) => `<div class="phase ${p.key}" style="flex:${Math.max(p.to - p.from, 0.6)}"><b>${esc(p.label)}</b><span>yrs ${+p.from.toFixed(1)}–${+p.to.toFixed(1)} · equity ${p.equityFrom === p.equityTo ? `${p.equityFrom}%` : `${p.equityFrom}→${p.equityTo}%`}</span></div>`).join('')}</div>
  <ul class="small" style="margin:8px 0 10px;padding-left:18px">${dr.phases.map((p) => `<li><b>${esc(p.label)}:</b> ${esc(p.what)}</li>`).join('')}</ul>
  ${dr.steps.length ? `<div class="table-wrap"><table class="data derisk"><thead><tr><th>When</th><th>Mix after switch</th><th class="n">Equity</th><th class="n">Projected corpus</th><th class="n">Amount to switch</th></tr></thead><tbody>
  ${dr.steps.map((s) => `<tr><td class="when">${yr(s.year)}<div class="small muted">${+s.yearsLeft.toFixed(1)} yrs left</div></td><td style="min-width:110px">${mixBar(s.after)}<div class="small muted">${cls.filter((c) => s.after[c]).map((c) => `${c} ${s.after[c]}%`).join(' · ')}</div></td><td class="n">${s.before.equity}% → <b>${s.after.equity}%</b></td><td class="n">${inrShort(s.corpus)}</td><td class="n"><b>${inrShort(s.switchAmount)}</b><div class="small muted">${s.switchPct}% of corpus</div></td></tr>`).join('')}
  </tbody></table></div>
  <p class="small muted">Amounts are based on the expected (glide-path) corpus; actual amounts will differ with markets. In total about ${inrShort(dr.totalEquityOut)} moves out of equity before the goal.</p>` : '<p class="muted small">No switches needed: the allocation is already at its final, low-risk mix.</p>'}
  <details><summary>How to carry out each switch</summary><ul class="small">${dr.execution.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
}

function drawAlloc(id, alloc) {
  const keys = SLEEVE_ORDER.filter((k) => alloc[k]);
  Plotly.newPlot(id, [{ type: 'pie', hole: 0.62, labels: keys, values: keys.map((k) => alloc[k]), sort: false, direction: 'clockwise',
    marker: { colors: keys.map(sleeveColor), line: { color: cssVar('--card'), width: 2 } }, textinfo: 'label+percent', textposition: 'outside',
    textfont: { color: cssVar('--ink-2') }, hovertemplate: '%{label}: %{value}%<extra></extra>' }],
  baseLayout({ margin: { l: 10, r: 10, t: 20, b: 20 }, hovermode: 'closest' }), plotCfg);
}
function drawProjection(id, g) {
  const x = g.projection.map((r) => r.year);
  const mc = g.monteCarlo;
  const money = '₹%{y:,.0f}';
  const traces = [];
  if (mc) {
    const mx = mc.series.map((r) => r.year);
    const band = (lo, hi, color, name) => [
      { x: mx, y: mc.series.map((r) => r[lo]), mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      { x: mx, y: mc.series.map((r) => r[hi]), mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: color, name, hoverinfo: 'skip' },
    ];
    traces.push(...band('p10', 'p90', cssVar('--band-outer'), '10–90th'), ...band('p25', 'p75', cssVar('--band-inner'), '25–75th'));
    traces.push({ x: mx, y: mc.series.map((r) => r.p10), name: 'Pessimistic (10th)', mode: 'lines', line: { width: 0 }, hovertemplate: money, showlegend: false });
    traces.push({ x: mx, y: mc.series.map((r) => r.p50), name: 'Median', mode: 'lines', line: { color: cssVar('--s-largecap'), width: 2.5 }, hovertemplate: money });
    traces.push({ x: mx, y: mc.series.map((r) => r.p90), name: 'Optimistic (90th)', mode: 'lines', line: { width: 0 }, hovertemplate: money, showlegend: false });
  }
  traces.push(
    { x, y: g.projection.map((r) => r.glideCorpus), name: 'Expected', mode: 'lines', line: { color: cssVar('--s-flexicap'), width: 2, dash: 'dot' }, hovertemplate: money },
    { x, y: g.projection.map((r) => r.invested), name: 'Invested', mode: 'lines', line: { color: cssVar('--muted'), width: 1.5 }, hovertemplate: money },
    { x, y: g.projection.map((r) => r.target), name: 'Target', mode: 'lines', line: { color: cssVar('--crit'), width: 1.5, dash: 'dash' }, hovertemplate: money },
  );
  const ys = [...g.projection.flatMap((r) => [r.glideCorpus, r.target]), ...(mc ? mc.series.map((r) => r.p90) : [])];
  const ages = g.projection[0].age != null;
  Plotly.newPlot(id, traces, baseLayout({ xaxis: { title: { text: ages ? 'Years from now (hover shows age)' : 'Years from now' } }, yaxis: moneyAxis(ys), margin: { l: 64, r: 16, t: 10, b: 40 } }), plotCfg);
}
function drawGlide(id, g) {
  const live = g.glide.filter((y, i) => y.yearsLeft > 0 || i === 0);
  // Step chart: the allocation chosen at the start of year y is held until year y+1.
  const x = [...live.map((y) => y.year), g.years];
  const at = (s) => [...live.map((y) => y.weights[s] || 0), live.at(-1).weights[s] || 0];
  const traces = SLEEVE_ORDER.filter((s) => live.some((y) => y.weights[s])).map((s) => ({
    x, y: at(s), name: s, type: 'scatter', mode: 'lines', stackgroup: 'one', line: { width: 0.5, color: cssVar('--card'), shape: 'hv' },
    fillcolor: sleeveColor(s), hovertemplate: `${s} %{y}%<extra></extra>`,
  }));
  traces.push({ x, y: [...live.map((y) => y.equity), live.at(-1).equity], name: 'Equity', mode: 'lines', line: { color: cssVar('--ink'), width: 2, shape: 'hv' }, hovertemplate: 'equity %{y}%<extra></extra>' });
  Plotly.newPlot(id, traces, baseLayout({ xaxis: { title: { text: 'Years from now' }, range: [0, g.years] }, yaxis: { ticksuffix: '%', range: [0, 100] } }), plotCfg);
}

// ---------- Screen 4: Funds ----------
function renderFunds(el) {
  const d = state.view.draft, bt = d.backtest;
  const th = state.meta.rules.THRESHOLDS, w = state.meta.rules.RANK_WEIGHTS;
  el.innerHTML = `
  <div class="screen-head"><div><h2>Fund research</h2><p>Direct-plan growth schemes from the AMFI universe, screened with documented thresholds, ranked within each sleeve, and backtested as a mix over ten years.</p></div></div>
  <div class="card"><h3>Selection criteria</h3>
    <ol class="small" style="margin:0 0 10px;padding-left:18px">
      <li>Keep only <b>direct plan, growth option</b> schemes in the sleeve the allocation needs (plan type from AMFI's NAV file).</li>
      <li>Exclude schemes with missing critical data (TER, AUM, NAV history, tracking error for index funds) or NAV history that does not match AMFI.</li>
      <li>Apply eligibility thresholds below.</li>
      <li>Rank eligible funds by percentile: ${Object.entries(w).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${v * 100}%`).join(', ')} (stewardship = manager tenure, or tracking error for index funds).</li>
      <li>Shortlist the top fund per sleeve with a written reason; keep runners-up for the adviser.</li></ol>
    <div class="table-wrap"><table class="data"><thead><tr><th>Group</th><th class="n">Min history</th><th class="n">Min AUM</th><th class="n">Max TER</th><th class="n">Manager / tracking</th></tr></thead><tbody>
    ${Object.entries(th).map(([k, t]) => `<tr><td>${k}</td><td class="n">${t.minHistoryYears} yrs</td><td class="n">₹${t.minAumCr.toLocaleString('en-IN')} Cr</td><td class="n">${t.maxTer}%</td><td class="n">${t.maxTrackingError != null ? `TE ≤ ${t.maxTrackingError}%` : t.minManagerYears ? `≥ ${t.minManagerYears} yrs` : '—'}</td></tr>`).join('')}
    </tbody></table></div></div>
  ${d.funds.map(sleeveCard).join('')}
  ${bt ? backtestHtml(bt) : ''}
  <div class="card" style="margin-top:16px"><div class="row"><div><h3 style="margin:0">Questions about these funds?</h3><p class="small muted" style="margin:4px 0 0">Exit loads, objectives, holdings, comparisons or SEBI rules – the research assistant answers from official documents with page citations.</p></div><span class="spacer"></span><button class="btn primary" id="toResearch">Open research assistant →</button></div></div>`;
  if (bt) drawBacktest(bt);
  $('#toResearch').addEventListener('click', () => go('research'));
}
function sleeveCard(s) {
  const f = s.selected;
  const rows = s.eligible.map((x) => `<tr ${x.code === f?.code ? 'style="background:var(--teal-soft)"' : ''}><td>${x.rank}</td><td><b>${esc(x.name)}</b><div class="small muted">${esc(x.category)} · AMFI ${x.code}</div></td>
    <td class="n">${x.expenseRatio}%</td><td class="n">${Math.round(x.aumCr).toLocaleString('en-IN')}</td>
    <td class="n">${pct(x.metrics.cagr['1y'])}</td><td class="n">${pct(x.metrics.cagr['3y'])}</td><td class="n">${pct(x.metrics.cagr['5y'])}</td><td class="n">${pct(x.metrics.cagr['10y'])}</td>
    <td class="n">${pct(x.metrics.rolling1yMedian)}</td><td class="n">${pct(x.metrics.maxDrawdown)}</td><td class="n">${pct(x.metrics.volatility)}</td>
    <td class="n">${x.passive ? `TE ${x.trackingError1y}%` : `${(x.managerYears ?? 0).toFixed(1)} yrs`}</td><td class="n">${(x.score * 100).toFixed(0)}</td>
    <td>${x.sources.map((src, i) => `<a href="${src.url}" target="_blank" rel="noopener" title="${esc(src.fields)}">[${i + 1}]</a>`).join(' ')}</td></tr>`).join('');
  return `<div class="section-title"><h3><i class="swatch" style="background:${sleeveColor(s.sleeve)}"></i>${esc(s.label)}</h3><span>${s.weight}% of the starting mix · ${esc(s.steps[0])}</span></div>
  <div class="card">
    ${f ? `<p><b>Shortlisted: ${esc(f.name)}</b>${s.overridden ? ` <span class="pill status">adviser override (system pick: ${esc(s.systemPick)})</span>` : ''}<br><span class="small">${esc(f.explanation ?? '')}</span></p>` : '<p class="flag high">No fund passed screening for this sleeve.</p>'}
    <div class="table-wrap"><table class="data"><thead><tr><th>#</th><th>Scheme (direct, growth)</th><th class="n">TER</th><th class="n">AUM ₹Cr</th><th class="n">1y</th><th class="n">3y</th><th class="n">5y</th><th class="n">10y</th><th class="n">Median roll. 1y</th><th class="n">Max DD</th><th class="n">Vol</th><th class="n">Mgr / TE</th><th class="n">Score</th><th>Sources</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small muted">CAGRs are point-to-point from AMFI NAV history to ${esc(f?.metrics.asOf ?? '')}; rolling, drawdown and volatility use the screening window (${esc(f?.metrics.window ?? '')}). n/a = not enough history (shown honestly, never filled in). Past performance does not guarantee future returns.</p>
    ${s.excluded.length ? `<details><summary>${s.excluded.length} excluded scheme(s)</summary><ul class="small">${s.excluded.map((x) => `<li><b>${esc(x.name)}</b>: ${x.exclusionReasons.map(esc).join('; ')}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}
function backtestHtml(bt) {
  const s = bt.stats;
  const row = (k, label) => `<tr><td>${label}</td><td class="n">${pct(s[k].cumulative)}</td><td class="n">${pct(s[k].cagr, 2)}</td><td class="n">${pct(s[k].volatility)}</td><td class="n">${pct(s[k].maxDrawdown)}</td><td class="n">${pct(s[k].worstYear)}</td><td class="n">${pct(s[k].bestYear)}</td><td class="n">${inrShort(s[k].endValue)}</td></tr>`;
  return `<div class="section-title"><h3>10-year backtest of the recommended mix</h3><span>${bt.period.start} → ${bt.period.end} · ${bt.period.months} months</span></div>
  <div class="grid g4">
    <div class="card"><div class="kpi"><span class="label">CAGR</span><span class="value">${pct(s.portfolio.cagr, 2)}</span><span class="note">Nifty 50: ${pct(s.nifty50.cagr, 2)}</span></div></div>
    <div class="card"><div class="kpi"><span class="label">Cumulative</span><span class="value">${pct(s.portfolio.cumulative, 0)}</span><span class="note">₹1 L → ${inrShort(s.portfolio.endValue)}</span></div></div>
    <div class="card"><div class="kpi"><span class="label">Volatility</span><span class="value">${pct(s.portfolio.volatility)}</span><span class="note">annualised, monthly data</span></div></div>
    <div class="card"><div class="kpi"><span class="label">Max drawdown</span><span class="value">${pct(s.portfolio.maxDrawdown)}</span><span class="note">worst 12-mo: ${pct(s.portfolio.worstYear)}</span></div></div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Portfolio value over time (₹1,00,000 invested)</h3>
    ${legendHtml([['Recommended mix', cssVar('--s-largecap')], [bt.benchmarks.nifty50, cssVar('--s-flexicap')], [bt.benchmarks.reference, cssVar('--s-midcap'), true]])}
    <div id="btChart" class="chart"></div>
    <div class="table-wrap"><table class="data"><thead><tr><th></th><th class="n">Cumulative</th><th class="n">CAGR</th><th class="n">Volatility</th><th class="n">Max DD</th><th class="n">Worst 12m</th><th class="n">Best 12m</th><th class="n">End value</th></tr></thead><tbody>
    ${row('portfolio', 'Recommended mix')}${row('nifty50', 'Nifty 50 index fund')}${row('reference', 'Passive reference')}</tbody></table></div>
    <p class="small"><b>Method:</b> ${esc(bt.method)}</p>
    <details><summary>Data coverage, proxies and limitations</summary>
      <table class="data"><thead><tr><th>Sleeve</th><th>Fund</th><th class="n">Weight</th><th class="n">Own NAV months</th><th class="n">Proxy months</th></tr></thead><tbody>
      ${bt.coverage.map((c) => `<tr><td>${esc(c.sleeve)}</td><td>${esc(c.fund)}</td><td class="n">${pct(bt.weights.find((w) => w.fund === c.fund)?.weight, 0)}</td><td class="n">${c.ownMonths}</td><td class="n">${c.proxyMonths}${c.proxyFund ? ` (${esc(c.proxyFund)})` : ''}</td></tr>`).join('')}</tbody></table>
      <ul class="small">${bt.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>
  </div>`;
}
function drawBacktest(bt) {
  const x = bt.series.map((p) => p.date);
  Plotly.newPlot('btChart', [
    { x, y: bt.series.map((p) => p.portfolio), name: 'Recommended mix', mode: 'lines', line: { color: cssVar('--s-largecap'), width: 2 }, hovertemplate: '₹%{y:,.0f}' },
    { x, y: bt.series.map((p) => p.nifty50), name: 'Nifty 50', mode: 'lines', line: { color: cssVar('--s-flexicap'), width: 2 }, hovertemplate: '₹%{y:,.0f}' },
    { x, y: bt.series.map((p) => p.reference), name: 'Passive reference', mode: 'lines', line: { color: cssVar('--s-midcap'), width: 2, dash: 'dot' }, hovertemplate: '₹%{y:,.0f}' },
  ], baseLayout({ yaxis: moneyAxis(bt.series.flatMap((p) => [p.portfolio, p.nifty50, p.reference])) }), plotCfg);
}
// ---------- Screen 5: Research & documents ----------
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c);
function highlight(text, terms = []) {
  const t = esc(text);
  const words = [...new Set(terms)].filter((w) => w.length > 2).sort((a, b) => b.length - a.length).map(reEsc);
  return words.length ? t.replace(new RegExp(`\\b(${words.join('|')})`, 'gi'), '<mark>$1</mark>') : t;
}
// Minimal, safe markdown for assistant answers: paragraphs, bullets, numbered lists, pipe
// tables, **bold**, `code`, and [S#] citation links. Everything is escaped first.
function mdLite(text, sources = []) {
  const src = Object.fromEntries(sources.map((s) => [s.id, s]));
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(S\d+)\]/g, (m, id) => src[id] ? `<a class="cite-ref" href="${esc(src[id].url)}" ${src[id].url.startsWith('#') ? '' : 'target="_blank" rel="noopener"'} title="${esc(src[id].label)}">${id}</a>` : `<span class="cite-ref dead">${id}</span>`);
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i].trim();
    if (!l) { i++; continue; }
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|?\s*:?-{2,}/.test(r.replace(/\|/g, '|').split('|')[1] ?? ''));
      const [head, ...rest] = body;
      out.push(`<div class="table-wrap"><table class="data"><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\d/.test(l);
      const items = [];
      while (i < lines.length && /^([-*•]|\d+[.)])\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^([-*•]|\d+[.)])\s+/, '')); i++; }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^#{1,4}\s/.test(l)) { out.push(`<p><b>${inline(l.replace(/^#+\s/, ''))}</b></p>`); i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(\||[-*•]\s|\d+[.)]\s|#{1,4}\s)/.test(lines[i].trim())) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('');
}

const TOOL_LABEL = { search_documents: 'Searched documents', get_fund_facts: 'Looked up fund facts', compare_funds: 'Compared funds', list_funds: 'Listed the fund universe', list_documents: 'Listed documents', read_page: 'Read a page', get_client_case: 'Read this client case', plan_goal: 'Planned funds for a goal', search_official_sources: 'Searched official sources', read_official_source: 'Read an official source' };
const stepText = (s) => {
  const i = s.input ?? {};
  const what = i.goal_type ? `${i.goal_name ?? i.goal_type}, ${i.years} yrs` : i.query ?`“${i.query}”${i.fund ? ` in ${i.fund}` : ''}${i.document_id ? ` (${i.document_id})` : ''}` : i.fund ?? (i.funds ? i.funds.join(' vs ') : i.document_id ? `${i.document_id} p.${i.page}` : i.url ?? '');
  return `${TOOL_LABEL[s.tool] ?? s.tool}${what ? `: ${esc(what)}` : ''}${s.ok ? '' : ` <span class="warn-text">(${esc(s.summary)})</span>`}`;
};

function comparisonHtml(rows) {
  const r = (label, f) => `<tr><th>${label}</th>${rows.map((x) => `<td class="n">${f(x)}</td>`).join('')}</tr>`;
  return `<div class="table-wrap"><table class="data compare"><thead><tr><th></th>${rows.map((x) => `<th class="n">${esc(x.name)}</th>`).join('')}</tr></thead><tbody>
    ${r('AMC · category', (x) => `${esc(x.amc)} · ${esc(x.category)}`)}
    ${r('Expense ratio', (x) => `${x.ter}%`)}${r('AUM', (x) => `₹${Math.round(x.aumCr).toLocaleString('en-IN')} Cr`)}
    ${r('1y / 3y CAGR', (x) => `${pct(x.cagr1y)} / ${pct(x.cagr3y)}`)}${r('5y / 10y CAGR', (x) => `${pct(x.cagr5y)} / ${pct(x.cagr10y)}`)}
    ${r('Max drawdown', (x) => pct(x.maxDrawdown))}${r('Volatility', (x) => pct(x.volatility))}
    ${r('Manager / TE', (x) => (x.passive ? `TE ${x.trackingError1y}%` : esc(x.managers.slice(0, 2).join(', '))))}
    ${r('Benchmark', (x) => esc(x.benchmark))}
    ${r('Source', (x) => `<a href="${x.source.url}" target="_blank" rel="noopener">factsheet</a> · <a href="${x.navSource.url}" target="_blank" rel="noopener">NAV</a>`)}
  </tbody></table></div><p class="small muted">Returns computed from AMFI direct-plan NAV history; metrics window ${esc(rows[0]?.window ?? '')}. Past performance does not guarantee future returns.</p>`;
}

function chatHtml(m) {
  let body;
  if (m.type === 'guardrail') body = `<div class="mode">Compliance guardrail</div><p>${esc(m.answer)}</p>`;
  else if (m.type === 'not_found') body = `<div class="mode">Not in documents</div><p>${esc(m.answer)}</p>`;
  else if (m.mode === 'ai-agent') {
    body = `<div class="mode">AI agent · every figure checked against ${m.sources?.length ?? 0} cited source(s)</div>
      <div class="md">${mdLite(m.answer, m.sources)}</div>
      ${m.sources?.length ? `<ol class="sources">${m.sources.map((s) => `<li><span class="sid">${s.id}</span><a href="${esc(s.url)}" ${s.url.startsWith('#') ? '' : 'target="_blank" rel="noopener"'}>${esc(s.label)}</a></li>`).join('')}</ol>` : ''}
      ${m.steps?.length ? `<details class="steps"><summary>How this was researched (${m.steps.length} step${m.steps.length > 1 ? 's' : ''})</summary><ol>${m.steps.map((s) => `<li>${stepText(s)}</li>`).join('')}</ol></details>` : ''}`;
  } else {
    body = `<div class="mode">${m.mode === 'llm-grounded' ? 'AI agent · verified against sources' : 'From official documents'}${m.fundsDetected?.length ? ` · ${esc(m.fundsDetected.join(', '))}` : ''}${m.followUp ? ' · follow-up' : ''}</div>
       ${m.answer ? `<p>${esc(m.answer)}</p>` : ''}
       ${m.comparison ? comparisonHtml(m.comparison) : ''}
       ${(m.facts ?? []).map((f) => `<div class="cite">${esc(f.text)} <a href="${f.source.url}" ${f.source.url.startsWith('#') ? '' : 'target="_blank" rel="noopener"'}>${esc(f.source.label)}</a>${f.computed ? ' <span class="muted">(computed)</span>' : ''}</div>`).join('')}
       ${(m.passages ?? []).slice(0, 3).map((p) => `<div class="cite">“${highlight(p.excerpt, p.terms)}” <a href="${p.url}" target="_blank" rel="noopener">${esc(p.title)}, p.${p.page}</a>${p.localUrl ? ` · <a href="${p.localUrl}" target="_blank" rel="noopener" title="Local copy">local</a>` : ''}</div>`).join('')}`;
  }
  return `<div class="msg q">${esc(m.question)}</div><div class="msg a ${m.type === 'guardrail' ? 'guard' : ''}">${body}${m.note ? `<p class="small muted">${esc(m.note)}</p>` : ''}</div>`;
}

function suggestions(d) {
  const picks = d.funds.filter((f) => f.selected);
  const names = picks.map((f) => f.selected.name);
  const pair = picks.find((f) => f.eligible.length > 1);
  const out = [];
  if (names[0]) out.push(`Why was ${names[0]} chosen for this client?`);
  if (pair) out.push(`Compare ${pair.eligible[0].name} vs ${pair.eligible[1].name}`);
  if (names[0]) out.push(`What is the exit load of ${names[0]}?`);
  const flexi = picks.find((f) => f.sleeve === 'flexicap');
  if (flexi) out.push(`What are the top holdings of ${flexi.selected.name}?`);
  if (d.plan.goals[0]) out.push(`Is the ${d.plan.goals[0].name} goal on track, and what would improve the odds?`);
  out.push('Which investment option has the lowest cost, and what is the trade-off?');
  out.push('Plan funds for ₹25 lakh of education in 12 years with ₹2 lakh saved');
  out.push('What is the definition of large cap, mid cap and small cap as per SEBI?', 'Can you guarantee me 20% returns every year?');
  return out;
}

function docLibraryHtml() {
  const c = state.meta.corpus;
  const docs = c.documents;
  const types = ['all', ...new Set(docs.map((x) => x.type)), ...(docs.some((x) => x.uploaded) ? ['uploaded'] : [])];
  const shown = docs.filter((x) => state.docFilter === 'all' || (state.docFilter === 'uploaded' ? x.uploaded : x.type === state.docFilter));
  const sr = state.docSearch;
  return `<div class="row" style="justify-content:space-between"><h3 style="margin:0">Document library</h3><span class="small muted">${docs.length} documents · ${docs.reduce((s, x) => s + x.pages, 0).toLocaleString('en-IN')} pages · ${c.chunks.toLocaleString('en-IN')} passages indexed</span></div>
    <form id="docSearch" class="row" style="margin:12px 0 6px;flex-wrap:nowrap">
      <input name="q" placeholder="Search inside all documents, e.g. exit load" value="${esc(sr?.q ?? '')}" autocomplete="off">
      <select name="doc" aria-label="Limit to a document" style="max-width:150px"><option value="">All documents</option>${docs.map((x) => `<option value="${x.id}" ${sr?.doc === x.id ? 'selected' : ''}>${esc(x.title.split(' – ')[0])}</option>`).join('')}</select>
      <button class="btn">Search</button></form>
    ${sr ? `<div class="search-results"><div class="row small muted" style="justify-content:space-between"><span>${sr.hits.length} page(s) match “${esc(sr.q)}”</span><button class="btn small ghost" id="clearSearch">Clear</button></div>
      ${sr.hits.map((h) => `<div class="hit"><div class="small"><span class="tag">${esc(h.docType)}</span> <b>${esc(h.title)}</b> · p.${h.page}</div><div class="small">${highlight(h.excerpt, h.terms)}</div>
        <div class="row small" style="gap:12px;margin-top:4px"><button class="linkbtn" data-page="${h.doc}:${h.page}">View page text</button><a href="${h.localUrl}" target="_blank" rel="noopener">Open PDF at page ↗</a></div></div>`).join('') || '<p class="muted small">No passages matched.</p>'}</div>` : ''}
    <div class="chips" style="margin:10px 0">${types.map((t) => `<button type="button" data-doctype="${t}" class="${state.docFilter === t ? 'on' : ''}">${t === 'all' ? 'All' : t === 'uploaded' ? 'Uploaded' : esc(t)}</button>`).join('')}</div>
    <div class="docs">${shown.map((x) => `<div class="doc">
      <div class="row" style="gap:6px"><span class="tag">${esc(x.type)}</span>${x.uploaded ? '<span class="tag up">uploaded</span>' : ''}<span class="small muted">${x.asOf ? `as of ${esc(x.asOf)}` : ''}</span></div>
      <b class="small">${esc(x.title)}</b>
      <div class="small muted">${esc(x.publisher)} · ${x.pages} pages · ${x.chunks} passages</div>
      ${x.funds?.length ? `<div class="small muted">Covers: ${esc(x.funds.slice(0, 3).join(', '))}${x.funds.length > 3 ? ` +${x.funds.length - 3} more` : ''}</div>` : ''}
      <div class="row small" style="gap:12px;margin-top:4px">
        ${x.url && !x.url.startsWith('/docs') ? `<a href="${x.url}" target="_blank" rel="noopener">Official source ↗</a>` : ''}
        ${x.localAvailable ? `<a href="${x.localUrl}" target="_blank" rel="noopener">Local PDF ↗</a>` : ''}
        <button class="linkbtn" data-searchdoc="${x.id}">Search in this</button>
        <button class="linkbtn" data-askdoc="${esc(x.title)}">Ask about it</button>
        ${x.uploaded ? `<button class="linkbtn danger" data-deldoc="${x.id}">Remove</button>` : ''}
      </div></div>`).join('')}</div>
    <details style="margin-top:12px"><summary>+ Upload a document (PDF)</summary>
      <form id="uploadForm" class="fields" style="margin-top:8px">
        <label class="f wide">PDF file<input type="file" name="file" accept="application/pdf,.pdf" required></label>
        <label class="f wide">Title<input name="title" placeholder="e.g. HDFC Mutual Fund – Factsheet, October 2026" required></label>
        <label class="f">Type<select name="type">${state.meta.docTypes.map((t) => `<option>${t}</option>`).join('')}</select></label>
        <label class="f">As of<input type="date" name="asOf"></label>
        <label class="f wide">Official source URL (optional)<input name="url" type="url" placeholder="https://…"></label>
        <div class="row wide"><button class="btn primary">Upload & index</button><span class="hint">Text-based PDFs only; scanned images have no extractable text. The assistant can cite it immediately.</span></div>
      </form></details>
    <p class="small muted" style="margin-top:12px">NAV data: <a href="https://portal.amfiindia.com/spages/NAVAll.txt" target="_blank" rel="noopener">AMFI NAVAll.txt</a> (latest NAV, plan type) and AMFI-code history via <a href="https://api.mfapi.in/" target="_blank" rel="noopener">mfapi.in</a>, cross-checked against AMFI's latest NAV. Inflation: <a href="https://data.rbi.org.in/DBIE/" target="_blank" rel="noopener">RBI DBIE</a>. Regulations: <a href="https://www.sebi.gov.in/" target="_blank" rel="noopener">SEBI</a>.</p>`;
}

function renderResearch(el) {
  const d = state.view.draft, m = state.meta;
  el.innerHTML = `
  <div class="screen-head"><div><h2>Research & documents</h2><p>Ask about funds, this client's plan or SEBI rules. Answers come only from the document library, the co-pilot's own engines and official SEBI-regulated sources, with every claim linked to its source.</p></div></div>
  <div class="research">
    <div class="card">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Research assistant</h3>
        <div class="row"><span class="pill status">AI agent</span>
        ${state.chat.length ? '<button class="btn small ghost" id="clearChat" title="Clear this case\'s research conversation">Clear</button>' : ''}</div></div>
      <p class="sub" style="margin-top:6px">${m.llm ? 'The AI agent plans its own research: it searches the documents, compares funds, reads pages and this case, plans funds for any goal through the co-pilot\'s engines, and checks official SEBI-regulated sources (SEBI, AMFI, RBI, the exchanges and registered AMCs) when the library does not cover a question. Any figure not found in a source is rejected. Follow-up questions remember the conversation.' : 'The AI agent is not set up. Add FREE_AI_API_KEY (or ANTHROPIC_API_KEY) to .env on the server and restart it.'}</p>
      <div class="chat" id="chat">${state.chat.map(chatHtml).join('') || '<p class="muted">Ask about the shortlisted funds, this client\'s goals, or SEBI definitions. Try a suggestion below.</p>'}</div>
      <form id="askForm" class="ask"><textarea name="q" rows="2" placeholder="Ask about a fund, this client's plan, or a regulation…" required></textarea><button class="btn primary">Ask</button></form>
      <p class="hint" style="margin:4px 0 8px">Enter to send · Shift+Enter for a new line</p>
      <div class="chips">${suggestions(d).map((s) => `<button type="button" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>
    <div class="card" id="library">${docLibraryHtml()}</div>
  </div>`;
  const chat = $('#chat'); chat.scrollTop = chat.scrollHeight;
  const form = $('#askForm');
  form.addEventListener('submit', (e) => { e.preventDefault(); const q = form.q.value; form.reset(); ask(q); });
  form.q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  $$('.chips [data-q]', el).forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
  $('#clearChat')?.addEventListener('click', async () => {
    if (!confirm('Clear the research conversation for this case? (The audit log keeps a record.)')) return;
    await api(`/api/cases/${state.view.id}/research`, { method: 'DELETE' }); state.chat = []; renderResearch(el);
  });
  bindLibrary(el);
}

function bindLibrary(el) {
  const rerender = () => { $('#library').innerHTML = docLibraryHtml(); bindLibrary(el); };
  $('#docSearch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim(), doc = e.target.doc.value;
    if (q.length < 2) return toast('Enter at least 2 characters', true);
    try { const r = await api(`/api/docs/search?q=${encodeURIComponent(q)}${doc ? `&doc=${encodeURIComponent(doc)}` : ''}`); state.docSearch = { ...r, doc }; rerender(); } catch (err) { toast(err.message, true); }
  });
  $('#clearSearch')?.addEventListener('click', () => { state.docSearch = null; rerender(); });
  $$('[data-doctype]').forEach((b) => b.addEventListener('click', () => { state.docFilter = b.dataset.doctype; rerender(); }));
  $$('[data-searchdoc]').forEach((b) => b.addEventListener('click', () => { const f = $('#docSearch'); f.doc.value = b.dataset.searchdoc; f.q.focus(); }));
  $$('[data-askdoc]').forEach((b) => b.addEventListener('click', () => { const t = $('#askForm textarea'); t.value = `From “${b.dataset.askdoc}”: `; t.focus(); }));
  $$('[data-page]').forEach((b) => b.addEventListener('click', () => showPage(...b.dataset.page.split(':'))));
  $$('[data-deldoc]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this uploaded document from the library and the search index?')) return;
    try { await api(`/api/docs/${encodeURIComponent(b.dataset.deldoc)}`, { method: 'DELETE' }); state.meta.corpus = await api('/api/docs'); state.docSearch = null; rerender(); toast('Document removed'); } catch (err) { toast(err.message, true); }
  }));
  $('#uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, file = f.file.files[0];
    if (!file) return;
    const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Extracting text…';
    const qs = new URLSearchParams({ title: f.title.value.trim(), type: f.type.value, asOf: f.asOf.value, url: f.url.value.trim() });
    try {
      const r = await fetch(`/api/docs?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      state.meta.corpus = await api('/api/docs');
      toast(`Indexed “${j.title}” (${j.pages} pages)`);
      rerender();
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Upload & index'; }
  });
}

async function showPage(doc, page) {
  try {
    const p = await api(`/api/docs/${encodeURIComponent(doc)}/pages/${page}`);
    let dlg = $('#pageDialog');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'pageDialog'; document.body.append(dlg); }
    dlg.innerHTML = `<div class="row" style="justify-content:space-between"><b>${esc(p.title)} · page ${p.page}</b><button class="btn small" id="closeDlg" aria-label="Close">✕</button></div>
      <pre class="pagetext">${highlight(p.text, state.docSearch?.hits?.[0]?.terms ?? [])}</pre>
      <a href="${p.url}" target="_blank" rel="noopener">Open the PDF at this page ↗</a>`;
    $('#closeDlg', dlg).addEventListener('click', () => dlg.close());
    dlg.showModal();
  } catch (e) { toast(e.message, true); }
}

async function ask(q) {
  if (!q?.trim()) return;
  const chat = $('#chat');
  chat.insertAdjacentHTML('beforeend', `<div class="msg q">${esc(q)}</div><div class="msg a muted pending">Researching: searching documents and official sources…</div>`);
  chat.scrollTop = chat.scrollHeight;
  $$('#askForm button, #askForm textarea').forEach((x) => { x.disabled = true; });
  try {
    const a = await api('/api/research', { method: 'POST', body: { question: q, caseId: state.view.id } });
    state.chat.push({ question: q, ...a });
  } catch (e) { toast(e.message, true); }
  if (state.screen === 'research') renderResearch($('#app'));
}

// ---------- Screen 6: Review ----------
// Decisions are signed by the signed-in account (set on the server). The adviser can add their SEBI
// registration number, kept on this device; older versions kept it inside a free-text signature.
const sebiReg = () => pref.get('sebiReg') ?? (pref.get('adviserName') ?? '').toUpperCase().match(/IN[A-Z]\d{9}/)?.[0] ?? '';
function renderReview(el) {
  const v = state.view, d = v.draft;
  const pending = d.status === 'PENDING_REVIEW';
  const high = d.guardrails.flags.filter((f) => f.severity === 'high');
  const lastApprove = v.reviews.find((r) => r.action === 'approve' && r.draft_id === d.id);
  el.innerHTML = `
  <div class="screen-head"><div><h2>Adviser review · draft v${d.version}</h2><p>Nothing reaches the client until you approve. High-severity flags need a written justification; every decision and change is recorded.</p></div>
    <div class="row"><span class="pill ${d.status}">${d.status.replace(/_/g, ' ')}</span>${lastApprove ? `<span class="stamp">Approved · ${esc(lastApprove.adviser)}</span>` : ''}</div></div>
  <div class="card" style="margin-bottom:16px">${pipelineHtml()}</div>
  <div class="grid g2">
    <div class="card"><h3>Draft recommendation</h3><ul>${d.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <div class="table-wrap"><table class="data"><thead><tr><th>Goal</th><th class="n">Future cost</th><th class="n">SIP</th><th>Starting mix</th></tr></thead><tbody>
      ${d.plan.goals.map((g) => `<tr><td>${esc(g.name)}<div class="small muted">${g.years} yrs</div></td><td class="n">${inrShort(g.futureCost)}</td><td class="n">${inr(g.recommendedSip)}</td><td class="small">${Object.entries(g.currentAllocation.weights).map(([k, w]) => `${k} ${w}%`).join(', ')}</td></tr>`).join('')}
      <tr><td><b>Total</b></td><td></td><td class="n"><b>${inr(d.plan.totalSip)}</b></td><td></td></tr></tbody></table></div>
      ${d.plan.investRange ? `<p class="small" style="margin-top:10px"><b>Recommended investment:</b> ${d.plan.investRange.monthly.high > 0 ? `${rangeFull(d.plan.investRange.monthly)} a month` : 'no monthly SIP'}${d.plan.investRange.lumpSum.high > 0 ? ` · lump sum ${rangeFull(d.plan.investRange.lumpSum)}` : ''}${d.plan.investRange.withdrawals ? ` · SWP ${inr(d.plan.investRange.withdrawals.monthly)}/month from savings` : ''}</p>` : ''}
      <h3 style="margin-top:14px">Funds</h3><ul class="small">${d.funds.map((f) => `<li>${esc(f.label)} (${f.weight}%): <b>${esc(f.selected?.name ?? 'none')}</b>${f.overridden ? ' · adviser override' : ''}</li>`).join('')}</ul>
    </div>
    <div class="card"><h3>Warnings & guardrails</h3><p class="sub">${high.length} high · ${d.guardrails.flags.filter((f) => f.severity === 'medium').length} medium · ${d.guardrails.flags.filter((f) => f.severity === 'low').length} low</p>
      <div id="flagList">${flagsHtml(d.guardrails.flags, pending, state.justify ?? {})}</div></div>
  </div>

  <div class="card" style="margin-top:16px"><h3>Decision</h3>
    <div class="fields">
      <label class="f">SEBI registration no. (optional)<input id="sebiReg" value="${esc(sebiReg())}" placeholder="e.g. INA000012345" autocomplete="off" spellcheck="false"><span class="small muted">Signed as ${esc(state.me?.name ?? '')}, the account you are signed in with.</span></label>
      <label class="f wide">Decision note / reason<textarea id="reviewNote" placeholder="Required for reject or request changes"></textarea></label>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn good" data-act="approve" ${pending ? '' : 'disabled'}>✓ Approve</button>
      <button class="btn bad" data-act="reject" ${pending ? '' : 'disabled'}>✕ Reject</button>
      <button class="btn" data-act="request_changes" ${pending ? '' : 'disabled'}>↺ Request changes</button>
      <span class="spacer"></span>
      <a class="btn ${d.status === 'APPROVED' ? 'primary' : ''}" ${d.shareToken ? `href="/client/${d.shareToken}" target="_blank" rel="noopener"` : 'aria-disabled="true" title="The client link is created when you approve this draft"'}>${d.status === 'APPROVED' ? 'Open client-facing report ↗' : 'Client report (locked until approved)'}</a>
    </div>
    ${pending ? '' : `<p class="small muted">Draft v${d.version} is ${d.status.replace(/_/g, ' ').toLowerCase()}. Use “Edit and resubmit” below to create a new version.</p>`}
  </div>

  <div class="card" style="margin-top:16px"><h3>Edit and resubmit</h3><p class="sub">Change fund picks or add your commentary; profile inputs are edited on screen 1. Each resubmission creates a new draft version with a record of what changed.</p>
    <div class="fields">${d.funds.map((f) => `<label class="f">${esc(f.label)}<select data-override="${f.sleeve}">
      ${f.eligible.map((x) => `<option value="${x.code}" ${x.code === f.selected?.code ? 'selected' : ''}>${esc(x.name)} (rank ${x.rank})</option>`).join('')}
      ${f.excluded.map((x) => `<option value="${x.code}" ${x.code === f.selected?.code ? 'selected' : ''}>⚠ ${esc(x.name)} (failed screening)</option>`).join('')}</select></label>`).join('')}
      <label class="f wide">Adviser commentary for the client<textarea id="adviserNotes">${esc(d.adviserNotes ?? '')}</textarea></label></div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="resubmit">Edit and resubmit</button><button class="btn" id="editProfile">Edit client profile</button></div>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Supporting calculations</h3>${d.plan.goals.map((g) => `<p style="margin:8px 0 2px"><b>${esc(g.name)}</b></p>${Object.values(g.workings).map((w) => `<div class="formula">${esc(w)}</div>`).join('')}`).join('')}
      <p class="small">Risk: capacity ${d.risk.capacity.score}/${d.risk.capacity.max ?? 100} (${d.risk.capacity.level}), tolerance ${d.risk.tolerance.score}/15 (${d.risk.tolerance.level}) → ${d.risk.final.level}.</p>
      ${d.backtest ? `<p class="small">Backtest ${d.backtest.period.start} → ${d.backtest.period.end}: CAGR ${pct(d.backtest.stats.portfolio.cagr, 2)}, max drawdown ${pct(d.backtest.stats.portfolio.maxDrawdown)}.</p>` : ''}</div>
    <div class="card"><h3>Research sources</h3>
      <ul class="small">${d.funds.flatMap((f) => (f.selected ? f.selected.sources.slice(0, 1).map((s) => `<li>${esc(f.selected.name)}: <a href="${s.url}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`) : [])).join('')}</ul>
      ${state.chat.length ? `<p class="small"><b>Research questions on this case:</b></p><ul class="small">${state.chat.map((c) => `<li>${esc(c.question)} – ${[...(c.sources || []), ...(c.facts || []).map((f) => f.source), ...(c.passages || []).slice(0, 2).map((p) => ({ url: p.url, label: `${p.title}, p.${p.page}` }))].slice(0, 3).map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join('; ') || esc(c.type)}</li>`).join('')}</ul>` : ''}
      <h3 style="margin-top:12px">Disclosures</h3><ul class="small">${[...d.disclosures.conflicts, d.disclosures.returns, ...d.disclosures.general].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
  </div>

  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h3>Versions & decisions</h3><ul class="timeline">
      ${v.history.map((h) => `<li><b>v${h.version}</b> · ${h.status.replace(/_/g, ' ').toLowerCase()} · ${new Date(h.created_at).toLocaleString()} · by ${esc(h.created_by)}
        ${h.change_summary?.length ? `<div class="small muted">${h.change_summary.slice(0, 8).map((c) => `${esc(c.field)}: ${esc(JSON.stringify(c.from))} → ${esc(JSON.stringify(c.to))}`).join('<br>')}</div>` : ''}
        ${v.reviews.filter((r) => r.draft_id === h.id).map((r) => `<div class="small">↳ ${esc(r.action.replace('_', ' '))} by ${esc(r.adviser)}${r.note ? `: “${esc(r.note)}”` : ''}${Object.keys(r.justifications).length && r.action === 'approve' ? `<br>${Object.entries(r.justifications).filter(([, t]) => t).map(([k, t]) => `${k}: ${esc(t)}`).join('<br>')}` : ''}</div>`).join('')}</li>`).join('')}
    </ul></div>
    <div class="card"><h3>Audit log</h3><ul class="timeline">${v.audit.slice(0, 25).map((a) => `<li><b>${esc(a.event.replace(/_/g, ' ').toLowerCase())}</b> <span class="muted small">${new Date(a.created_at).toLocaleString()}</span></li>`).join('')}</ul></div>
  </div>`;

  $$('[data-justify]', el).forEach((t) => t.addEventListener('input', () => { state.justify = { ...(state.justify ?? {}), [t.dataset.justify]: t.value }; }));
  $('#sebiReg').addEventListener('change', (e) => { e.target.value = e.target.value.trim().toUpperCase(); pref.set('sebiReg', e.target.value); });
  $$('[data-act]', el).forEach((b) => b.addEventListener('click', () => review(b.dataset.act)));
  $('#resubmit').addEventListener('click', resubmit);
  $('#editProfile').addEventListener('click', () => { state.keepCase = true; navigate(`#/onboard/${v.id}`); });
}
async function review(action) {
  const registration = $('#sebiReg').value.trim().toUpperCase();
  const justifications = Object.fromEntries($$('[data-justify]').map((t) => [t.dataset.justify, t.value]));
  try {
    state.view = await api(`/api/cases/${state.view.id}/review`, { method: 'POST', body: { action, registration, note: $('#reviewNote').value, justifications } });
    state.justify = {};
    await refreshCases();
    toast({ approve: 'Approved – client report released', reject: 'Draft rejected', request_changes: 'Changes requested' }[action]);
    renderReview($('#app'));
  } catch (e) {
    toast(e.message, true);
    for (const id of e.data?.missing ?? []) $(`[data-justify="${id}"]`)?.style.setProperty('outline', `2px solid ${cssVar('--crit')}`);
  }
}
async function resubmit() {
  const overrides = Object.fromEntries($$('[data-override]').map((s) => [s.dataset.override, +s.value]));
  try {
    state.view = await api(`/api/cases/${state.view.id}`, { method: 'PUT', body: { overrides, adviserNotes: $('#adviserNotes').value } });
    await refreshCases();
    toast(`Resubmitted as draft v${state.view.draft.version}`);
    renderReview($('#app'));
  } catch (e) { toast(e.message, true); }
}

// ---------- Boot ----------
// 'light' | 'dark' | null (follow the system); chosen in Settings.
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
applyTheme(pref.get('theme'));
$('#casePicker').addEventListener('change', (e) => { if (e.target.value) navigate(`#/review/${e.target.value}`); });
$('#newCase').addEventListener('click', () => { state.view = null; state.formDraft = null; state.chat = []; navigate('#/onboard'); route(); });
window.addEventListener('hashchange', () => {
  const backFromOnboarding = state.screen === 'onboard' && !appNav;
  appNav = false;
  if (backFromOnboarding) return location.replace('/');
  route();
});

// ---------- Settings: appearance, approvals, start screen, workspace status, sign out ----------
const initialsOf = (name = '') => name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || name.slice(0, 1).toUpperCase();
const segHtml = (name, current, options) => `<div class="seg" role="group" aria-label="${esc(name)}">${options.map(([v, label]) => `<button type="button" data-${name}="${v}" aria-pressed="${current === v}">${label}</button>`).join('')}</div>`;

function openSettings() {
  let dlg = $('#settingsDialog');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'settingsDialog'; dlg.setAttribute('aria-labelledby', 'settingsTitle'); document.body.append(dlg); }
  const me = state.me, m = state.meta ?? {};
  const docs = m.corpus?.documents ?? [];
  const theme = pref.get('theme') ?? 'system';
  const start = pref.get('startScreen') ?? 'onboard';
  dlg.innerHTML = `
    <div class="settings-head">
      <div class="settings-who"><span class="avatar" aria-hidden="true">${esc(initialsOf(me.name))}</span><div><b id="settingsTitle">${esc(me.name)}</b><span>${esc(me.email)}</span></div></div>
      <button class="btn small" data-close aria-label="Close settings">✕</button>
    </div>
    <div class="settings-body">
      <section class="set">
        <div><h4>Theme</h4><p class="hint">How the co-pilot looks on this device.</p></div>
        ${segHtml('theme', theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])}
      </section>
      <section class="set col">
        <div><h4>SEBI registration number</h4><p class="hint">Approvals are signed as ${esc(me.name)}. This number is shown next to your name on approvals and client reports.</p></div>
        <input id="setSignature" value="${esc(sebiReg())}" placeholder="e.g. INA000012345" autocomplete="off" spellcheck="false">
      </section>
      <section class="set">
        <div><h4>Start screen</h4><p class="hint">What the co-pilot opens when you come back.</p></div>
        ${segHtml('start', start, [['onboard', 'New client'], ['last', 'Last case']])}
      </section>
      <section class="set col">
        <h4>Workspace</h4>
        <dl class="status">
          <dt>AI research assistant</dt><dd>${m.llm ? '<span class="dot on"></span>On' : '<span class="dot"></span>Off · add a key to .env'}</dd>
          <dt>Document library</dt><dd>${docs.length} documents · ${docs.reduce((s, x) => s + (x.pages || 0), 0).toLocaleString('en-IN')} pages</dd>
          <dt>Client cases</dt><dd>${state.cases.length}</dd>
        </dl>
      </section>
      <div class="settings-foot"><span class="hint">Signed in as ${esc(me.email)}</span><button class="btn danger-btn" id="signOut">Sign out</button></div>
    </div>`;

  dlg.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.theme;
    pref.set('theme', v === 'system' ? null : v);
    applyTheme(v === 'system' ? null : v);
    dlg.querySelectorAll('[data-theme]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render(); // charts pick up the new colours
  }));
  dlg.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => {
    pref.set('startScreen', b.dataset.start === 'onboard' ? null : b.dataset.start);
    dlg.querySelectorAll('[data-start]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('#setSignature', dlg).addEventListener('change', (e) => {
    const reg = e.target.value.trim().toUpperCase();
    if (reg && !/^IN[A-Z]\d{9}$/.test(reg)) return toast('SEBI registration number should look like INA000012345.', true);
    e.target.value = reg;
    pref.set('sebiReg', reg);
    const field = $('#sebiReg'); // the review screen, if open
    if (field) field.value = reg;
    toast('SEBI registration number saved');
  });
  $('[data-close]', dlg).addEventListener('click', () => dlg.close());
  $('#signOut', dlg).addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    // Fintel's chat can mention this adviser's clients; the next person on this browser must not see it.
    try { sessionStorage.removeItem('fintel-chat'); } catch {}
    location.replace('/');
  });
  dlg.showModal();
}
function renderAccount() {
  const b = $('#settingsBtn');
  b.title = `Settings · signed in as ${state.me.name}`;
  b.setAttribute('aria-label', b.title);
}
$('#settingsBtn').addEventListener('click', openSettings);

state.me = (await api('/api/auth/me')).adviser;
if (!state.me) { toSignIn(); await new Promise(() => {}); } // stop here while the sign-in page loads
renderAccount();
state.meta = await api('/api/meta');
await refreshCases();
// Start screen "Last case": a plain visit to the co-pilot reopens the case worked on last.
// replaceState changes the address without a hashchange, so no extra history entry.
const lastCase = +pref.get('lastCase');
if (pref.get('startScreen') === 'last' && ['', '#/onboard'].includes(location.hash) && state.cases.some((c) => c.id === lastCase)) {
  history.replaceState(null, '', `#/review/${lastCase}`);
}
await route();
