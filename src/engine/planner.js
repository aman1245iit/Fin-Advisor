// Goal-based planning: inflation-adjusted corpus, SIP, rule-based allocation and glide path.
//
// Conventions (stated explicitly because they change the answer slightly):
//  • Future cost:      FV = C × (1 + i)^n
//  • Monthly rate:     EFFECTIVE annual convention, r = (1 + R)^(1/12) − 1, so 12 compounded
//                      months reproduce exactly the assumed annual return R.
//                      (The nominal convention r = R/12 is also reported for comparison.)
//  • SIP:              P = FV_gap × r / ((1 + r)^N − 1), contributions at the END of each month.
//  • Existing savings: grow at the goal's assumed return and are subtracted from the target.

export const ASSET_ASSUMPTIONS = {
  // Illustrative long-run, post-cost return assumptions used ONLY for glide-path projections.
  // They are planning inputs, not forecasts or guarantees.
  largecap: 0.10, flexicap: 0.105, midcap: 0.115, smallcap: 0.12, hybrid: 0.09, debt: 0.0675, liquid: 0.06, gold: 0.07,
};
// Illustrative annualised volatilities used for the Monte Carlo projection (planning inputs only).
export const ASSET_VOLATILITY = { largecap: 0.16, flexicap: 0.17, midcap: 0.21, smallcap: 0.25, hybrid: 0.10, debt: 0.03, liquid: 0.005, gold: 0.14 };
export const EQUITY_STRESS_FALL = 0.40; // assumed one-year equity fall used to size equity against loss tolerance

export const GOAL_TYPES = {
  retirement: { label: 'Retirement', essential: false, liquidityFloor: 0, inflation: 0.06 },
  education: { label: 'Education', essential: true, liquidityFloor: 0, inflation: 0.08 },
  medical: { label: 'Medical / health reserve', essential: true, liquidityFloor: 20, inflation: 0.08 },
  house: { label: 'House purchase', essential: false, liquidityFloor: 0, inflation: 0.06 },
  emergency: { label: 'Emergency fund', essential: true, liquidityFloor: 100, inflation: 0.06 },
  wealth: { label: 'Wealth creation', essential: false, liquidityFloor: 0, inflation: 0.06 },
  other: { label: 'Other', essential: false, liquidityFloor: 0, inflation: 0.06 },
};

const BASE_EQUITY = [35, 60, 80]; // Conservative, Moderate, Aggressive – maximum equity for a 10y+ goal
const EQUITY_SPLIT = [
  { largecap: 70, flexicap: 30 },
  { largecap: 50, flexicap: 30, midcap: 20 },
  { largecap: 40, flexicap: 25, midcap: 20, smallcap: 15 },
];
export const EQUITY_KEYS = ['largecap', 'flexicap', 'midcap', 'smallcap'];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const yrs = (y) => `${+y.toFixed(1)} year${y === 1 ? '' : 's'}`;

// Glide factor: the share of a goal's long-term equity it may still hold. 100% at 10+ years,
// falling linearly to 0% at 3 years, so EVERY profile starts de-risking 10 years out and moves a
// little each year (no cliff-edge jumps such as 20% → 0% in one year).
export const GLIDE_START = 10, GLIDE_END = 3;
export const glideFactor = (years) => clamp01((years - GLIDE_END) / (GLIDE_START - GLIDE_END));
export function horizonEquityCap(years) { return Math.round(glideFactor(years) * 100); }
// Share of the non-equity money held in liquid / money-market funds: 0 at 5+ years, rising
// linearly to 100% at 2 years, so debt moves to liquid gradually rather than in one go.
export const liquidShare = (years) => clamp01((5 - years) / 3);
// Gold tapers from its full weight at 5+ years to zero at 2 years.
const goldTaper = (years) => clamp01((years - 2) / 3);

