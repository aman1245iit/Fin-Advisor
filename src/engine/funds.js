// Fund data loading, NAV-based metrics and the screening engine.
import fs from 'node:fs';
import path from 'node:path';
import { UNIVERSE, SLEEVES } from './universe.js';
import { docById, DATA_SOURCES } from './sources.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'data', 'fund-meta.json'), 'utf8'));
const navCheck = JSON.parse(fs.readFileSync(path.join(root, 'data', 'nav-check.json'), 'utf8'));
const navCache = new Map();

export function navSeries(code) {
  if (!navCache.has(code)) {
    const f = path.join(root, 'data', 'nav', `${code}.json`);
    navCache.set(code, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).series : null);
  }
  return navCache.get(code);
}

const DAY = 86400000;
const t = (iso) => Date.parse(iso + 'T00:00:00Z');
const yearsBetween = (a, b) => (t(b) - t(a)) / (365.25 * DAY);

// Last NAV on or before `iso`; null if the nearest observation is more than `maxStaleDays` old.
export function navAt(series, iso, maxStaleDays = 10) {
  let lo = 0, hi = series.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= iso) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best < 0) return null;
  return (t(iso) - t(series[best][0])) / DAY <= maxStaleDays ? series[best][1] : null;
}

export function monthEnds(endIso, months) {
  const end = new Date(t(endIso));
  const out = [];
  for (let k = months; k >= 1; k--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - k + 1, 0));
    out.push(d.toISOString().slice(0, 10));
  }
  out.push(endIso);
  return out;
}

const quantile = (arr, q) => { const s = [...arr].sort((a, b) => a - b); if (!s.length) return null; const p = (s.length - 1) * q; const lo = Math.floor(p); return s[lo] + (s[Math.ceil(p)] - s[lo]) * (p - lo); };
const std = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

export function maxDrawdown(values) {
  let peak = -Infinity, mdd = 0;
  for (const v of values) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  return mdd;
}

// Metrics over a trailing window of `years` (monthly sampling), plus point-to-point CAGRs.
export function fundMetrics(code, windowYears = 5) {
  const s = navSeries(code);
  if (!s?.length) return null;
  const last = s.at(-1)[0];
  const cagr = {};
  for (const y of [1, 3, 5, 10]) {
    const startIso = new Date(t(last) - y * 365.25 * DAY).toISOString().slice(0, 10);
    const v0 = navAt(s, startIso);
    cagr[`${y}y`] = v0 && s[0][0] <= startIso ? Math.pow(s.at(-1)[1] / v0, 1 / y) - 1 : null;
  }
  const historyYears = yearsBetween(s[0][0], last);
  const months = Math.min(Math.floor(historyYears * 12), windowYears * 12);
  const dates = monthEnds(last, months);
  const vals = dates.map((d) => navAt(s, d));
  const monthly = [];
  for (let i = 1; i < vals.length; i++) if (vals[i] && vals[i - 1]) monthly.push(vals[i] / vals[i - 1] - 1);
  const rolling1y = [];
  for (let i = 12; i < vals.length; i++) if (vals[i] && vals[i - 12]) rolling1y.push(vals[i] / vals[i - 12] - 1);
  // Drawdown on daily data within the window.
  const winStart = dates[0];
  const daily = s.filter(([d]) => d >= winStart).map(([, v]) => v);
  return {
    asOf: last, firstNav: s[0][0], historyYears,
    window: `${(months / 12).toFixed(1)}y to ${last}`,
    cagr,
    volatility: monthly.length > 6 ? std(monthly) * Math.sqrt(12) : null,
    maxDrawdown: daily.length ? maxDrawdown(daily) : null,
    maxDrawdownFull: maxDrawdown(s.map(([, v]) => v)),
    rolling1yMedian: quantile(rolling1y, 0.5),
    rolling1yP10: quantile(rolling1y, 0.1),
    rolling1yPositive: rolling1y.length ? rolling1y.filter((x) => x > 0).length / rolling1y.length : null,
  };
}

