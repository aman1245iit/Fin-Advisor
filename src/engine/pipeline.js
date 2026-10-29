// End-to-end pipeline: client profile → risk → plan → funds → backtest → guardrails → draft.
// All figures come from the deterministic engines; nothing here is produced by a language model.
import { assessRisk } from './risk.js';
import { buildPlan } from './planner.js';
import { shortlist, fundRecord, screenSleeve } from './funds.js';
import { backtest } from './backtest.js';
import { runGuardrails, conflictDisclosure, GUARANTEE_RESPONSE } from './guardrails.js';
import { UNIVERSE, SLEEVES } from './universe.js';

export function applyOverrides(sl, overrides = {}) {
  const extraFlags = [];
  for (const s of sl) {
    const code = overrides[s.sleeve];
    if (!code || code === s.selected?.code) continue;
    const pick = s.eligible.find((f) => f.code === +code) ?? s.excluded.find((f) => f.code === +code);
    if (!pick) continue;
    s.systemPick = s.selected?.name ?? null;
    s.selected = pick;
    s.overridden = true;
    if (pick.exclusionReasons?.length) extraFlags.push({ severity: 'high', code: 'OVERRIDE_TO_EXCLUDED_FUND', source: 'Adviser edit', message: `Adviser replaced the screened pick in ${s.label} with ${pick.name}, which failed screening: ${pick.exclusionReasons.join('; ')}.` });
    else extraFlags.push({ severity: 'low', code: 'ADVISER_FUND_OVERRIDE', source: 'Adviser edit', message: `Adviser chose ${pick.name} instead of ${s.systemPick} in ${s.label} (both passed screening).` });
  }
  return extraFlags;
}

function goalInstructions(goal, sl) {
  const pick = Object.fromEntries(sl.map((s) => [s.sleeve, s.selected]));
  const lines = Object.entries(goal.currentAllocation.weights).map(([sleeve, w]) => ({
    sleeve, sleeveLabel: SLEEVES[sleeve].label, weight: w,
    fund: pick[sleeve]?.name ?? '— no eligible fund —', code: pick[sleeve]?.code ?? null,
    monthly: (goal.recommendedSip * w) / 100,
    lumpSum: ((+goal.existingSavings || 0) * w) / 100,
  }));
  // Describe each change in equity along the glide path.
  const shifts = [];
  for (let i = 1; i < goal.glide.length; i++) {
    const a = goal.glide[i - 1], b = goal.glide[i];
    if (b.equity !== a.equity || (b.weights.liquid || 0) !== (a.weights.liquid || 0)) {
      shifts.push({ year: b.year, age: b.age, yearsLeft: b.yearsLeft, from: a.equity, to: b.equity, text: `Year ${b.year}${b.age ? ` (age ${b.age})` : ''}, ${b.yearsLeft.toFixed(0)} yrs left: equity ${a.equity}% → ${b.equity}%, liquid ${a.weights.liquid || 0}% → ${b.weights.liquid || 0}%. ${b.rules.slice(1).join('; ')}` });
    }
  }
  return { lines, shifts };
}

// ---------- Multiple "where to invest" options ----------
// Every option uses only funds that passed screening, and keeps the suitability-based
// allocation. They differ in fund choice (and, for "Simple", in how many funds are held).
const EQUITY = ['largecap', 'flexicap', 'midcap', 'smallcap'];
const weightedTer = (lines) => lines.reduce((s, l) => s + (l.weight / 100) * (l.fund?.expenseRatio ?? 0), 0);

function optionPicks(sl, kind) {
  const picks = {};
  for (const s of sl) {
    const el = s.eligible;
    if (!el.length) { picks[s.sleeve] = s.selected ?? null; continue; }
    if (kind === 'recommended') picks[s.sleeve] = s.selected;
    else if (kind === 'passive') picks[s.sleeve] = el.find((f) => f.passive) ?? [...el].sort((a, b) => a.expenseRatio - b.expenseRatio)[0];
    else if (kind === 'alternative') {
      // Runner-up, preferring a different AMC from the recommended pick to spread AMC risk.
      const rest = el.filter((f) => f.code !== s.selected?.code);
      picks[s.sleeve] = rest.find((f) => f.amc !== s.selected?.amc) ?? rest[0] ?? s.selected;
    }
  }
  return picks;
}

