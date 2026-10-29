// The screened fund universe: a manageable set of direct-plan growth schemes taken from
// AMFI's scheme list. `code` is the AMFI scheme code; `doc`/`page` point to the official
// factsheet page that the metadata (in fund-meta.json) was taken from.
//
// `category` follows SEBI's scheme categorisation; `sleeve` maps it to the allocation engine.
export const UNIVERSE = [
  // Large cap / Nifty 50
  { code: 118741, name: 'Nippon India Index Fund - Nifty 50 Plan', amc: 'Nippon India', category: 'Index Fund (Nifty 50)', sleeve: 'largecap', passive: true, benchmark: 'Nifty 50 TRI', doc: 'nippon-fs-2026-10', page: 129 },
  { code: 118632, name: 'Nippon India Large Cap Fund', amc: 'Nippon India', category: 'Large Cap', sleeve: 'largecap', benchmark: 'BSE 100 TRI', doc: 'nippon-fs-2026-10', page: 6 },
  { code: 154155, name: 'Parag Parikh Large Cap Fund', amc: 'PPFAS', category: 'Large Cap', sleeve: 'largecap', benchmark: 'NIFTY 100 TRI', doc: 'ppfas-fs-2026-09', page: 10 },
  // Flexi / multi cap
  { code: 122639, name: 'Parag Parikh Flexi Cap Fund', amc: 'PPFAS', category: 'Flexi Cap', sleeve: 'flexicap', benchmark: 'Nifty 500 TRI', doc: 'ppfas-fs-2026-09', page: 2 },
  { code: 149094, name: 'Nippon India Flexi Cap Fund', amc: 'Nippon India', category: 'Flexi Cap', sleeve: 'flexicap', benchmark: 'Nifty 500 TRI', doc: 'nippon-fs-2026-10', page: 30 },
  { code: 118650, name: 'Nippon India Multi Cap Fund', amc: 'Nippon India', category: 'Multi Cap', sleeve: 'flexicap', benchmark: 'NIFTY 500 Multicap 50:25:25 TRI', doc: 'nippon-fs-2026-10', page: 27 },
  // Mid cap
  { code: 118668, name: 'Nippon India Growth Mid Cap Fund', amc: 'Nippon India', category: 'Mid Cap', sleeve: 'midcap', benchmark: 'NIFTY Midcap 150 TRI', doc: 'nippon-fs-2026-10', page: 15 },
  { code: 148726, name: 'Nippon India Nifty Midcap 150 Index Fund', amc: 'Nippon India', category: 'Index Fund (Nifty Midcap 150)', sleeve: 'midcap', passive: true, benchmark: 'Nifty Midcap 150 TRI', doc: 'nippon-fs-2026-10', page: 138 },
  // Small cap
  { code: 118778, name: 'Nippon India Small Cap Fund', amc: 'Nippon India', category: 'Small Cap', sleeve: 'smallcap', benchmark: 'Nifty Smallcap 250 TRI', doc: 'nippon-fs-2026-10', page: 21 },
  { code: 148519, name: 'Nippon India Nifty Smallcap 250 Index Fund', amc: 'Nippon India', category: 'Index Fund (Nifty Smallcap 250)', sleeve: 'smallcap', passive: true, benchmark: 'Nifty Smallcap 250 TRI', doc: 'nippon-fs-2026-10', page: 135 },
  // Hybrid
  { code: 118736, name: 'Nippon India Balanced Advantage Fund', amc: 'Nippon India', category: 'Balanced Advantage', sleeve: 'hybrid', benchmark: 'CRISIL Hybrid 50+50 - Moderate Index', doc: 'nippon-fs-2026-10', page: 111 },
  { code: 152468, name: 'Parag Parikh Dynamic Asset Allocation Fund', amc: 'PPFAS', category: 'Dynamic Asset Allocation', sleeve: 'hybrid', benchmark: 'CRISIL Hybrid 50+50 Moderate Index', doc: 'ppfas-fs-2026-09', page: 13 },
  { code: 148958, name: 'Parag Parikh Conservative Hybrid Fund', amc: 'PPFAS', category: 'Conservative Hybrid', sleeve: 'hybrid', benchmark: 'CRISIL Hybrid 85+15 Conservative Index', doc: 'ppfas-fs-2026-09', page: 17 },
  // Debt – short / medium duration
  { code: 118796, name: 'Nippon India Short Term Fund', amc: 'Nippon India', category: 'Short Duration', sleeve: 'debt', benchmark: 'CRISIL Short Duration Debt A-II Index', doc: 'nippon-fs-2026-10', page: 90 },
  { code: 118814, name: 'Nippon India Corporate Bond Fund', amc: 'Nippon India', category: 'Corporate Bond', sleeve: 'debt', benchmark: 'NIFTY Corporate Bond Index A-II', doc: 'nippon-fs-2026-10', page: 81 },
  { code: 134547, name: 'Nippon India Banking and PSU Debt Fund', amc: 'Nippon India', category: 'Banking and PSU', sleeve: 'debt', benchmark: 'CRISIL Banking and PSU Debt A-II Index', doc: 'nippon-fs-2026-10', page: 84 },
  { code: 118672, name: 'Nippon India Gilt Fund', amc: 'Nippon India', category: 'Gilt', sleeve: 'debt', benchmark: 'NIFTY All Duration G-Sec Index', doc: 'nippon-fs-2026-10', page: 108 },
  // Liquid / money market (emergency & near-term goals)
  { code: 118701, name: 'Nippon India Liquid Fund', amc: 'Nippon India', category: 'Liquid', sleeve: 'liquid', benchmark: 'NIFTY Liquid Index A-I', doc: 'nippon-fs-2026-10', page: 69 },
  { code: 143269, name: 'Parag Parikh Liquid Fund', amc: 'PPFAS', category: 'Liquid', sleeve: 'liquid', benchmark: 'CRISIL Liquid Debt A-I Index', doc: 'ppfas-fs-2026-09', page: 24 },
  { code: 118719, name: 'Nippon India Money Market Fund', amc: 'Nippon India', category: 'Money Market', sleeve: 'liquid', benchmark: 'NIFTY Money Market Index A-I', doc: 'nippon-fs-2026-10', page: 72 },
  { code: 118585, name: 'Nippon India Arbitrage Fund', amc: 'Nippon India', category: 'Arbitrage', sleeve: 'liquid', benchmark: 'Nifty 50 Arbitrage Index', doc: 'nippon-fs-2026-10', page: 120 },
  { code: 152109, name: 'Parag Parikh Arbitrage Fund', amc: 'PPFAS', category: 'Arbitrage', sleeve: 'liquid', benchmark: 'Nifty 50 Arbitrage TRI', doc: 'ppfas-fs-2026-09', page: 21 },
  // Gold
  { code: 118663, name: 'Nippon India Gold Savings Fund', amc: 'Nippon India', category: 'Gold FoF', sleeve: 'gold', benchmark: 'Domestic Price of Gold', doc: 'nippon-fs-2026-10', page: 285 },
];

export const SLEEVES = {
  largecap: { label: 'Large cap equity', asset: 'equity' },
  flexicap: { label: 'Flexi / multi cap equity', asset: 'equity' },
  midcap: { label: 'Mid cap equity', asset: 'equity' },
  smallcap: { label: 'Small cap equity', asset: 'equity' },
  hybrid: { label: 'Hybrid', asset: 'hybrid' },
  debt: { label: 'Short/medium duration debt', asset: 'debt' },
  liquid: { label: 'Liquid / arbitrage', asset: 'debt' },
  gold: { label: 'Gold', asset: 'gold' },
};