// ---------- Screening ----------
// Documented eligibility thresholds per sleeve (passive funds use tracking error instead of manager tenure).
export const THRESHOLDS = {
  equity: { minHistoryYears: 5, minAumCr: 1000, maxTer: 1.0, minManagerYears: 2 },
  equityPassive: { minHistoryYears: 5, minAumCr: 500, maxTer: 0.5, maxTrackingError: 0.5 },
  hybrid: { minHistoryYears: 5, minAumCr: 1000, maxTer: 1.0, minManagerYears: 2 },
  debt: { minHistoryYears: 5, minAumCr: 1000, maxTer: 0.6, minManagerYears: 1 },
  liquid: { minHistoryYears: 3, minAumCr: 1000, maxTer: 0.4, minManagerYears: 0 },
  gold: { minHistoryYears: 5, minAumCr: 500, maxTer: 0.5, minManagerYears: 0 },
};
// Ranking weights inside a sleeve (percentile ranks among eligible funds).
export const RANK_WEIGHTS = { rolling1yMedian: 0.30, maxDrawdown: 0.20, ter: 0.20, volatility: 0.10, aum: 0.10, stewardship: 0.10 };
export const SCREEN_WINDOW_YEARS = { liquid: 3 };

function thresholdsFor(f) {
  const asset = SLEEVES[f.sleeve].asset;
  if (asset === 'equity') return f.passive ? THRESHOLDS.equityPassive : THRESHOLDS.equity;
  if (f.sleeve === 'liquid') return THRESHOLDS.liquid;
  return THRESHOLDS[asset] ?? THRESHOLDS.debt;
}

export function fundRecord(f) {
  const m = meta[f.code] ?? {};
  const doc = docById(m.source?.doc ?? f.doc);
  const check = navCheck.report.find((r) => r.code === f.code);
  const metrics = fundMetrics(f.code, SCREEN_WINDOW_YEARS[f.sleeve] ?? 5);
  const managerYears = m.managerSince && metrics ? yearsBetween(m.managerSince, metrics.asOf) : null;
  return {
    ...f,
    sleeveLabel: SLEEVES[f.sleeve].label,
    plan: check?.amfiPlan ?? null, option: check?.amfiOption ?? null,
    latestNav: check?.amfiNav ?? null, navDate: check?.amfiDate ?? null, navMatchesAmfi: check?.matchesAmfi ?? null,
    expenseRatio: m.expenseRatio ?? null, aumCr: m.aumCr ?? null,
    managers: m.managers ?? [], managerSince: m.managerSince ?? null, managerYears,
    trackingError1y: m.trackingError1y ?? null, trackingError3y: m.trackingError3y ?? null,
    metrics,
    sources: [
      { label: `${doc?.title} – p.${m.source?.page ?? f.page}`, url: `${doc?.url}#page=${m.source?.page ?? f.page}`, fields: 'TER, AUM, fund managers, tracking error, benchmark' },
      { label: DATA_SOURCES.amfiNav.title, url: DATA_SOURCES.amfiNav.url, fields: `Scheme code ${f.code}, plan type, latest NAV` },
      { label: DATA_SOURCES.navHistory.title, url: DATA_SOURCES.navHistory.url + f.code, fields: 'Historical NAV (cross-checked with AMFI latest NAV)' },
    ],
  };
}

export const allFunds = () => UNIVERSE.map(fundRecord);