export function buildInvestOptions(sl, plan) {
  const bySleeve = Object.fromEntries(sl.map((s) => [s.sleeve, s]));
  const defs = [
    { id: 'recommended', title: 'Recommended', blurb: 'Top-ranked fund in each sleeve after screening (or the adviser\'s override).', picks: optionPicks(sl, 'recommended'), applicable: true },
    { id: 'passive', title: 'Low-cost index', blurb: 'Index funds wherever an eligible one exists, otherwise the lowest-TER eligible fund. Lowest cost and no fund-manager risk.', picks: optionPicks(sl, 'passive'), applicable: true },
    { id: 'alternative', title: 'Alternative picks', blurb: 'Runner-up fund in each sleeve, preferring a different AMC. Useful to diversify AMC risk or as a second opinion.', picks: optionPicks(sl, 'alternative'), applicable: true },
  ];
  // Simple: all equity in one flexi-cap fund (fewer folios), debt/liquid/gold unchanged.
  const flexi = bySleeve.flexicap?.selected ?? (bySleeve.flexicap ? null : screenFlexi());
  if (flexi) {
    const picks = { ...optionPicks(sl, 'recommended') };
    for (const k of EQUITY) if (picks[k] !== undefined) picks[k] = flexi;
    defs.push({ id: 'simple', title: 'Simple (fewer funds)', blurb: `All equity in one flexi-cap fund (${flexi.name}), which can hold large, mid and small caps; fewest folios to track.`, picks, applicable: false });
  }

  const options = defs.map((d) => {
    const combined = sl.map((s) => ({ sleeve: s.sleeve, label: s.label, weight: s.weight, fund: d.picks[s.sleeve] }));
    const funds = [...new Map(combined.filter((c) => c.fund).map((c) => [c.fund.code, c.fund])).values()];
    const btInput = sl.filter((s) => d.picks[s.sleeve]).map((s) => {
      const pick = d.picks[s.sleeve];
      const home = sl.find((x) => x.sleeve === pick.sleeve) ?? screenSleeve(pick.sleeve);
      return { sleeve: s.sleeve, label: s.label, weight: s.weight, selected: pick, eligible: home.eligible.length ? home.eligible : [pick] };
    });
    let history = null;
    try {
      const bt = btInput.length ? backtest(btInput) : null;
      if (bt) history = { cagr: bt.stats.portfolio.cagr, maxDrawdown: bt.stats.portfolio.maxDrawdown, volatility: bt.stats.portfolio.volatility, worstYear: bt.stats.portfolio.worstYear, proxied: bt.coverage.some((c) => c.proxyMonths > 0), period: bt.period };
    } catch { history = null; }
    const goals = plan.goals.map((g) => ({
      name: g.name,
      lines: Object.entries(g.currentAllocation.weights).map(([sleeve, w]) => {
        const f = d.picks[sleeve];
        return { sleeve, sleeveLabel: SLEEVES[sleeve].label, weight: w, fund: f?.name ?? '— no eligible fund —', code: f?.code ?? null, amc: f?.amc ?? null, ter: f?.expenseRatio ?? null, passive: !!f?.passive, monthly: (g.recommendedSip * w) / 100, lumpSum: ((+g.existingSavings || 0) * w) / 100 };
      }),
    }));
    return {
      id: d.id, title: d.title, blurb: d.blurb, applicable: d.applicable,
      overrides: d.applicable ? Object.fromEntries(Object.entries(d.picks).filter(([, f]) => f).map(([k, f]) => [k, f.code])) : null,
      sleeves: combined.map((c) => ({ sleeve: c.sleeve, label: c.label, weight: c.weight, fund: c.fund?.name ?? null, code: c.fund?.code ?? null, amc: c.fund?.amc ?? null, ter: c.fund?.expenseRatio ?? null, passive: !!c.fund?.passive })),
      fundCount: funds.length,
      amcs: [...new Set(funds.map((f) => f.amc))],
      ter: weightedTer(combined),
      passiveShare: combined.filter((c) => c.fund?.passive).reduce((s, c) => s + c.weight, 0),
      history,
      goals,
    };
  });
  // Drop options identical to an earlier one, but say so.
  const seen = new Map();
  return options.map((o) => {
    const key = o.sleeves.map((s) => `${s.sleeve}:${s.code}`).join('|');
    if (seen.has(key)) return { ...o, sameAs: seen.get(key) };
    seen.set(key, o.title);
    return o;
  });
}
function screenFlexi() { return screenSleeve('flexicap').selected; }

