// Suitability guardrails. Every flag has a severity:
//   high   → blocks approval until the adviser records a written justification for that flag
//   medium → shown prominently in the review
//   low    → informational
// No output reaches the client until an adviser approves the draft (enforced server-side).

import { WITHDRAWAL_RATE, WITHDRAWAL_BUCKET_YEARS } from './planner.js';

const GUARANTEE_PATTERNS = [
  /guarantee/i, /assured\s+return/i, /fixed\s+return/i, /sure[\s-]?shot/i, /risk[\s-]?free\s+(return|profit)/i,
  /no\s+risk/i, /double\s+(my|the)\s+money/i, /(\d{2,3})\s*%\s*(return|returns)?\s*(every|each|per|a)\s*(year|annum|month)/i,
];

export const GUARANTEE_RESPONSE =
  'Mutual fund returns are market-linked and cannot be guaranteed. Neither the co-pilot nor the adviser can promise a fixed or minimum ' +
  'return such as 20% every year. Return figures used in planning are assumptions for calculation only; actual returns may be higher, ' +
  'lower or negative, and past performance does not indicate future results. (SEBI-registered investment advisers may not assure returns.)';

export function detectGuaranteeRequest(text = '') {
  return GUARANTEE_PATTERNS.some((re) => re.test(text));
}

export const SPECIAL_REQUESTS = {
  none: 'No special product request',
  smallcap_only: 'Small-cap funds only',
  all_equity: '100% equity',
  sectoral: 'Sector / thematic fund concentration',
  guaranteed: 'Wants guaranteed / fixed returns',
};

