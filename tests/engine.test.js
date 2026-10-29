import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, LEVELS } from '../src/engine/risk.js';
import { planGoal, sipFor, monthlyRateEffective, allocate } from '../src/engine/planner.js';
import { screenSleeve, shortlist } from '../src/engine/funds.js';
import { backtest } from '../src/engine/backtest.js';
import { runPipeline } from '../src/engine/pipeline.js';
import { detectGuaranteeRequest } from '../src/engine/guardrails.js';
import { answer, detectFunds } from '../src/engine/rag.js';
import { patna, senior, aggressive, retiree } from './fixtures.js';

const codes = (draft) => draft.guardrails.flags.map((f) => f.code);

test('future cost matches the worked example: ₹25 lakh at 6% for 15 years ≈ ₹59.91 lakh', () => {
  const g = planGoal({ name: 'Education', type: 'education', currentCost: 2500000, years: 15, inflation: 0.06, assumedReturn: 0.1, existingSavings: 0 }, { riskIndex: 1, maxLossPct: 20 });
  assert.equal((g.futureCost / 1e5).toFixed(2), '59.91');
});

test('effective monthly rate compounds back to the annual rate; SIP solves the annuity equation', () => {
  const r = monthlyRateEffective(0.1);
  assert.ok(Math.abs((1 + r) ** 12 - 1.1) < 1e-12);
  const P = sipFor(1_000_000, r, 120);
  const fv = (P * ((1 + r) ** 120 - 1)) / r;
  assert.ok(Math.abs(fv - 1_000_000) < 1e-6);
});

test('existing savings reduce the gap; fully funded goals need no SIP', () => {
  const funded = planGoal({ name: 'x', type: 'other', currentCost: 100000, years: 5, inflation: 0.06, assumedReturn: 0.1, existingSavings: 500000 }, { riskIndex: 1, maxLossPct: 20 });
  assert.equal(funded.gap, 0);
  assert.equal(funded.sip, 0);
});

test('Patna example: high capacity, conservative tolerance → conservative, with the documented reason', () => {
  const r = assessRisk(patna);
  assert.equal(r.capacity.level, 'High');
  assert.equal(r.tolerance.level, 'Conservative');
  assert.equal(r.final.level, 'Conservative');
  assert.equal(r.capacity.max, 100);
  assert.equal(r.capacity.score, 84.3);
  for (const f of r.capacity.factors) assert.ok(f.points >= 0 && f.points <= 10 && f.max === 10);
  assert.match(r.reasons[0], /low tolerance for market volatility/);
  assert.ok(r.conflicts.some((c) => c.code === 'CAPACITY_ABOVE_TOLERANCE'));
});

test('conflict rule: proposed level never exceeds capacity or tolerance (randomised profiles)', () => {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  for (let i = 0; i < 500; i++) {
    const c = {
      age: 20 + Math.floor(Math.random() * 60), horizonYears: 1 + Math.floor(Math.random() * 30), monthlyIncome: 20000 + Math.random() * 300000,
      monthlyExpenses: Math.random() * 150000, monthlyEmi: Math.random() * 60000, emergencySavings: Math.random() * 2e6, dependants: Math.floor(Math.random() * 5),
      incomeStability: pick(['stable', 'variable', 'irregular']), experience: pick(['none', 'basic', 'moderate', 'extensive']),
      lossReaction: pick(['sell_all', 'sell_some', 'hold', 'buy_more']), fluctuationComfort: pick(['very_uncomfortable', 'somewhat_uncomfortable', 'comfortable', 'very_comfortable']),
      maxLoss: pick(['5', '10', '20', '30']), preferredRisk: pick(['low', 'medium', 'high']), goals: [],
    };
    const r = assessRisk(c);
    const capIdx = ['Low', 'Medium', 'High'].indexOf(r.capacity.level);
    const tolIdx = LEVELS.indexOf(r.tolerance.level);
    assert.equal(r.final.index, Math.min(capIdx, tolIdx));
  }
});

test('capacity caps: a 68-year-old cannot be scored High capacity', () => {
  const r = assessRisk({ ...senior, emergencySavings: 5_000_000, horizonYears: 20 });
  assert.notEqual(r.capacity.level, 'High');
});