// Rule-based allocation for one goal at a given number of years remaining.
export function allocate({ riskIndex, yearsLeft, goalType = 'other', maxLossPct = 20 }) {
  const gt = GOAL_TYPES[goalType] ?? GOAL_TYPES.other;
  const rules = [];
  let equity = BASE_EQUITY[riskIndex];
  rules.push(`Risk level ${['Conservative', 'Moderate', 'Aggressive'][riskIndex]} → up to ${equity}% equity`);
  const lossCap = Math.floor(maxLossPct / EQUITY_STRESS_FALL);
  if (lossCap < equity) { equity = lossCap; rules.push(`Max acceptable fall ${maxLossPct}% ÷ ${EQUITY_STRESS_FALL * 100}% stress fall → ${lossCap}% equity`); }
  if (gt.essential && equity > 0) { equity = Math.max(0, equity - 10); rules.push(`${gt.label} is an essential goal → equity −10 pts`); }
  const f = glideFactor(yearsLeft);
  if (f < 1 && equity > 0) {
    const long = equity;
    equity = Math.round(long * f);
    rules.push(f === 0 ? `${yrs(yearsLeft)} left → no equity inside ${GLIDE_END} years` : `${yrs(yearsLeft)} left → glide keeps ${Math.round(f * 100)}% of the long-term ${long}% equity = ${equity}% (de-risking runs from ${GLIDE_START} years down to ${GLIDE_END})`);
  }

  const taper = goldTaper(yearsLeft);
  let gold = Math.round((riskIndex === 0 ? 5 : 10) * taper);
  if (gt.liquidityFloor >= 100) { equity = 0; gold = 0; }
  if (gold && taper < 1) rules.push(`Gold tapers out as the goal nears → ${gold}%`);
  const nonEq = 100 - equity - gold;
  const share = liquidShare(yearsLeft);
  let liquid = Math.round(nonEq * share);
  liquid = Math.min(nonEq, Math.max(liquid, gt.liquidityFloor));
  if (gt.liquidityFloor) rules.push(`${gt.label} needs liquidity → at least ${gt.liquidityFloor}% liquid`);
  if (share >= 1) rules.push('Goal within 2 years → all non-equity money in liquid / money-market funds');
  else if (share > 0) rules.push(`${yrs(yearsLeft)} left → ${Math.round(share * 100)}% of the debt portion moved to liquid / money-market funds`);
  const debt = nonEq - liquid;

  // Split equity across market-cap sleeves; avoid mid/small caps for goals under 7 years.
  const split = { ...EQUITY_SPLIT[riskIndex] };
  if (yearsLeft < 7 && (split.midcap || split.smallcap)) {
    split.largecap = (split.largecap || 0) + (split.midcap || 0) + (split.smallcap || 0);
    delete split.midcap; delete split.smallcap;
    if (equity > 0) rules.push('Under 7 years → mid and small caps folded into large caps');
  }
  const weights = {};
  for (const [k, v] of Object.entries(split)) weights[k] = (equity * v) / 100;
  Object.assign(weights, { debt, liquid, gold });
  const rounded = roundTo100(weights);
  const expectedReturn = Object.entries(rounded).reduce((s, [k, w]) => s + (w / 100) * ASSET_ASSUMPTIONS[k], 0);
  return { weights: rounded, equity: sumOf(rounded, EQUITY_KEYS), expectedReturn, volatility: portfolioVolatility(rounded), rules };
}

// Simple correlation structure between asset groups (illustrative).
const assetGroup = (k) => (EQUITY_KEYS.includes(k) || k === 'hybrid' ? 'equity' : k === 'gold' ? 'gold' : 'debt');
const CORRELATION = { 'equity:equity': 0.85, 'debt:debt': 0.5, 'debt:equity': 0.05, 'equity:gold': 0, 'debt:gold': 0.1, 'gold:gold': 1 };
const corr = (a, b) => (a === b ? 1 : CORRELATION[[assetGroup(a), assetGroup(b)].sort().join(':')] ?? 0);
export function portfolioVolatility(weights) {
  const ks = Object.keys(weights);
  let v = 0;
  for (const a of ks) for (const b of ks) v += (weights[a] / 100) * (weights[b] / 100) * ASSET_VOLATILITY[a] * ASSET_VOLATILITY[b] * corr(a, b);
  return Math.sqrt(v);
}

export function sumOf(w, keys) { return keys.reduce((s, k) => s + (w[k] || 0), 0); }
function roundTo100(w) {
  const entries = Object.entries(w).filter(([, v]) => v > 0.0001);
  const floors = entries.map(([k, v]) => [k, Math.floor(v), v - Math.floor(v)]);
  let short = 100 - floors.reduce((s, [, f]) => s + f, 0);
  floors.sort((a, b) => b[2] - a[2]);
  const out = {};
  for (const [k, f] of floors) { out[k] = f + (short > 0 ? 1 : 0); short--; }
  return out;
}

