// Risk profiling engine.
//
// Risk CAPACITY (can the client afford risk?) and risk TOLERANCE (is the client comfortable
// with risk?) are scored separately with the documented rules below, then combined with the
// conflict rule: the proposed level never exceeds EITHER of them.

export const LEVELS = ['Conservative', 'Moderate', 'Aggressive'];
const CAPACITY_LABELS = ['Low', 'Medium', 'High'];

// ---------- Risk capacity: every factor scored out of 10, averaged to a score out of 100 ----------
// Each factor gets 0–10 points and counts equally. The capacity score is the simple average
// of the factor scores scaled ×10, so it is out of 100.
export const CAPACITY_RULES = [
  { key: 'age', label: 'Age', bands: [[29, 10], [39, 8], [49, 6], [59, 4], [Infinity, 2]], note: 'Younger clients have more years of earning to recover from losses.' },
  { key: 'horizon', label: 'Investment horizon (years)', bands: [[2, 0], [4, 2], [6, 4], [9, 6], [14, 8], [Infinity, 10]], note: 'Longer horizons can absorb market cycles.' },
  { key: 'surplusRatio', label: 'Monthly surplus after expenses & EMIs (% of income)', bands: [[0.1, 0], [0.25, 4], [0.4, 7], [Infinity, 10]] },
  { key: 'emergencyMonths', label: 'Emergency savings (months of outgo)', bands: [[1, 0], [3, 3], [6, 6], [Infinity, 10]] },
  { key: 'emiRatio', label: 'EMI burden (% of income)', bands: [[0, 10], [0.1, 8], [0.3, 5], [0.5, 2], [Infinity, 0]] },
  { key: 'dependants', label: 'Number of dependants', bands: [[0, 10], [1, 7], [2, 5], [3, 3], [Infinity, 1]] },
  { key: 'incomeStability', label: 'Income stability', map: { stable: 10, variable: 6, irregular: 0 } },
];
export const FACTOR_MAX = 10;
export const CAPACITY_MAX = 100;
export const CAPACITY_BANDS = { medium: 40, high: 70 }; // Low < 40 ≤ Medium < 70 ≤ High (score out of 100)

export const CAPACITY_CAPS = [
  { label: 'Investment horizon under 3 years → capacity capped at Low', when: (i) => i.horizon < 3, max: 0 },
  { label: 'Investment horizon under 5 years → capacity capped at Medium', when: (i) => i.horizon < 5, max: 1 },
  { label: 'Age 65 or above → capacity capped at Medium', when: (i) => i.age >= 65, max: 1 },
];

// ---------- Risk tolerance: behavioural questionnaire (0–15) ----------
export const TOLERANCE_QUESTIONS = [
  { key: 'experience', label: 'Investment experience', options: { none: 0, basic: 1, moderate: 2, extensive: 3 } },
  { key: 'lossReaction', label: 'If the portfolio fell 20% in a year, the client would…', options: { sell_all: 0, sell_some: 1, hold: 2, buy_more: 3 } },
  { key: 'fluctuationComfort', label: 'Comfort with short-term fluctuations', options: { very_uncomfortable: 0, somewhat_uncomfortable: 1, comfortable: 2, very_comfortable: 3 } },
  { key: 'maxLoss', label: 'Largest one-year fall the client can accept', options: { '5': 0, '10': 1, '20': 2, '30': 3 } },
  { key: 'preferredRisk', label: 'Stated risk preference', options: { low: 0, medium: 1.5, high: 3 } },
];
export const TOLERANCE_BANDS = [[5, 'Conservative'], [10, 'Moderate'], [Infinity, 'Aggressive']];

// bands are [upperBound, points]; the first band whose bound the value does not exceed wins.
function band(value, rule) {
  if (rule.map) return rule.map[value] ?? 0;
  for (const [ub, pts] of rule.bands) if (value <= ub) return pts;
  return 0;
}

export function deriveFinancials(c) {
  const income = +c.monthlyIncome || 0;
  const expenses = +c.monthlyExpenses || 0;
  const emi = +c.monthlyEmi || 0;
  const outgo = expenses + emi;
  const surplus = income - outgo;
  return {
    income, expenses, emi, outgo, surplus,
    surplusRatio: income > 0 ? surplus / income : 0,
    emiRatio: income > 0 ? emi / income : 0,
    emergencyMonths: outgo > 0 ? (+c.emergencySavings || 0) / outgo : 0,
    debtToAnnualIncome: income > 0 ? (+c.outstandingLoans || 0) / (income * 12) : 0,
  };
}