test('glide path: equity never rises, falls gradually from 10 years out, is zero inside 3 years; debt moves to liquid', () => {
  for (const [riskIndex, maxLossPct] of [[0, 10], [1, 20], [2, 30]]) {
    const g = planGoal({ name: 'Retirement', type: 'retirement', currentCost: 1e7, years: 20, inflation: 0.06, assumedReturn: 0.1 }, { riskIndex, maxLossPct });
    for (let i = 1; i < g.glide.length; i++) {
      const [a, b] = [g.glide[i - 1], g.glide[i]];
      assert.ok(b.equity <= a.equity, 'equity never rises');
      assert.ok(a.equity - b.equity <= 15, `no cliff: ${a.equity}% → ${b.equity}%`);
      if (b.yearsLeft > 0) assert.ok((b.weights.liquid ?? 0) >= (a.weights.liquid ?? 0), 'liquid share only grows');
    }
    assert.ok(g.glide.filter((y) => y.yearsLeft >= 10).every((y) => y.equity === g.glide[0].equity), 'full equity until 10 years out');
    assert.ok(g.glide.filter((y) => y.yearsLeft < 3).every((y) => y.equity === 0));
    assert.ok(g.glide.filter((y) => y.yearsLeft <= 2).every((y) => y.weights.liquid === 100));
    for (const y of g.glide) assert.equal(Object.values(y.weights).reduce((x, z) => x + z, 0), 100);
  }
});

test('projection: expected corpus at the recommended SIP reaches the target; Monte Carlo is reproducible and consistent', () => {
  const goal = { name: 'House', type: 'house', currentCost: 5e6, years: 12, inflation: 0.06, assumedReturn: 0.09, existingSavings: 2e5 };
  const g = planGoal(goal, { riskIndex: 1, maxLossPct: 20, startAge: 35 });
  assert.ok(g.projection.at(-1).glideCorpus >= g.futureCost * 0.999);
  assert.equal(g.projection.at(-1).year, 12);
  const mc = g.monteCarlo;
  assert.ok(mc.successProb > 0.3 && mc.successProb < 0.75, 'expected-return SIP is close to a coin flip');
  assert.ok(mc.sipFor[50] <= mc.sipFor[80] && mc.sipFor[80] <= mc.sipFor[90]);
  assert.ok(mc.sipFor[80] > g.recommendedSip);
  for (const r of mc.series) assert.ok(r.p10 <= r.p50 && r.p50 <= r.p90);
  assert.deepEqual(planGoal(goal, { riskIndex: 1, maxLossPct: 20, startAge: 35 }).monteCarlo.series, mc.series, 'same seed → same draft');
});

test('de-risking schedule: every switch is a real mix change with a rupee amount; phases run growth → transition → protection', () => {
  const g = planGoal({ name: 'Wealth', type: 'wealth', currentCost: 1e7, years: 15, inflation: 0.06, assumedReturn: 0.1 }, { riskIndex: 2, maxLossPct: 30, startAge: 30 });
  const d = g.derisk;
  assert.deepEqual(d.phases.map((p) => p.key), ['growth', 'transition', 'protection']);
  assert.ok(d.steps.length >= 5);
  for (const s of d.steps) {
    assert.ok(s.switchAmount > 0 && s.corpus > 0);
    assert.ok(s.after.equity <= s.before.equity);
    assert.equal(Object.values(s.after).reduce((x, y) => x + y, 0), 100);
  }
});

test('investment options: several fund choices from screened funds; the low-cost option is cheapest', () => {
  const d = runPipeline(patna);
  assert.deepEqual(d.investOptions.map((o) => o.id), ['recommended', 'passive', 'alternative', 'simple']);
  const eligible = new Set(d.funds.flatMap((s) => s.eligible.map((f) => f.code)));
  for (const o of d.investOptions) for (const s of o.sleeves) assert.ok(s.code == null || eligible.has(s.code));
  const byId = Object.fromEntries(d.investOptions.map((o) => [o.id, o]));
  assert.ok(byId.passive.ter <= byId.recommended.ter);
  assert.ok(byId.simple.fundCount < byId.recommended.fundCount);
  for (const o of d.investOptions) assert.ok(o.history && o.history.maxDrawdown <= 0);
});