export const monthlyRateEffective = (R) => Math.pow(1 + R, 1 / 12) - 1;
export const monthlyRateNominal = (R) => R / 12;
export const sipFor = (fv, r, N) => (fv <= 0 ? 0 : r === 0 ? fv / N : (fv * r) / (Math.pow(1 + r, N) - 1));

export function planGoal(goal, { riskIndex, maxLossPct, startAge }) {
  const C = +goal.currentCost, n = +goal.years, i = +goal.inflation, R = +goal.assumedReturn, S = +goal.existingSavings || 0;
  const N = Math.max(1, Math.round(n * 12));
  const futureCost = C * Math.pow(1 + i, n);
  const savingsFV = S * Math.pow(1 + R, n);
  const gap = Math.max(0, futureCost - savingsFV);
  const r = monthlyRateEffective(R);
  const sip = sipFor(gap, r, N);
  const sipNominal = sipFor(gap, monthlyRateNominal(R), N);

  // Glide path: re-run the allocation rules at the start of each year (years remaining then).
  const glide = [];
  for (let y = 0; y <= Math.ceil(n); y++) {
    const left = Math.max(0, n - y);
    const a = allocate({ riskIndex, yearsLeft: left, goalType: goal.type, maxLossPct });
    glide.push({ year: y, yearsLeft: left, age: startAge ? startAge + y : null, ...a });
  }

  // Glide-path-consistent SIP: returns change each year with the allocation.
  let growthOfSavings = S, annuity = 0;
  for (let m = 0; m < N; m++) {
    const rm = monthlyRateEffective(glide[Math.floor(m / 12)].expectedReturn);
    growthOfSavings *= 1 + rm;
    annuity = annuity * (1 + rm) + 1;
  }
  const sipGlide = Math.max(0, (futureCost - growthOfSavings) / annuity);
  const recommendedSip = Math.max(sip, sipGlide);

  // Year-by-year deterministic projection at the RECOMMENDED SIP. The glide line follows each
  // year's allocation return; the flat line uses the goal's own assumed return.
  const projection = [];
  let flat = S, gp = S, invested = S;
  projection.push({ year: 0, age: startAge ?? null, invested, flatCorpus: flat, glideCorpus: gp, target: futureCost });
  for (let m = 1; m <= N; m++) {
    const rm = monthlyRateEffective(glide[Math.floor((m - 1) / 12)].expectedReturn);
    flat = flat * (1 + r) + recommendedSip;
    gp = gp * (1 + rm) + recommendedSip;
    invested += recommendedSip;
    if (m % 12 === 0 || m === N) projection.push({ year: +(m / 12).toFixed(2), age: startAge ? +(startAge + m / 12).toFixed(1) : null, invested, flatCorpus: flat, glideCorpus: gp, target: futureCost });
  }

  const monteCarlo = simulateGoal({ S, N, glide, sip: recommendedSip, target: futureCost });
  const derisk = deriskSchedule(glide, projection, recommendedSip);

  return {
    ...goal,
    typeLabel: (GOAL_TYPES[goal.type] ?? GOAL_TYPES.other).label,
    futureCost, savingsFV, gap, months: N,
    monthlyRate: r,
    sip, sipNominal, sipGlide,
    recommendedSip,
    currentAllocation: glide[0],
    glide, projection, monteCarlo, derisk,
    workings: {
      futureCost: `FV = ${fmt(C)} × (1 + ${pct(i)})^${n} = ${fmt(futureCost)}`,
      savings: `Existing ${fmt(S)} × (1 + ${pct(R)})^${n} = ${fmt(savingsFV)}`,
      gap: `Gap = ${fmt(futureCost)} − ${fmt(savingsFV)} = ${fmt(gap)}`,
      rate: `r = (1 + ${pct(R)})^(1/12) − 1 = ${(r * 100).toFixed(4)}% per month (effective). Nominal R/12 would be ${(R / 12 * 100).toFixed(4)}%.`,
      sip: `P = ${fmt(gap)} × r ÷ ((1 + r)^${N} − 1) = ${fmt(sip)} per month (nominal convention: ${fmt(sipNominal)})`,
      glide: `With the glide path's expected return falling from ${pct(glide[0].expectedReturn)} as the goal nears, the SIP needed is ${fmt(sipGlide)} per month.`,
      recommended: `Recommended SIP = max(flat ${fmt(sip)}, glide ${fmt(sipGlide)}) = ${fmt(recommendedSip)} per month.`,
      monteCarlo: `Monte Carlo (${monteCarlo.paths} paths): ${(monteCarlo.successProb * 100).toFixed(0)}% chance of reaching ${fmt(futureCost)} at ${fmt(recommendedSip)}/month; ${fmt(monteCarlo.sipFor[80])}/month gives 80% confidence.`,
    },
  };
}