export function screenSleeve(sleeve) {
  const funds = allFunds().filter((f) => f.sleeve === sleeve);
  const steps = [];
  const eligible = [], excluded = [];
  for (const f of funds) {
    const th = thresholdsFor(f);
    const why = [];
    // 1. Category & plan constraints
    if (!/direct/i.test(f.plan ?? '')) why.push('Not a direct plan in AMFI data');
    if (!/growth/i.test(f.option ?? '')) why.push('Not a growth option');
    // 2. Missing / unreliable critical data
    if (f.expenseRatio == null) why.push('Expense ratio missing');
    if (f.aumCr == null) why.push('AUM missing');
    if (!f.metrics) why.push('No NAV history');
    if (f.navMatchesAmfi === false) why.push('Historical NAV does not match AMFI latest NAV');
    if (f.passive && f.trackingError1y == null) why.push('Tracking error missing');
    // 3. Eligibility thresholds
    if (f.metrics && f.metrics.historyYears < th.minHistoryYears) why.push(`Only ${f.metrics.historyYears.toFixed(2)} years of direct-plan history (needs ${th.minHistoryYears})`);
    if (f.aumCr != null && f.aumCr < th.minAumCr) why.push(`AUM ₹${f.aumCr.toLocaleString('en-IN')} Cr below ₹${th.minAumCr} Cr`);
    if (f.expenseRatio != null && f.expenseRatio > th.maxTer) why.push(`TER ${f.expenseRatio}% above ${th.maxTer}%`);
    if (th.maxTrackingError != null && f.trackingError1y != null && f.trackingError1y > th.maxTrackingError) why.push(`Tracking error ${f.trackingError1y}% above ${th.maxTrackingError}%`);
    if (!f.passive && th.minManagerYears && (f.managerYears ?? 0) < th.minManagerYears) why.push(`Lead manager tenure ${(f.managerYears ?? 0).toFixed(1)}y below ${th.minManagerYears}y`);
    (why.length ? excluded : eligible).push({ ...f, thresholds: th, exclusionReasons: why });
  }
  steps.push(`${funds.length} schemes in the ${SLEEVES[sleeve].label} sleeve → ${eligible.length} pass plan, data and threshold checks`);

  // 4. Compare eligible funds with percentile ranks.
  const rank = (key, higherIsBetter, get = (f) => f[key]) => {
    const vals = eligible.map(get);
    return eligible.map((f, idx) => {
      const v = vals[idx];
      if (v == null || eligible.length === 1) return 1;
      const better = vals.filter((x) => x != null && (higherIsBetter ? x < v : x > v)).length;
      return better / (vals.filter((x) => x != null).length - 1 || 1);
    });
  };
  const comps = {
    rolling1yMedian: rank(null, true, (f) => f.metrics.rolling1yMedian),
    maxDrawdown: rank(null, true, (f) => f.metrics.maxDrawdown),
    ter: rank(null, false, (f) => f.expenseRatio),
    volatility: rank(null, false, (f) => f.metrics.volatility),
    aum: rank(null, true, (f) => Math.log(f.aumCr)),
    stewardship: rank(null, true, (f) => (f.passive ? 10 - (f.trackingError1y ?? 1) * 10 : Math.min(f.managerYears ?? 0, 10))),
  };
  eligible.forEach((f, i) => {
    f.scoreParts = Object.fromEntries(Object.keys(RANK_WEIGHTS).map((k) => [k, comps[k][i]]));
    f.score = Object.entries(RANK_WEIGHTS).reduce((s, [k, w]) => s + w * comps[k][i], 0);
  });
  eligible.sort((a, b) => b.score - a.score);
  eligible.forEach((f, i) => { f.rank = i + 1; f.explanation = explain(f, eligible); });
  return { sleeve, label: SLEEVES[sleeve].label, eligible, excluded, steps, selected: eligible[0] ?? null };
}

function explain(f, peers) {
  const m = f.metrics;
  const bits = [];
  const best = (k) => f.scoreParts[k] === 1 && peers.length > 1;
  bits.push(`${f.category}, direct growth, TER ${f.expenseRatio}%${best('ter') ? ' (lowest in sleeve)' : ''}`);
  bits.push(`median rolling 1-year return ${pc(m.rolling1yMedian)} over ${m.window}${best('rolling1yMedian') ? ' (highest)' : ''}`);
  bits.push(`max drawdown ${pc(m.maxDrawdown)}${best('maxDrawdown') ? ' (shallowest)' : ''}`);
  bits.push(f.passive ? `tracking error ${f.trackingError1y}% (1y)` : `lead manager since ${f.managerSince?.slice(0, 7)} (${(f.managerYears ?? 0).toFixed(1)}y)`);
  bits.push(`AUM ₹${Math.round(f.aumCr).toLocaleString('en-IN')} Cr`);
  return `Rank ${f.rank} of ${peers.length} (score ${(f.score * 100).toFixed(0)}/100): ` + bits.join('; ') + '.';
}
const pc = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');

export function shortlist(allocation) {
  const sleeves = Object.keys(SLEEVES).filter((k) => allocation[k] > 0); // fixed equity → debt → gold order
  return sleeves.map((s) => ({ ...screenSleeve(s), weight: allocation[s] }));
}