export function assessRisk(client) {
  const fin = deriveFinancials(client);
  const inputs = {
    age: +client.age,
    horizon: +client.horizonYears,
    surplusRatio: fin.surplusRatio,
    emergencyMonths: fin.emergencyMonths,
    emiRatio: fin.emiRatio,
    dependants: +client.dependants || 0,
    incomeStability: client.incomeStability || 'stable',
  };
  const capacityFactors = CAPACITY_RULES.map((r) => {
    const points = band(inputs[r.key], r);
    return { key: r.key, label: r.label, value: inputs[r.key], points, max: FACTOR_MAX, note: r.note };
  });
  const avgPoints = capacityFactors.reduce((s, f) => s + f.points, 0) / capacityFactors.length;
  const capacityScore = Math.round(avgPoints * (CAPACITY_MAX / FACTOR_MAX) * 10) / 10;
  let capIdx = capacityScore >= CAPACITY_BANDS.high ? 2 : capacityScore >= CAPACITY_BANDS.medium ? 1 : 0;
  // Hard caps: points cannot outweigh a very short horizon or advanced age.
  const capCaps = [];
  for (const cap of CAPACITY_CAPS) {
    if (cap.when(inputs) && capIdx > cap.max) { capIdx = cap.max; capCaps.push(cap.label); }
  }

  const toleranceAnswers = TOLERANCE_QUESTIONS.map((q) => ({ label: q.label, answer: client[q.key], points: q.options[client[q.key]] ?? 0, max: 3 }));
  const toleranceScore = toleranceAnswers.reduce((s, a) => s + a.points, 0);
  const tolLevel = TOLERANCE_BANDS.find(([ub]) => toleranceScore <= ub)[1];
  const tolIdx = LEVELS.indexOf(tolLevel);

  // Conflict rule: proposed level = the LOWER of capacity and tolerance.
  const finalIdx = Math.min(capIdx, tolIdx);
  const conflicts = [];
  const reasons = [];

  if (capIdx > tolIdx) {
    reasons.push(`Client can afford ${CAPACITY_LABELS[capIdx].toLowerCase()} risk, but behavioural tolerance is ${tolLevel.toLowerCase()}, so tolerance sets the ceiling (low tolerance for market volatility).`);
    conflicts.push({ severity: 'medium', code: 'CAPACITY_ABOVE_TOLERANCE', message: `Risk capacity (${CAPACITY_LABELS[capIdx]}) is higher than risk tolerance (${tolLevel}). The plan follows tolerance; the adviser may discuss whether the client wants to learn more before taking more risk.` });
  } else if (tolIdx > capIdx) {
    reasons.push(`Client is willing to take ${tolLevel.toLowerCase()} risk, but financial capacity is only ${CAPACITY_LABELS[capIdx].toLowerCase()}, so capacity sets the ceiling.`);
    conflicts.push({ severity: 'high', code: 'TOLERANCE_ABOVE_CAPACITY', message: `Client's willingness (${tolLevel}) exceeds what their finances can absorb (capacity ${CAPACITY_LABELS[capIdx]}). Requires adviser review before any higher-risk product is discussed.` });
  } else {
    reasons.push(`Capacity (${CAPACITY_LABELS[capIdx]}) and tolerance (${tolLevel}) agree.`);
  }

  // Internal consistency of the questionnaire: stated preference vs behaviour.
  const prefIdx = { low: 0, medium: 1, high: 2 }[client.preferredRisk] ?? 1;
  const behaviour = (TOLERANCE_QUESTIONS[1].options[client.lossReaction] ?? 0) + (TOLERANCE_QUESTIONS[2].options[client.fluctuationComfort] ?? 0);
  if (prefIdx === 2 && behaviour <= 2) {
    conflicts.push({ severity: 'high', code: 'INCONSISTENT_ANSWERS', message: 'Client selected "high" risk but says they would sell or be uncomfortable during a fall. Re-confirm the risk preference with the client.' });
  }
  if (prefIdx === 0 && behaviour >= 5) {
    conflicts.push({ severity: 'low', code: 'INCONSISTENT_ANSWERS', message: 'Client selected "low" risk but answers suggest comfort with volatility. Plan stays conservative unless the client confirms otherwise.' });
  }

  // Aggressive label despite near-term obligations.
  const nearTerm = (client.goals || []).filter((g) => +g.years <= 3 && +g.currentCost > 0);
  const stressed = fin.emergencyMonths < 3 || fin.emiRatio > 0.4 || nearTerm.length > 0;
  if ((prefIdx === 2 || tolIdx === 2) && stressed) {
    const why = [
      fin.emergencyMonths < 3 && `only ${fin.emergencyMonths.toFixed(1)} months of emergency savings`,
      fin.emiRatio > 0.4 && `EMIs take ${(fin.emiRatio * 100).toFixed(0)}% of income`,
      nearTerm.length && `${nearTerm.length} goal(s) due within 3 years`,
    ].filter(Boolean).join(', ');
    conflicts.push({ severity: 'high', code: 'AGGRESSIVE_WITH_NEAR_TERM_OBLIGATIONS', message: `Client chose an aggressive profile but has ${why}. Do not follow the label blindly – review before recommending equity-heavy portfolios.` });
  }

  return {
    capacity: { score: capacityScore, max: CAPACITY_MAX, level: CAPACITY_LABELS[capIdx], factors: capacityFactors, caps: capCaps, bands: 'Low < 40 ≤ Medium < 70 ≤ High (score out of 100: simple average of the factors, each out of 10, ×10)' },
    tolerance: { score: toleranceScore, max: 15, level: tolLevel, answers: toleranceAnswers, bands: 'Conservative ≤ 5 < Moderate ≤ 10 < Aggressive' },
    final: { level: LEVELS[finalIdx], index: finalIdx, rule: 'Proposed risk level = the lower of risk capacity and risk tolerance (it never exceeds either). Goal horizon and liquidity rules can lower it further for individual goals.' },
    reasons: [...reasons, ...capCaps.map((c) => `Capacity rule applied: ${c}.`)],
    conflicts,
    financials: fin,
  };
}
