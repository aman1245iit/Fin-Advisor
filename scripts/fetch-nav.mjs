// Downloads historical NAV for each scheme in the fund universe (by AMFI scheme code)
// and cross-checks the latest NAV against AMFI's official NAVAll.txt.
import fs from 'node:fs';
import path from 'node:path';
import { UNIVERSE } from '../src/engine/universe.js';

const root = path.resolve(import.meta.dirname, '..');
const navDir = path.join(root, 'data', 'nav');
fs.mkdirSync(navDir, { recursive: true });

// Parse AMFI NAVAll.txt. Current format:
// Scheme Code;ISIN Growth;ISIN Reinvestment;Scheme Name;Plan;Option;NAV;Date
// (older files had no Plan/Option columns, so NAV and date are read from the end).
const amfi = new Map();
const amfiFile = path.join(root, 'data', 'raw', 'NAVAll.txt');
if (process.argv.includes('--refresh') || !fs.existsSync(amfiFile)) {
  const r = await fetch('https://portal.amfiindia.com/spages/NAVAll.txt');
  fs.writeFileSync(amfiFile, await r.text());
}
for (const line of fs.readFileSync(amfiFile, 'utf8').split(/\r?\n/)) {
  const f = line.split(';');
  if (f.length >= 6 && /^\d+$/.test(f[0])) {
    amfi.set(f[0], { name: f[3], plan: f.length >= 8 ? f[4] : null, option: f.length >= 8 ? f[5] : null, nav: Number(f.at(-2)), date: f.at(-1) });
  }
}

async function getJson(url, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await (await fetch(url, { signal: AbortSignal.timeout(60000) })).json(); }
    catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
}

const refresh = process.argv.includes('--refresh');
const report = [];
for (const fund of UNIVERSE) {
  const cached = path.join(navDir, `${fund.code}.json`);
  const j = !refresh && fs.existsSync(cached)
    ? (({ schemeName, series }) => ({ meta: { scheme_name: schemeName }, data: series.map(([d, v]) => ({ date: d.split('-').reverse().join('-'), nav: v })) }))(JSON.parse(fs.readFileSync(cached, 'utf8')))
    : await getJson(`https://api.mfapi.in/mf/${fund.code}`);
  // mfapi returns newest-first with dd-mm-yyyy dates; store ascending ISO.
  const series = j.data
    .map((d) => { const [dd, mm, yy] = d.date.split('-'); return [`${yy}-${mm}-${dd}`, Number(d.nav)]; })
    .filter(([, v]) => Number.isFinite(v) && v > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const official = amfi.get(String(fund.code));
  const last = series.at(-1);
  const match = official ? Math.abs(official.nav - last[1]) / official.nav < 0.001 : null;
  fs.writeFileSync(path.join(navDir, `${fund.code}.json`), JSON.stringify({ code: fund.code, schemeName: j.meta?.scheme_name, amfiName: official?.name, series }));
  report.push({ code: fund.code, name: fund.name, first: series[0][0], last: last[0], points: series.length, amfiPlan: official?.plan, amfiOption: official?.option, amfiNav: official?.nav, amfiDate: official?.date, mirrorNav: last[1], matchesAmfi: match });
  console.log(fund.code, series[0][0], '→', last[0], series.length, 'pts', match === false ? 'MISMATCH vs AMFI' : 'ok');
}
fs.writeFileSync(path.join(root, 'data', 'nav-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), report }, null, 1));