// ---------- Monte Carlo projection ----------
// Monthly log-normal returns per glide-path year: σ from that year's allocation volatility and a
// drift chosen so the mean annual return equals the allocation's expected return. A fixed seed
// keeps drafts reproducible. For a given path the corpus is linear in the SIP
// (corpus = A + SIP × B), so the SIP needed for any confidence level is read off directly.
export const MC_PATHS = 2000;
const MC_SEED = 20261028;
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const quantile = (sorted, q) => { if (!sorted.length) return null; const p = (sorted.length - 1) * q, lo = Math.floor(p); return sorted[lo] + (sorted[Math.ceil(p)] - sorted[lo]) * (p - lo); };

export function simulateGoal({ S, N, glide, sip, target, paths = MC_PATHS, seed = MC_SEED }) {
  const rnd = mulberry32(seed);
  let spare = null;
  const normal = () => {
    if (spare != null) { const z = spare; spare = null; return z; }
    const u = rnd() || 1e-12, v = rnd(), rad = Math.sqrt(-2 * Math.log(u));
    spare = rad * Math.sin(2 * Math.PI * v);
    return rad * Math.cos(2 * Math.PI * v);
  };
  const params = glide.map((g) => { const sd = g.volatility / Math.sqrt(12); return { mu: Math.log(1 + g.expectedReturn) / 12 - (sd * sd) / 2, sd }; });
  const checkpoints = [];
  for (let y = 1; y * 12 < N; y++) checkpoints.push(y * 12);
  checkpoints.push(N);
  const A = checkpoints.map(() => new Float64Array(paths)), B = checkpoints.map(() => new Float64Array(paths));
  for (let p = 0; p < paths; p++) {
    let a = S, b = 0, k = 0;
    for (let m = 0; m < N; m++) {
      const { mu, sd } = params[Math.min(params.length - 1, Math.floor(m / 12))];
      const g = Math.exp(mu + sd * normal());
      a *= g; b = b * g + 1;
      if (m + 1 === checkpoints[k]) { A[k][p] = a; B[k][p] = b; k++; }
    }
  }
  const series = [{ year: 0, p10: S, p25: S, p50: S, p75: S, p90: S }];
  checkpoints.forEach((m, k) => {
    const vals = Array.from(A[k], (a, p) => a + sip * B[k][p]).sort((x, y) => x - y);
    series.push({ year: +(m / 12).toFixed(2), p10: quantile(vals, 0.1), p25: quantile(vals, 0.25), p50: quantile(vals, 0.5), p75: quantile(vals, 0.75), p90: quantile(vals, 0.9) });
  });
  const endA = A.at(-1), endB = B.at(-1);
  let hits = 0;
  const needed = [];
  for (let p = 0; p < paths; p++) {
    if (endA[p] + sip * endB[p] >= target * (1 - 1e-9)) hits++;
    needed.push(Math.max(0, (target - endA[p]) / endB[p]));
  }
  needed.sort((x, y) => x - y);
  const end = series.at(-1);
  return {
    paths, seed, sip, target,
    method: `${paths} simulated paths of monthly log-normal returns; each year's mean and volatility come from that year's glide-path allocation (illustrative volatilities and correlations). A range of outcomes, not a forecast.`,
    series,
    successProb: hits / paths,
    endP10: end.p10, endP50: end.p50, endP90: end.p90,
    shortfallP10: Math.max(0, target - end.p10),
    sipFor: { 50: quantile(needed, 0.5), 75: quantile(needed, 0.75), 80: quantile(needed, 0.8), 90: quantile(needed, 0.9) },
  };
}

// ---------- De-risking schedule ----------
// Turns the glide path into concrete switches: at the start of each year in which the mix
// changes, how much of the projected corpus moves out of equity (and gold) into debt / liquid.
const ASSET_CLASSES = { equity: EQUITY_KEYS, debt: ['debt'], liquid: ['liquid'], gold: ['gold'] };
const classMix = (w) => Object.fromEntries(Object.entries(ASSET_CLASSES).map(([c, ks]) => [c, sumOf(w, ks)]));

