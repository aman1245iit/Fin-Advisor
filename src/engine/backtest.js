// 10-year backtest of the recommended mix using monthly direct-plan NAVs.
//
// Method
//  • Monthly periods; each fund's NAV is the last NAV on or before the month end
//    (only data available at that date is used; NAVs staler than 10 days count as missing).
//  • Portfolio return each month: R_p = Σ w_i R_i with drifting weights.
//  • Rebalanced back to target weights every 12 months (annual schedule).
//  • NAVs are already net of each scheme's expense ratio; exit loads, taxes and
//    transaction costs of rebalancing are NOT modelled.
//  • If the selected fund has no NAV for a month (launched later), the longest-history
//    eligible fund in the same sleeve is used for that month and the substitution is disclosed.
import { navSeries, navAt, monthEnds, maxDrawdown } from './funds.js';

const NIFTY50_INDEX_FUND = 118741;
const LIQUID_REFERENCE = 118701;
const EQUITY_SLEEVES = ['largecap', 'flexicap', 'midcap', 'smallcap'];

function monthlyReturns(code, dates) {
  const s = navSeries(code);
  const v = dates.map((d) => navAt(s, d));
  return dates.slice(1).map((_, i) => (v[i] && v[i + 1] ? v[i + 1] / v[i] - 1 : null));
}

function simulate(sleeves, dates, rebalanceEvery = 12, start = 100000) {
  // sleeves: [{ key, weight (0-1), returns: [] }]
  let holdings = sleeves.map((s) => start * s.weight);
  const values = [start];
  for (let m = 0; m < dates.length - 1; m++) {
    holdings = holdings.map((h, i) => h * (1 + sleeves[i].returns[m]));
    const total = holdings.reduce((a, b) => a + b, 0);
    values.push(total);
    if ((m + 1) % rebalanceEvery === 0) holdings = sleeves.map((s) => total * s.weight);
  }
  return values;
}

function stats(values, dates) {
  const years = (dates.length - 1) / 12;
  const rets = values.slice(1).map((v, i) => v / values[i] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(12);
  const yearly = [];
  for (let i = 12; i < values.length; i += 12) yearly.push({ end: dates[i], ret: values[i] / values[i - 12] - 1 });
  return {
    cumulative: values.at(-1) / values[0] - 1,
    cagr: Math.pow(values.at(-1) / values[0], 1 / years) - 1,
    volatility: vol,
    maxDrawdown: maxDrawdown(values),
    worstYear: Math.min(...yearly.map((y) => y.ret)),
    bestYear: Math.max(...yearly.map((y) => y.ret)),
    yearly,
    endValue: values.at(-1),
  };
}

export function backtest(shortlistResult, years = 10) {
  const endIso = navSeries(NIFTY50_INDEX_FUND).at(-1)[0];
  const dates = monthEnds(endIso, years * 12);
  const totalW = shortlistResult.reduce((s, x) => s + x.weight, 0) || 1;
  const limitations = [];
  const coverage = [];

  const sleeves = shortlistResult.filter((x) => x.selected).map((x) => {
    const selected = x.selected;
    const own = monthlyReturns(selected.code, dates);
    // Proxy: eligible peer with the earliest first NAV.
    const proxy = [...x.eligible].sort((a, b) => (a.metrics.firstNav < b.metrics.firstNav ? -1 : 1))[0];
    const proxyRets = proxy.code !== selected.code ? monthlyReturns(proxy.code, dates) : own;
    let proxied = 0, missing = 0;
    const returns = own.map((r, i) => {
      if (r != null) return r;
      if (proxyRets[i] != null) { proxied++; return proxyRets[i]; }
      missing++; return 0;
    });
    coverage.push({ sleeve: x.label, fund: selected.name, firstNav: selected.metrics.firstNav, ownMonths: own.length - proxied - missing, proxyMonths: proxied, proxyFund: proxied ? proxy.name : null, missingMonths: missing });
    if (proxied) limitations.push(`${selected.name} has direct-plan NAVs only from ${selected.metrics.firstNav}; for ${proxied} earlier months the backtest uses ${proxy.name} (same sleeve) as a disclosed proxy.`);
    if (missing) limitations.push(`${missing} months in the ${x.label} sleeve had no NAV from the fund or its proxy and were treated as a 0% return.`);
    return { key: x.sleeve, label: x.label, fund: selected.name, weight: x.weight / totalW, returns };
  });

  const portfolio = simulate(sleeves, dates);
  const equityW = sleeves.filter((s) => EQUITY_SLEEVES.includes(s.key)).reduce((a, s) => a + s.weight, 0);
  const niftyRets = monthlyReturns(NIFTY50_INDEX_FUND, dates);
  const liquidRets = monthlyReturns(LIQUID_REFERENCE, dates);
  const nifty = simulate([{ weight: 1, returns: niftyRets }], dates);
  const reference = simulate([{ weight: equityW, returns: niftyRets }, { weight: 1 - equityW, returns: liquidRets }], dates);

  limitations.push(
    'Survivorship bias: the universe contains schemes that exist today; merged or closed schemes are not included, which can flatter historical results.',
    'Look-ahead in selection: funds are shortlisted using today\'s metrics and then backtested over the past, so the backtest is an illustration of the mix, not a test of the selection process.',
    'Benchmarks are investable proxies (Nippon India Index Fund – Nifty 50 direct plan and Nippon India Liquid Fund direct plan), so they include those funds\' own costs; index TRI data was not used.',
    'Exit loads, capital-gains tax and rebalancing transaction costs are not deducted. Past performance does not guarantee future returns.',
  );

  return {
    method: 'Monthly NAVs, R_p = Σ wᵢRᵢ, annual rebalancing to target weights, start value ₹1,00,000. Direct-plan NAVs are net of expense ratios.',
    period: { start: dates[0], end: endIso, months: dates.length - 1 },
    weights: sleeves.map((s) => ({ sleeve: s.label, fund: s.fund, weight: s.weight })),
    series: dates.map((d, i) => ({ date: d, portfolio: portfolio[i], nifty50: nifty[i], reference: reference[i] })),
    stats: { portfolio: stats(portfolio, dates), nifty50: stats(nifty, dates), reference: stats(reference, dates) },
    benchmarks: {
      nifty50: 'Nifty 50 (via Nippon India Index Fund – Nifty 50 Plan, direct)',
      reference: `Passive reference: ${(equityW * 100).toFixed(0)}% Nifty 50 index fund + ${((1 - equityW) * 100).toFixed(0)}% liquid fund, same rebalancing`,
    },
    coverage, limitations,
  };
}