export function runGuardrails({ client, risk, plan, funds }) {
  const flags = [...risk.conflicts.map((c) => ({ ...c, source: 'Risk profile' }))];
  const add = (severity, code, message, source = 'Suitability') => flags.push({ severity, code, message, source });
  const age = +client.age;
  const fin = risk.financials;
  const longest = Math.max(0, ...(client.goals || []).map((g) => +g.years || 0));

  // Special product requests evaluated against the full picture.
  const req = client.specialRequest || 'none';
  if (req === 'smallcap_only' || req === 'all_equity' || req === 'sectoral') {
    const reasons = [];
    if (age >= 60) reasons.push(`age ${age} (limited time to recover from a deep fall)`);
    if (longest < 7) reasons.push(`longest goal is ${longest} years away (equity, especially small caps, needs 7+ years)`);
    if (risk.capacity.level !== 'High') reasons.push(`risk capacity is ${risk.capacity.level}`);
    if (risk.tolerance.level !== 'Aggressive') reasons.push(`risk tolerance is ${risk.tolerance.level}`);
    if (fin.emergencyMonths < 6) reasons.push(`emergency savings cover ${fin.emergencyMonths.toFixed(1)} months`);
    if ((client.goals || []).some((g) => ['medical', 'emergency'].includes(g.type))) reasons.push('the money is earmarked for medical/emergency needs that need liquidity');
    const what = SPECIAL_REQUESTS[req];
    if (reasons.length) {
      add('high', 'UNSUITABLE_PRODUCT_REQUEST', `Client asked for "${what}". This is not suitable because: ${reasons.join('; ')}. The co-pilot has NOT followed this request; the plan uses the suitability-based allocation. The adviser must document the discussion before approving.`);
    } else {
      add('medium', 'CONCENTRATED_REQUEST', `Client asked for "${what}". Profile can bear high risk, but concentration increases drawdowns (e.g. the small-cap sleeve's worst historical fall). The co-pilot still uses the diversified allocation; adviser to confirm.`);
    }
  }
  if (req === 'guaranteed' || detectGuaranteeRequest(client.notes)) {
    add('high', 'RETURN_GUARANTEE_REQUESTED', GUARANTEE_RESPONSE, 'Communication');
  }

  // Return assumptions.
  for (const g of plan.goals) {
    if (g.assumedReturn > 0.15) add('high', 'UNREALISTIC_RETURN_ASSUMPTION', `"${g.name}" assumes ${(g.assumedReturn * 100).toFixed(1)}% a year. Above 15% is not a reasonable planning assumption; lower it or justify it.`, 'Planning');
    else if (g.assumedReturn > 0.12) add('medium', 'HIGH_RETURN_ASSUMPTION', `"${g.name}" assumes ${(g.assumedReturn * 100).toFixed(1)}% a year, above the 12% prudence limit. Results may be optimistic.`, 'Planning');
    if (g.assumedReturn > g.currentAllocation.expectedReturn + 0.02) add('medium', 'RETURN_ABOVE_ALLOCATION', `"${g.name}" assumes ${(g.assumedReturn * 100).toFixed(1)}% but its suggested allocation implies about ${(g.currentAllocation.expectedReturn * 100).toFixed(1)}%. Use the glide-path SIP (${inr(g.sipGlide)}), not the flat-rate SIP.`, 'Planning');
    if (g.inflation < 0.04) add('medium', 'LOW_INFLATION_ASSUMPTION', `"${g.name}" uses ${(g.inflation * 100).toFixed(1)}% inflation, below RBI's 4% CPI target. Costs may be underestimated.`, 'Planning');
  }

  // Affordability & liquidity.
  const range = plan.investRange;
  const w = range?.withdrawals;
  if (fin.surplus <= 0 && fin.nonEarning && w && w.corpus > 0) {
    // Retired / non-earning: living costs come out of savings, so test how fast they are drawn down.
    const ratePct = `${(w.rate * 100).toFixed(1)}%`;
    const msg = `Income leaves ${inr(w.monthly)} a month of expenses uncovered, i.e. ${inr(w.annual)} a year drawn from ${inr(w.corpus)} of investable savings (${ratePct} a year; savings last about ${Number.isFinite(w.yearsCovered) ? w.yearsCovered.toFixed(0) : 'many'} years before growth).`;
    if (w.rate > WITHDRAWAL_RATE.high) add('high', 'WITHDRAWAL_RATE_HIGH', `${msg} Above ${WITHDRAWAL_RATE.high * 100}% a year the savings may run out: cut expenses, add income (e.g. annuity, rent) or keep more in safer assets.`, 'Cash flow');
    else if (w.rate > WITHDRAWAL_RATE.caution) add('medium', 'WITHDRAWAL_RATE_ELEVATED', `${msg} Above ${WITHDRAWAL_RATE.caution * 100}% a year needs a yearly review of withdrawals.`, 'Cash flow');
    else add('low', 'SWP_FROM_SAVINGS', `${msg} This is a sustainable rate; set up a monthly SWP from the liquid bucket.`, 'Cash flow');
    if (plan.totalSip > 0) {
      const short = range.lumpSum.needed > w.forGoals;
      add(short ? 'high' : 'medium', 'GOALS_FROM_SAVINGS', `There is no monthly surplus for SIPs. The goals need about ${inr(range.lumpSum.needed)} invested today instead; ${inr(w.forGoals)} of investable savings remains after keeping ${WITHDRAWAL_BUCKET_YEARS} years of withdrawals aside.${short ? ' Goals need to be re-prioritised, extended or reduced.' : ' Earmark that amount as savings for the goals (goal table), which removes the SIP.'}`, 'Cash flow');
    }
  } else if (fin.surplus <= 0) add('high', 'NO_SURPLUS', `Monthly expenses and EMIs (${inr(fin.outgo)}) use all income (${inr(fin.income)})${fin.nonEarning ? ' and there are no savings to draw on' : ''}. No investment plan is affordable until cash flow is fixed.`, 'Cash flow');
  else if (plan.totalSip > fin.surplus) add('high', 'SIP_EXCEEDS_SURPLUS', `Required SIPs total ${inr(plan.totalSip)} a month but the monthly surplus is only ${inr(fin.surplus)}. Goals need to be re-prioritised, extended or reduced.`, 'Cash flow');
  else if (range && plan.totalSip > range.monthly.affordHigh) add('medium', 'SIP_ABOVE_COMFORT', `Required SIPs (${inr(plan.totalSip)}) are more than ${Math.round(range.monthly.share[1] * 100)}% of the monthly surplus (${inr(range.monthly.affordHigh)}), leaving little buffer for irregular spending.`, 'Cash flow');
  const target = fin.emergencyTargetMonths ?? 6;
  if (fin.emergencyMonths < target) {
    const topUp = range?.lumpSum.emergencyTopUp ? ` ${inr(range.lumpSum.emergencyTopUp)} of the uninvested savings is set aside for it.` : '';
    const covered = range && range.lumpSum.emergencyTopUp > 0 && range.lumpSum.emergencyShort <= 0;
    add(covered ? 'low' : fin.emergencyMonths < 3 ? 'high' : 'medium', 'EMERGENCY_FUND_SHORT', `Emergency savings cover ${fin.emergencyMonths.toFixed(1)} months of outgo; ${target} months (${inr(fin.outgo * target)}) is recommended in a liquid fund before long-term investing.${topUp}`, 'Liquidity');
  }
  if (fin.emiRatio > 0.4) add('high', 'HIGH_DEBT_BURDEN', `EMIs are ${(fin.emiRatio * 100).toFixed(0)}% of income. Consider debt reduction before adding market risk.`, 'Liabilities');
  const allocatedSavings = (client.goals || []).reduce((s, g) => s + (+g.existingSavings || 0), 0);
  const investable = (+client.existingInvestments || 0) + fin.savingsToInvest;
  if (allocatedSavings > investable + 1) add('medium', 'SAVINGS_OVER_ALLOCATED', `Savings earmarked to goals (${inr(allocatedSavings)}) exceed existing investments plus savings available to invest (${inr(investable)}).`, 'Planning');
  if ((+client.dependants || 0) > 0 && client.hasLifeCover === 'no') add('medium', 'NO_LIFE_COVER', `Client has ${client.dependants} dependant(s) but no term life cover. Protection should come before investment.`, 'Protection');
  if (client.hasHealthCover === 'no') add('medium', 'NO_HEALTH_COVER', 'No health insurance recorded. Medical costs could force early redemption of investments.', 'Protection');

  // Fund-level checks.
  for (const s of funds) {
    if (!s.selected) add('high', 'NO_ELIGIBLE_FUND', `No fund in the ${s.label} sleeve passed the screening thresholds. The adviser must pick a fund manually or change the allocation.`, 'Fund research');
  }
  const amcWeights = {};
  for (const s of funds) if (s.selected) amcWeights[s.selected.amc] = (amcWeights[s.selected.amc] || 0) + s.weight;
  const total = Object.values(amcWeights).reduce((a, b) => a + b, 0) || 1;
  for (const [amc, w] of Object.entries(amcWeights)) if (w / total > 0.6) add('low', 'AMC_CONCENTRATION', `${Math.round((w / total) * 100)}% of the portfolio is with ${amc}. The prototype's fund universe covers only 2 AMCs; widen it before final selection.`, 'Fund research');

  const order = { high: 0, medium: 1, low: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);
  flags.forEach((f, i) => { f.id = `F${i + 1}`; });
  return {
    flags,
    blocking: flags.filter((f) => f.severity === 'high').map((f) => f.id),
    status: flags.some((f) => f.severity === 'high') ? 'REVIEW_REQUIRED' : 'READY_FOR_REVIEW',
  };
}

export function conflictDisclosure(client) {
  return [
    'The adviser is a SEBI-registered Investment Adviser paid by the client on a fee-only basis; no commission is received from any AMC.',
    'Only direct plans are recommended, which carry no distributor commission.',
    'The prototype fund universe is limited to schemes from two AMCs (Nippon India and PPFAS) because their official documents were available; this is a data limitation, not a preference or tie-up.',
    client.adviserConflicts ? `Adviser-declared: ${client.adviserConflicts}` : 'The adviser has declared no personal holdings or relationships with the recommended AMCs.',
  ];
}

const inr = (x) => '₹' + Math.round(x).toLocaleString('en-IN');