const inr = (x) => '₹' + Math.round(x).toLocaleString('en-IN');
export function investRangeText(r) {
  const parts = [];
  const span = ({ low, high }) => (low > 0 && low !== high ? `${inr(low)}–${inr(high)}` : low > 0 ? inr(high) : `up to ${inr(high)}`);
  parts.push(r.monthly.high > 0 ? `${span(r.monthly)} a month` : 'no monthly SIP');
  if (r.lumpSum.high > 0) parts.push(`${span(r.lumpSum)} as a lump sum`);
  if (r.withdrawals) parts.push(`monthly withdrawal (SWP) of ${inr(r.withdrawals.monthly)} from savings`);
  return parts.join(', plus ');
}

export function runPipeline(client, { overrides = {}, adviserNotes = '' } = {}) {
  const risk = assessRisk(client);
  const plan = buildPlan(client, risk);
  const sl = shortlist(plan.combinedAllocation);
  const overrideFlags = applyOverrides(sl, overrides);
  const bt = sl.length ? backtest(sl) : null;
  const guard = runGuardrails({ client, risk, plan, funds: sl });
  if (overrideFlags.length) {
    guard.flags.push(...overrideFlags.map((f, i) => ({ ...f, id: `F${guard.flags.length + i + 1}` })));
    guard.blocking = guard.flags.filter((f) => f.severity === 'high').map((f) => f.id);
    if (guard.blocking.length) guard.status = 'REVIEW_REQUIRED';
  }
  const goals = plan.goals.map((g) => ({ ...g, instructions: goalInstructions(g, sl) }));
  const investOptions = sl.length ? buildInvestOptions(sl, plan) : [];

  const summary = [
    `Risk capacity ${risk.capacity.level} (${risk.capacity.score}/100) and risk tolerance ${risk.tolerance.level} (${risk.tolerance.score}/15) → proposed profile ${risk.final.level}.`,
    ...risk.reasons,
    `${goals.length} goal(s) need a combined SIP of ${inr(plan.totalSip)} a month against a monthly surplus of ${inr(plan.surplus)}.`,
    `How much to invest: ${investRangeText(plan.investRange)}.`,
    `Suggested starting mix: ${Object.entries(plan.combinedAllocation).map(([k, v]) => `${SLEEVES[k].label} ${v}%`).join(', ')}.`,
    bt && `10-year backtest of this mix (${bt.period.start} to ${bt.period.end}): CAGR ${(bt.stats.portfolio.cagr * 100).toFixed(1)}%, worst fall ${(bt.stats.portfolio.maxDrawdown * 100).toFixed(1)}% – historical, not a forecast.`,
    `${guard.flags.filter((f) => f.severity === 'high').length} high-severity flag(s) need adviser justification before approval.`,
  ].filter(Boolean);

  return {
    generatedAt: new Date().toISOString(),
    client, risk,
    plan: { ...plan, goals },
    funds: sl.map((s) => ({
      sleeve: s.sleeve, label: s.label, weight: s.weight, steps: s.steps, overridden: !!s.overridden, systemPick: s.systemPick ?? null,
      selected: s.selected, eligible: s.eligible, excluded: s.excluded,
    })),
    backtest: bt,
    investOptions,
    guardrails: guard,
    disclosures: {
      conflicts: conflictDisclosure(client),
      returns: GUARANTEE_RESPONSE,
      general: [
        'Mutual fund investments are subject to market risks; read all scheme-related documents carefully.',
        'Projections use assumed inflation and return rates; they are calculations, not predictions.',
        'This draft was prepared by an AI co-pilot from rule-based engines and official documents, and is not advice until approved by the adviser.',
      ],
    },
    summary,
    adviserNotes,
    overrides,
  };
}

export const fundOptions = () => UNIVERSE.map((u) => ({ code: u.code, name: u.name, sleeve: u.sleeve }));
export { fundRecord };
