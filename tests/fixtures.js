const BASE = {
  incomeStability: 'stable', monthlyEmi: 0, outstandingLoans: 0, hasLifeCover: 'yes', hasHealthCover: 'yes',
  experience: 'basic', lossReaction: 'hold', fluctuationComfort: 'somewhat_uncomfortable', maxLoss: '20', preferredRisk: 'medium',
  specialRequest: 'none', notes: '',
};

// The problem statement's example: 38, Patna, ₹1.5L income, ₹60k expenses, 22-year horizon, parents, low risk.
export const patna = {
  ...BASE, name: 'Rohit Kumar', age: 38, location: 'Patna', monthlyIncome: 150000, monthlyExpenses: 60000, existingInvestments: 800000,
  emergencySavings: 300000, dependants: 2, dependantsNote: 'Parents', horizonYears: 22,
  lossReaction: 'sell_some', maxLoss: '10', preferredRisk: 'low',
  goals: [
    { name: 'Retirement', type: 'retirement', currentCost: 20000000, years: 22, existingSavings: 500000, inflation: 0.06, assumedReturn: 0.09 },
    { name: "Parents' medical reserve", type: 'medical', currentCost: 1000000, years: 10, existingSavings: 200000, inflation: 0.08, assumedReturn: 0.08 },
  ],
};

// 68-year-old asking for small-cap-only exposure (and a guaranteed 20%).
export const senior = {
  ...BASE, name: 'Kamala Devi', age: 68, monthlyIncome: 55000, monthlyExpenses: 40000, existingInvestments: 2500000, emergencySavings: 300000,
  dependants: 1, horizonYears: 5, experience: 'moderate', fluctuationComfort: 'comfortable', preferredRisk: 'high',
  specialRequest: 'smallcap_only', notes: 'Can you guarantee 20% returns every year?',
  goals: [{ name: 'Healthcare top-up', type: 'medical', currentCost: 1500000, years: 5, existingSavings: 1000000, inflation: 0.08, assumedReturn: 0.08 }],
};

// Selects "aggressive" but has a near-term house payment, high EMIs and thin emergency savings.
export const aggressive = {
  ...BASE, name: 'Arjun Mehta', age: 29, incomeStability: 'variable', monthlyIncome: 120000, monthlyExpenses: 45000, monthlyEmi: 52000,
  outstandingLoans: 2600000, existingInvestments: 400000, emergencySavings: 60000, dependants: 0, horizonYears: 15,
  experience: 'moderate', lossReaction: 'buy_more', fluctuationComfort: 'very_comfortable', maxLoss: '30', preferredRisk: 'high',
  goals: [
    { name: 'House down-payment', type: 'house', currentCost: 1500000, years: 2, existingSavings: 300000, inflation: 0.06, assumedReturn: 0.12 },
    { name: 'Wealth creation', type: 'wealth', currentCost: 10000000, years: 15, existingSavings: 100000, inflation: 0.06, assumedReturn: 0.12 },
  ],
};

// Retired, no pension: lives off savings and wants to help with a grandchild's education.
export const retiree = {
  ...BASE, name: 'Suresh Rao', age: 66, employmentStatus: 'retired', monthlyIncome: 0, monthlyExpenses: 45000, existingInvestments: 9000000,
  savingsToInvest: 2500000, emergencySavings: 300000, dependants: 1, horizonYears: 20, experience: 'moderate', preferredRisk: 'low',
  goals: [{ name: "Grandchild's education", type: 'education', currentCost: 1000000, years: 10, existingSavings: 0, inflation: 0.08, assumedReturn: 0.08 }],
};
