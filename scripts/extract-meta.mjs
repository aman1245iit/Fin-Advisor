// Extracts fund metadata (direct-plan TER, AUM, fund managers, managing-since, inception,
// tracking error) from the official factsheet pages listed in the universe.
// Every value is stored with the document id + page it came from. Values that cannot be
// parsed are stored as null so the screener can exclude the fund for missing data.
import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { UNIVERSE } from '../src/engine/universe.js';
import { docById } from '../src/engine/sources.js';

const root = path.resolve(import.meta.dirname, '..');

// PPFAS factsheets print "AUM as on …:" and its value as separate text runs on the same row,
// so the value is matched by y-position (the flattened text order is not reliable).
const pdfs = {};
async function aumByPosition(docId, page) {
  pdfs[docId] ??= await getDocument({ data: new Uint8Array(fs.readFileSync(path.join(root, 'data', 'docs', docById(docId).file))), verbosity: 0 }).promise;
  const items = (await (await pdfs[docId].getPage(page)).getTextContent()).items
    .map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] })).filter((i) => i.s);
  const label = items.find((i) => /^AUM as on/.test(i.s));
  if (!label) return null;
  const value = items.find((i) => /Crores/.test(i.s) && Math.abs(i.y - label.y) <= 2 && i.x > label.x);
  return value?.s.match(/([\d,]+\.\d+)/)?.[1] ?? null;
}
const corpus = JSON.parse(fs.readFileSync(path.join(root, 'data', 'corpus.json'), 'utf8'));
const pageText = (doc, page) => corpus.find((p) => p.doc === doc && p.page === page)?.text ?? '';
const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const toIso = (s) => { const d = new Date(s + ' UTC'); return Number.isNaN(+d) ? null : d.toISOString().slice(0, 10); };

function nippon(t) {
  const lines = t.split('\n');
  const ter = t.match(/^Direct\s+([0-9.]+)\s*%/m)?.[1];
  const aum = t.match(/^AUM:\s*`?\s*([\d,]+\.\d+)\s*Cr/m)?.[1];
  const managers = lines.filter((l) => /^•\s*(Mr|Mrs|Ms)\.\s/.test(l))
    .map((l) => l.replace(/^•\s*/, '').replace(/\s+\d.*$/, '').replace(/\s+Section$/, '').replace(/[\s,]+$/, '').trim());
  // "Managing Since" dates are laid out as "Month YYYY / Month ... YYYY" next to the manager block.
  // The first full "Month YYYY" between "Total Experience" and the minimum-investment block belongs to the lead manager.
  const block = t.slice(t.indexOf('Total Experience'), t.indexOf('Minimum Investment', t.indexOf('Total Experience')) + 1 || undefined);
  let since = block.match(new RegExp(`(${MONTHS})\\s+(\\d{4})`))?.slice(1, 3).join(' ');
  if (!since) {
    const m = block.match(new RegExp(`(${MONTHS})[\\s\\S]{0,40}?(\\d{4})`));
    since = m ? `${m[1]} ${m[2]}` : null;
  }
  const inception = t.match(/Date of Inception[\s\S]{0,80}?(\d{1,2} [A-Z][a-z]+ \d{4})/)?.[1];
  const te1 = t.match(/Tracking Error \(%\)[^\n]*\n(?:[^\n]*\n)?1 Year\s+([0-9.]+)/)?.[1];
  const te3 = t.match(/Tracking Error \(%\)[\s\S]{0,200}?3 Years\s+([0-9.]+)/)?.[1];
  return { ter, aum, managers, since: since ? '1 ' + since : null, inception, te1, te3 };
}

function ppfas(t) {
  const ter = t.match(/Direct Plan:\s*([0-9.]+)\s*%/)?.[1];
  const managers = [...t.matchAll(/^(Mr|Ms|Mrs)\.\s+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/gm)].map((m) => `${m[1]}. ${m[2]}`);
  const sinceRaw = t.match(/Managing Since:\s*([^\n]+)/)?.[1] ?? '';
  const since = /Since Inception/i.test(sinceRaw) ? 'inception' : sinceRaw.match(new RegExp(`(${MONTHS}) \\d{1,2}, \\d{4}`))?.[0];
  const inception = t.match(/([A-Z][a-z]{2} \d{1,2}, \d{4}) Date of Inception/)?.[1] ?? t.match(/Date of Inception \/ Allotment\s+([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1];
  return { ter, managers: [...new Set(managers)], since, inception, te1: null, te3: null };
}

const meta = {};
for (const f of UNIVERSE) {
  const t = pageText(f.doc, f.page) + '\n' + pageText(f.doc, f.page + 1);
  const firstNav = JSON.parse(fs.readFileSync(path.join(root, 'data', 'nav', `${f.code}.json`), 'utf8')).series[0][0];
  const r = f.doc.startsWith('ppfas') ? { ...ppfas(t), aum: await aumByPosition(f.doc, f.page) } : nippon(t);
  const inceptionIso = r.inception ? toIso(r.inception) : null;
  // "Since inception" with no parsable inception date falls back to the first direct-plan NAV in AMFI history.
  const managerSince = r.since === 'inception' ? inceptionIso ?? firstNav : r.since ? toIso(r.since) : null;
  meta[f.code] = {
    expenseRatio: num(r.ter),
    aumCr: num(r.aum),
    managers: r.managers,
    managerSince,
    inception: inceptionIso,
    directPlanFirstNav: firstNav,
    trackingError1y: num(r.te1),
    trackingError3y: num(r.te3),
    source: { doc: f.doc, page: f.page },
  };
}
fs.writeFileSync(path.join(root, 'data', 'fund-meta.json'), JSON.stringify(meta, null, 1));
console.table(Object.entries(meta).map(([code, m]) => ({ code, ter: m.expenseRatio, aum: m.aumCr, mgr: m.managers.join('; ').slice(0, 40), since: m.managerSince, incep: m.inception, te1: m.trackingError1y, te3: m.trackingError3y })));