test('allocation is not one-size-fits-all: horizon, risk level, goal type and loss tolerance all move it', () => {
  const base = allocate({ riskIndex: 2, yearsLeft: 15, goalType: 'wealth', maxLossPct: 30 }).equity;
  assert.ok(allocate({ riskIndex: 0, yearsLeft: 15, goalType: 'wealth', maxLossPct: 30 }).equity < base);
  assert.ok(allocate({ riskIndex: 2, yearsLeft: 4, goalType: 'wealth', maxLossPct: 30 }).equity < base);
  assert.ok(allocate({ riskIndex: 2, yearsLeft: 15, goalType: 'medical', maxLossPct: 30 }).equity < base);
  assert.ok(allocate({ riskIndex: 2, yearsLeft: 15, goalType: 'wealth', maxLossPct: 10 }).equity < base);
  assert.ok((allocate({ riskIndex: 1, yearsLeft: 8, goalType: 'medical', maxLossPct: 20 }).weights.liquid ?? 0) >= 20);
});

test('screening: only direct growth plans pass; short-history funds are excluded with a reason', () => {
  const large = screenSleeve('largecap');
  assert.ok(large.eligible.every((f) => /direct/i.test(f.plan) && /growth/i.test(f.option)));
  const ppLarge = large.excluded.find((f) => f.code === 154155);
  assert.ok(ppLarge.exclusionReasons.some((r) => /history/.test(r)));
  assert.ok(large.selected.explanation.startsWith('Rank 1'));
  for (const f of large.eligible) assert.ok(f.sources[0].url.includes('#page='));
});

test('backtest covers 120 months, weights sum to 1, and discloses proxies for young funds', () => {
  const sl = shortlist({ largecap: 40, midcap: 30, debt: 30 });
  const mid = sl.find((s) => s.sleeve === 'midcap');
  mid.selected = mid.eligible.find((f) => f.code === 148726); // index fund launched 2021
  const bt = backtest(sl);
  assert.equal(bt.period.months, 120);
  assert.ok(Math.abs(bt.weights.reduce((a, w) => a + w.weight, 0) - 1) < 1e-9);
  assert.ok(bt.coverage.find((c) => c.fund.includes('Midcap 150')).proxyMonths > 0);
  assert.ok(bt.limitations.some((l) => /proxy/.test(l)));
  assert.ok(bt.limitations.some((l) => /Survivorship/.test(l)));
  assert.ok(bt.stats.portfolio.maxDrawdown <= 0);
});

test('guardrails: 68-year-old small-cap-only request is flagged high and not followed', () => {
  const d = runPipeline(senior);
  assert.ok(codes(d).includes('UNSUITABLE_PRODUCT_REQUEST'));
  assert.ok(codes(d).includes('RETURN_GUARANTEE_REQUESTED'));
  const small = d.plan.combinedAllocation.smallcap ?? 0;
  assert.equal(small, 0, 'plan must not put the client into small caps');
  assert.equal(d.guardrails.status, 'REVIEW_REQUIRED');
});

test('guardrails: "aggressive" label with near-term obligations is flagged for review', () => {
  const d = runPipeline(aggressive);
  assert.ok(codes(d).includes('AGGRESSIVE_WITH_NEAR_TERM_OBLIGATIONS'));
  assert.ok(codes(d).includes('HIGH_DEBT_BURDEN'));
  assert.notEqual(d.risk.final.level, 'Aggressive');
});

test('guarantee requests are detected', () => {
  assert.ok(detectGuaranteeRequest('Can you guarantee me 20% returns every year?'));
  assert.ok(detectGuaranteeRequest('I want assured returns'));
  assert.ok(!detectGuaranteeRequest('What is the exit load?'));
});

test('research assistant: cited answers, guardrail on guarantees, refuses when not in documents', async () => {
  const a = await answer('What is the expense ratio of Parag Parikh Flexi Cap Fund?');
  assert.equal(a.type, 'answer');
  assert.ok(a.facts[0].text.includes('0.53%'));
  assert.ok(a.facts[0].source.url.includes('#page=2'));
  const exit = await answer('What is the exit load of Nippon India Small Cap Fund?');
  assert.ok(exit.passages.some((p) => /Exit Load/i.test(p.excerpt) && p.page === 21));
  assert.equal((await answer('Can you guarantee me 20% returns every year?')).type, 'guardrail');
  assert.equal((await answer('What is the price of bitcoin today?')).type, 'not_found');
});

