// Capital-gains and dividend tax on mutual fund units for resident individuals, as a fixed
// reference the research agent cites instead of searching the web (slow, and often missing the
// rate). Each rule names the section it comes from. Budgets change these, so AS_OF and the review
// note travel with every answer; update the table after each Union Budget.
export const TAX_AS_OF = 'Finance (No. 2) Act, 2024: transfers on or after 23 July 2024';
export const TAX_SOURCE = {
  label: 'Income Tax Department – capital gains on mutual fund units (Income-tax Act ss. 111A, 112A, 112, 50AA; Finance (No. 2) Act, 2024)',
  url: 'https://www.incometax.gov.in/iec/foportal/',
};

export const TAX_RULES = [
  {
    topic: 'equity',
    title: 'Equity-oriented funds (at least 65% in Indian listed equity, incl. equity index funds and ETFs)',
    rules: [
      'Short-term: units held 12 months or less. Gains taxed at 20% (s. 111A), plus surcharge and 4% health & education cess.',
      'Long-term: units held more than 12 months. Gains above ₹1,25,000 in a financial year taxed at 12.5% (s. 112A), without indexation, plus surcharge and 4% cess. The first ₹1,25,000 of long-term gains a year is exempt.',
      'Before 23 July 2024 the rates were 15% (short-term) and 10% above ₹1,00,000 (long-term).',
      'Securities transaction tax (STT) applies on redemption of equity-oriented fund units.',
    ],
  },
  {
    topic: 'debt',
    title: 'Debt funds ("specified mutual funds", s. 50AA: more than 65% in debt and money-market instruments)',
    rules: [
      'Units bought on or after 1 April 2023: all gains taxed at the investor\'s income-tax slab rate, whatever the holding period; no indexation and no long-term rate.',
      'Units bought before 1 April 2023: held more than 24 months, long-term gains taxed at 12.5% without indexation (s. 112); held 24 months or less, taxed at slab rate.',
    ],
  },
  {
    topic: 'other',
    title: 'Other funds (e.g. gold funds, international and fund-of-funds that are neither equity-oriented nor specified mutual funds)',
    rules: [
      'Listed units held more than 12 months, or unlisted units held more than 24 months: long-term gains taxed at 12.5% without indexation (s. 112).',
      'Shorter holdings: taxed at the investor\'s slab rate.',
    ],
  },
  {
    topic: 'dividends',
    title: 'Dividends (IDCW) from any mutual fund',
    rules: [
      'Taxed at the investor\'s slab rate as income from other sources.',
      'The fund deducts TDS of 10% when dividends from it exceed ₹10,000 in a financial year (s. 194K).',
    ],
  },
  {
    topic: 'general',
    title: 'General points',
    rules: [
      'Each SIP instalment is a separate purchase, so its holding period runs from its own date (first in, first out on redemption).',
      'A switch between schemes, or between plans of the same scheme, is a redemption and is taxed.',
      'Surcharge on gains taxed under ss. 111A and 112A is capped at 15%.',
    ],
  },
];

export const TAX_REVIEW_NOTE = 'Rates can change in each Union Budget, and from 1 April 2026 the Income-tax Act, 2025 replaces the 1961 Act with new section numbers; confirm the current year\'s rates on incometax.gov.in before advising.';

// The rules as text: all of them, or only the topics named.
export function taxRulesText(topics = []) {
  const want = topics.length ? TAX_RULES.filter((r) => topics.includes(r.topic) || r.topic === 'general') : TAX_RULES;
  return [
    `Rules as of: ${TAX_AS_OF}.`,
    ...want.flatMap((r) => [`${r.title}:`, ...r.rules.map((x) => `- ${x}`)]),
    TAX_REVIEW_NOTE,
  ].join('\n');
}