export function deriskSchedule(glide, projection, sip) {
  const steps = [];
  for (let i = 1; i < glide.length; i++) {
    if (glide[i].yearsLeft <= 0) continue; // the goal date itself: money is withdrawn, not switched
    const a = classMix(glide[i - 1].weights), b = classMix(glide[i].weights);
    if (JSON.stringify(glide[i - 1].weights) === JSON.stringify(glide[i].weights)) continue;
    const corpus = projection.find((p) => p.year === glide[i].year)?.glideCorpus ?? 0;
    const delta = Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));
    const sold = Object.values(delta).filter((d) => d < 0).reduce((s, d) => s - d, 0);
    steps.push({
      year: glide[i].year, age: glide[i].age, yearsLeft: glide[i].yearsLeft,
      before: a, after: b, delta, corpus,
      switchPct: sold, switchAmount: (sold / 100) * corpus,
      equityOut: (Math.max(0, -delta.equity) / 100) * corpus,
      sipSplit: Object.fromEntries(Object.entries(b).map(([k, w]) => [k, (w / 100) * sip])),
      expectedReturn: glide[i].expectedReturn, volatility: glide[i].volatility,
      rules: glide[i].rules.slice(1),
    });
  }
  // Phases: growth (equity at this goal's maximum), transition (equity falling), protection (no equity).
  const live = glide.filter((g) => g.yearsLeft > 0);
  const maxEq = Math.max(0, ...live.map((g) => g.equity));
  const phaseOf = (g) => (g.equity === 0 ? 'protection' : g.equity === maxEq ? 'growth' : 'transition');
  const phases = [];
  for (const g of live) {
    const k = phaseOf(g);
    const cur = phases.at(-1);
    if (cur && cur.key === k) { cur.to = Math.min(g.year + 1, g.year + g.yearsLeft); cur.equityTo = g.equity; }
    else phases.push({ key: k, from: g.year, to: Math.min(g.year + 1, g.year + g.yearsLeft), equityFrom: g.equity, equityTo: g.equity });
  }
  const label = { growth: 'Growth', transition: 'Transition', protection: 'Capital protection' };
  const what = {
    growth: 'Equity stays at the maximum this goal allows; SIPs and existing money follow the growth mix.',
    transition: 'Equity is trimmed every year. Redirect new SIPs to debt first, then move the rest with a systematic transfer plan (STP) over 3–6 months.',
    protection: 'No equity: money needed soon sits in liquid / money-market funds so a market fall cannot dent it.',
  };
  return {
    steps,
    phases: phases.map((p) => ({ ...p, to: +p.to.toFixed(2), label: label[p.key], what: what[p.key] })),
    totalEquityOut: steps.reduce((s, x) => s + x.equityOut, 0),
    execution: [
      'Redirect new SIP instalments to the new target mix first; this de-risks without selling anything.',
      'Move the remaining amount with a systematic transfer plan (STP) spread over 3–6 months rather than in a single switch.',
      'A switch between schemes is a redemption: check exit loads and capital-gains tax before each move.',
      'Review once a year and after large market moves; rebalance if any asset class drifts more than 5 points from target.',
    ],
  };
}

export function buildPlan(client, risk) {
  const riskIndex = risk.final.index;
  const maxLossPct = +client.maxLoss || 20;
  const goals = (client.goals || []).filter((g) => +g.currentCost > 0).map((g) => planGoal(g, { riskIndex, maxLossPct, startAge: +client.age }));
  const totalSip = goals.reduce((s, g) => s + g.recommendedSip, 0);
  const budget = +client.monthlyInvestable || 0;
  const surplus = risk.financials.surplus;

  // Combined current allocation, weighted by each goal's recommended SIP.
  const combined = {};
  for (const g of goals) for (const [k, w] of Object.entries(g.currentAllocation.weights)) combined[k] = (combined[k] || 0) + (w * g.recommendedSip) / (totalSip || 1);
  return {
    goals, totalSip, budget, surplus,
    sipToSurplus: surplus > 0 ? totalSip / surplus : Infinity,
    combinedAllocation: roundTo100(combined),
    assumptions: ASSET_ASSUMPTIONS,
    volatility: ASSET_VOLATILITY,
  };
}

const fmt = (x) => '₹' + Math.round(x).toLocaleString('en-IN');
const pct = (x) => (x * 100).toFixed(2).replace(/\.00$/, '') + '%';