test('research: comparisons, follow-ups and case-aware answers', async () => {
  assert.deepEqual(detectFunds('Compare Parag Parikh Flexi Cap Fund vs Nippon India Flexi Cap Fund'), [122639, 149094]);
  const cmp = await answer('Compare Parag Parikh Flexi Cap Fund vs Nippon India Flexi Cap Fund');
  assert.equal(cmp.comparison.length, 2);
  assert.equal(cmp.comparison[0].ter, 0.53);
  const follow = await answer('What about its expense ratio?', { previousCodes: [118778] });
  assert.ok(follow.followUp);
  assert.ok(follow.facts[0].text.startsWith('Nippon India Small Cap Fund'));
  const d = runPipeline(patna);
  const pick = d.funds[0].selected;
  const why = await answer(`Why was ${pick.name} chosen?`, { draft: d, contextCodes: d.funds.map((f) => f.selected?.code) });
  assert.match(why.facts[0].text, /Rank 1/);
});

test('investment amount is recommended as a range from the finances, not asked for', () => {
  const r = runPipeline(patna).plan.investRange;
  // ₹90k surplus, stable income → affordable 50–80%; goals need more, so the range is the affordable band.
  assert.deepEqual([r.monthly.low, r.monthly.high], [45000, 72000]);
  assert.ok(r.monthly.need > r.monthly.affordHigh);
  const comfy = runPipeline({ ...patna, goals: [patna.goals[1]] }).plan.investRange;
  assert.ok(comfy.monthly.low >= Math.round(comfy.monthly.need / 100) * 100 - 100 && comfy.monthly.high <= comfy.monthly.affordHigh);
  assert.ok(comfy.monthly.low <= comfy.monthly.high);
});

test('lump sum: savings not yet invested top up the emergency fund first', () => {
  const r = runPipeline({ ...patna, savingsToInvest: 1000000 }).plan.investRange;
  assert.equal(Math.round(r.lumpSum.emergencyTopUp), 60000); // ₹3L held vs 6 × ₹60k
  assert.equal(r.lumpSum.high, 940000);
  assert.equal(r.lumpSum.low, 940000 - 180000);
});

test('retired client with no income: scored on savings cover, no SIP, lump sum + SWP', () => {
  const d = runPipeline(retiree);
  const f = d.risk.capacity.factors;
  assert.ok(f.some((x) => x.key === 'savingsCoverYears') && !f.some((x) => x.key === 'surplusRatio'));
  assert.equal(f.find((x) => x.key === 'incomeStability').points, 0);
  const r = d.plan.investRange;
  assert.equal(r.monthly.high, 0);
  assert.equal(r.withdrawals.monthly, 45000);
  assert.ok(r.lumpSum.high > 0 && r.lumpSum.emergencyTarget === 45000 * 12);
  const c = codes(d);
  assert.ok(!c.includes('NO_SURPLUS'));
  assert.ok(c.includes('SWP_FROM_SAVINGS') || c.includes('WITHDRAWAL_RATE_ELEVATED') || c.includes('WITHDRAWAL_RATE_HIGH'));
  assert.ok(c.includes('GOALS_FROM_SAVINGS'));
});

test('retiree withdrawing too fast is flagged high', () => {
  const d = runPipeline({ ...retiree, existingInvestments: 2000000, savingsToInvest: 0, monthlyExpenses: 60000 });
  assert.ok(d.guardrails.flags.some((x) => x.code === 'WITHDRAWAL_RATE_HIGH' && x.severity === 'high'));
});

test('tax reference: current equity-fund rates, holding periods and exemption, with an as-of date', async () => {
  const { taxRulesText, TAX_AS_OF } = await import('../src/engine/tax.js');
  const all = taxRulesText();
  for (const s of ['20%', '12.5%', '₹1,25,000', '12 months', 'slab rate', '194K', TAX_AS_OF]) assert.ok(all.includes(s), s);
  const debt = taxRulesText(['debt']);
  assert.ok(debt.includes('1 April 2023') && !debt.includes('20% (s. 111A)'), 'only the debt rules and general points');
});
