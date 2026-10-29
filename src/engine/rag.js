// Research engine: retrieval over official fund documents with page-level citations.
//
// Retrieval: BM25 over ~700-character chunks of each PDF page, boosted toward the pages of the
// fund the question is about, with a small synonym table so "exit load" also finds
// "redemption charges" etc. The extractive answer (no language model) returns structured
// facts, a fund comparison table when several funds are named, and quoted passages — each with
// a source page. The AI assistant (assistant.js) uses the same functions as its tools.
//
// Documents the adviser uploads are extracted to page text and added to the index at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { DOCUMENTS, docById, docUrl, localDocUrl, saveUserDocs, DOCS_DIR } from './sources.js';
import { UNIVERSE } from './universe.js';
import { fundRecord } from './funds.js';
import { detectGuaranteeRequest, GUARANTEE_RESPONSE } from './guardrails.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const userCorpusFile = path.join(root, 'data', 'user-corpus.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const baseCorpus = JSON.parse(fs.readFileSync(path.join(root, 'data', 'corpus.json'), 'utf8'));
let userCorpus = readJson(userCorpusFile, []).filter((p) => docById(p.doc));
const corpus = () => [...baseCorpus, ...userCorpus];

const STOP = new Set(('the a an of and or to in on for is are was be by with as at from this that it its what which who how does do fund funds scheme plan direct regular growth option ' +
  'me tell about show give please explain simply briefly kindly describe detail details know want can could would should you i my us our we whats much many any some there here also just').split(' '));
export const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9.%]+/g) || []).map((w) => w.replace(/\.$/, '')).filter((w) => w && !STOP.has(w));

// Query expansion: documents use formal wording that advisers' questions often don't.
const SYNONYMS = [
  [/exit load|exit charge/i, ['exit', 'load', 'redemption', 'redeemed', 'switch']],
  [/objective|aim|goal of the/i, ['investment', 'objective']],
  [/risk[- ]?o?meter|risk level|how risky/i, ['riskometer', 'risk', 'moderately', 'very', 'high']],
  [/lock[- ]?in/i, ['lock', 'lockin']],
  [/minimum (investment|amount|sip)|min(\.|imum)? sip/i, ['minimum', 'application', 'amount', 'sip', 'additional']],
  [/holding|portfolio|top (stocks|companies)|invests? in/i, ['portfolio', 'holdings', 'equity', 'net', 'assets']],
  [/large ?cap|mid ?cap|small ?cap/i, ['large', 'mid', 'small', 'cap', 'companies', 'market', 'capitalization']],
  [/tax|taxation|capital gains/i, ['tax', 'capital', 'gains', 'taxation']],
  [/foreign|overseas|international|global/i, ['foreign', 'overseas', 'securities', 'international']],
];
const expand = (q) => SYNONYMS.filter(([re]) => re.test(q)).flatMap(([, ws]) => ws);

// ---- Chunking & index (rebuilt when documents are added or removed) ----
const CHUNK = 700, OVERLAP = 150;
let chunks = [], df = new Map(), avgLen = 1;
function buildIndex() {
  chunks = [];
  for (const p of corpus()) {
    const text = p.text;
    for (let start = 0; start < Math.max(text.length, 1); start += CHUNK - OVERLAP) {
      const body = text.slice(start, start + CHUNK);
      if (body.trim().length < 40) continue;
      chunks.push({ id: chunks.length, doc: p.doc, page: p.page, text: body, tokens: tokenize(body) });
      if (start + CHUNK >= text.length) break;
    }
  }
  df = new Map();
  for (const c of chunks) for (const w of new Set(c.tokens)) df.set(w, (df.get(w) || 0) + 1);
  avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / (chunks.length || 1);
}
buildIndex();
const idf = (w) => Math.log(1 + (chunks.length - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));

function bm25(qTokens, c, k1 = 1.2, b = 0.75) {
  const tf = new Map();
  for (const w of c.tokens) tf.set(w, (tf.get(w) || 0) + 1);
  let s = 0;
  for (const w of qTokens) {
    const f = tf.get(w);
    if (f) s += idf(w) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / avgLen)));
  }
  return s;
}

// ---- Fund detection: which pages belong to which fund ----
const GENERIC = new Set(['fund', 'india', 'nippon', 'parag', 'parikh', 'plan', 'index', '-', 'nifty']);
const fundPages = new Map();
for (const f of UNIVERSE) {
  const pages = new Set([`${f.doc}:${f.page}`, `${f.doc}:${f.page + 1}`, `${f.doc}:${f.page + 2}`]);
  if (f.code === 122639) for (let p = 1; p <= 66; p++) pages.add(`ppfcf-sid:${p}`);
  if (f.code === 154155) for (let p = 1; p <= 88; p++) pages.add(`pplcf-sid:${p}`);
  fundPages.set(f.code, pages);
}

export function detectFunds(question, contextCodes = []) {
  const q = question.toLowerCase();
  // Regulatory / definitional questions are about categories, not a specific scheme.
  if (/\bsebi\b|categori[sz]|definition|define|regulat|circular/.test(q) && !/compare|\bvs\b|versus/.test(q)) return [];
  const amcNamed = /nippon|parag|ppfas/.test(q);
  const all = UNIVERSE.map((f) => {
    const name = f.name.toLowerCase();
    const distinctive = tokenize(name).filter((w) => !GENERIC.has(w));
    let score = distinctive.filter((w) => q.includes(w)).length / (distinctive.length || 1);
    if (q.includes(name.replace(' fund', ''))) score += 1;
    if (/parag|ppfas/.test(q) && f.amc === 'PPFAS') score += 0.5;
    if (/nippon/.test(q) && f.amc === 'Nippon India') score += 0.5;
    if (/nifty 50|nifty50/.test(q) && f.code === 118741) score += 0.6;
    if (/midcap 150|mid cap 150/.test(q) && f.code === 148726) score += 0.6;
    if (/smallcap 250|small cap 250/.test(q) && f.code === 148519) score += 0.6;
    const full = distinctive.length > 0 && distinctive.every((w) => q.includes(w)) && (!amcNamed || (f.amc === 'PPFAS' ? /parag|ppfas/ : /nippon/).test(q));
    return { f, score, full };
  }).sort((a, b) => b.score - a.score);
  // Comparisons: every fund whose full distinctive name is present.
  if (/compare|\bvs\.?\b|versus|difference between|better/.test(q)) {
    const many = all.filter((x) => x.full).map((x) => x.f.code);
    if (many.length >= 2) return many.slice(0, 4);
  }
  // A partial name match counts only when exactly one fund has it (e.g. "the gold fund").
  const partial = all.filter((x) => x.score >= 0.5);
  const scored = all.filter((x) => x.score >= 0.99);
  if (!scored.length && partial.length === 1) scored.push(partial[0]);
  if (scored.length) {
    const top = scored[0].score;
    let best = scored.filter((x) => x.score >= top - 0.01).map((x) => x.f.code);
    // Without an AMC name, "large cap" etc. is ambiguous: prefer funds on the client's shortlist.
    if (!amcNamed && best.length > 1) {
      const onPlan = best.filter((c) => contextCodes.includes(c));
      best = onPlan.length ? onPlan : best;
    }
    return best.slice(0, 3);
  }
  // "these funds", "my shortlist" etc. → the funds on the current plan.
  if (/these|shortlist|recommended|selected|portfolio|my funds|client'?s funds/.test(q)) return contextCodes;
  return [];
}
// Follow-ups like "what about its exit load?" refer to the funds of the previous question.
const isFollowUp = (q) => /\b(it|its|this fund|that fund|the fund|them|their|those|same fund)\b/i.test(q);

export function retrieve(question, { fundCodes = [], k = 4, docId = null } = {}) {
  // When the fund is known, its pages are boosted, so its name words would only pull matches
  // toward page headers; score on the remaining (topic) words instead.
  const nameWords = new Set(fundCodes.flatMap((c) => tokenize(UNIVERSE.find((u) => u.code === c)?.name ?? '')).concat(['nippon', 'india', 'parag', 'parikh']));
  const topic = tokenize(question).filter((w) => !nameWords.has(w));
  const base = topic.length ? topic : tokenize(question);
  const qt = [...base, ...expand(question).filter((w) => !base.includes(w))];
  const allowed = new Set(fundCodes.flatMap((c) => [...(fundPages.get(c) || [])]));
  let scored = chunks.filter((c) => !docId || c.doc === docId).map((c) => {
    let s = bm25(base, c) + 0.35 * bm25(qt.filter((w) => !base.includes(w)), c);
    if (allowed.size && allowed.has(`${c.doc}:${c.page}`)) s *= 2.5;
    return { c, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  // A named fund's own pages win; other pages are used only if the fund's pages have no match.
  if (allowed.size) {
    const own = scored.filter((x) => allowed.has(`${x.c.doc}:${x.c.page}`) && x.s > 4);
    if (own.length) scored = own;
  }
  // Keep at most one chunk per page so citations are diverse.
  const seen = new Set(), out = [];
  for (const x of scored) {
    const key = `${x.c.doc}:${x.c.page}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(x);
    if (out.length >= k) break;
  }
  // Coverage: share of the question's IDF weight present in the chunk. Low coverage means the
  // documents only share generic words with the question.
  const qset = [...new Set(base)];
  const totalIdf = qset.reduce((a, w) => a + idf(w), 0) || 1;
  return out.map(({ c, s }) => {
    const d = docById(c.doc);
    const have = new Set(c.tokens);
    const coverage = qset.filter((w) => have.has(w)).reduce((a, w) => a + idf(w), 0) / totalIdf;
    return { doc: c.doc, page: c.page, score: s, coverage, title: d.title, docType: d.type, url: docUrl(d, c.page), localUrl: localDocUrl(d, c.page), excerpt: bestLines(c.text, qt), terms: qset };
  });
}

function bestLines(text, qt) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 3);
  const scoredLines = lines.map((l, i) => ({ i, s: tokenize(l).filter((w) => qt.includes(w)).length }));
  const best = scoredLines.sort((a, b) => b.s - a.s)[0]?.i ?? 0;
  return lines.slice(Math.max(0, best - 2), best + 4).join(' · ');
}

// ---- Structured facts from fund metadata (each with its factsheet page) ----
const INTENTS = [
  { key: 'ter', re: /expense|\bter\b|cost|charges?|fee/i },
  { key: 'aum', re: /\baum\b|size|assets under|corpus of the fund/i },
  { key: 'manager', re: /manager|managed|manages|who runs/i },
  { key: 'benchmark', re: /benchmark|index/i },
  { key: 'tracking', re: /tracking/i },
  { key: 'returns', re: /return|performance|cagr|drawdown|fell|volatil/i },
];
const p = (x) => (x == null ? 'n/a (insufficient history)' : (x * 100).toFixed(2) + '%');

export function fundFacts(code, question = '', { all = false } = {}) {
  const f = fundRecord(UNIVERSE.find((u) => u.code === code));
  const src = f.sources[0];
  const out = [];
  const want = INTENTS.filter((i) => i.re.test(question)).map((i) => i.key);
  // "Tell me about X" gets the key facts; specific questions get only the matching fact.
  all ||= want.length === 0 && /about|overview|summary|details|key facts/i.test(question);
  if (all || want.includes('ter')) out.push({ text: `${f.name} (Direct): total expense ratio ${f.expenseRatio}%.`, source: src });
  if (all || want.includes('aum')) out.push({ text: `${f.name}: AUM ₹${f.aumCr?.toLocaleString('en-IN')} Cr.`, source: src });
  if (all || want.includes('manager')) out.push({ text: `${f.name}: fund manager(s) ${f.managers.join(', ')}; lead manager since ${f.managerSince?.slice(0, 7)}.`, source: src });
  if (all || want.includes('benchmark')) out.push({ text: `${f.name}: benchmark ${f.benchmark}.`, source: src });
  if ((all && f.passive) || want.includes('tracking')) out.push({ text: f.trackingError1y != null ? `${f.name}: tracking error ${f.trackingError1y}% (1y), ${f.trackingError3y}% (3y).` : `${f.name}: tracking error is not applicable/not reported for this actively managed scheme.`, source: src });
  if ((all || want.includes('returns')) && f.metrics) {
    const m = f.metrics;
    out.push({ text: `${f.name} direct plan (computed from AMFI NAV history to ${m.asOf}): CAGR 1y ${p(m.cagr['1y'])}, 3y ${p(m.cagr['3y'])}, 5y ${p(m.cagr['5y'])}, 10y ${p(m.cagr['10y'])}; max drawdown over ${m.window} ${p(m.maxDrawdown)}. Past performance does not guarantee future returns.`, source: f.sources[2], computed: true });
  }
  return out;
}

export function compareFunds(codes) {
  return codes.map((code) => {
    const f = fundRecord(UNIVERSE.find((u) => u.code === code));
    const m = f.metrics ?? { cagr: {} };
    return {
      code, name: f.name, amc: f.amc, category: f.category, passive: !!f.passive,
      ter: f.expenseRatio, aumCr: f.aumCr, benchmark: f.benchmark,
      managers: f.managers, managerSince: f.managerSince, trackingError1y: f.trackingError1y,
      cagr1y: m.cagr['1y'] ?? null, cagr3y: m.cagr['3y'] ?? null, cagr5y: m.cagr['5y'] ?? null, cagr10y: m.cagr['10y'] ?? null,
      maxDrawdown: m.maxDrawdown ?? null, volatility: m.volatility ?? null, window: m.window ?? null, asOf: m.asOf ?? null,
      source: f.sources[0], navSource: f.sources[2],
    };
  });
}

export const findFund = (name) => {
  const q = name.toLowerCase();
  const exact = UNIVERSE.find((u) => u.name.toLowerCase() === q || String(u.code) === q);
  if (exact) return exact;
  const codes = detectFunds(name);
  return codes.length ? UNIVERSE.find((u) => u.code === codes[0]) : null;
};
export const fundList = () => UNIVERSE.map((u) => ({ code: u.code, name: u.name, amc: u.amc, category: u.category, sleeve: u.sleeve, passive: !!u.passive }));

// ---- Extractive answer (no language model) ----
export function unknownTerms(question) {
  const qset = [...new Set(tokenize(question))];
  const unknown = qset.filter((w) => w.length >= 4 && !/^\d/.test(w) && !df.has(w));
  const share = unknown.reduce((a, w) => a + idf(w), 0) / (qset.reduce((a, w) => a + idf(w), 0) || 1);
  return { unknown, share };
}

export async function answer(question, { contextCodes = [], previousCodes = [], draft = null } = {}) {
  if (detectGuaranteeRequest(question)) {
    return { type: 'guardrail', answer: GUARANTEE_RESPONSE, facts: [], passages: [], mode: 'guardrail' };
  }
  let fundCodes = detectFunds(question, contextCodes);
  let followUp = false;
  if (!fundCodes.length && previousCodes.length && isFollowUp(question)) { fundCodes = previousCodes; followUp = true; }
  const comparing = fundCodes.length >= 2 && /compare|\bvs\.?\b|versus|difference|better|which (one|is)/i.test(question);
  const facts = comparing ? [] : fundCodes.flatMap((c) => fundFacts(c, question));
  // Case-aware: "why was X chosen" answers from the draft's screening explanation.
  if (draft && /why|chosen|selected|picked|recommend/i.test(question)) {
    for (const s of draft.funds ?? []) {
      if (s.selected && fundCodes.includes(s.selected.code)) facts.unshift({ text: `Why ${s.selected.name} was shortlisted in ${s.label}: ${s.selected.explanation}`, source: { label: 'Screening engine (this case, draft v' + (draft.version ?? '') + ')', url: '#/funds' }, computed: true });
    }
  }
  const passages = retrieve(question, { fundCodes });
  // Terms that never occur in the corpus: if they carry much of the question's weight, the
  // documents cannot answer it, however well the generic words match.
  const { unknown, share } = unknownTerms(question);
  const relevant = share >= 0.4 ? [] : passages.filter((x) => x.score > 4 && x.coverage >= 0.5);
  const comparison = comparing ? compareFunds(fundCodes) : null;
  if (!facts.length && !relevant.length && !comparison) {
    const missing = unknown.length ? ` The documents never mention: ${unknown.join(', ')}.` : '';
    return { type: 'not_found', answer: `I could not find this in the loaded documents (AMC factsheets, SIDs, SEBI circulars and any you uploaded).${missing} I will not answer from memory. Try naming a fund from the universe, or upload the relevant document in the library.`, facts: [], passages: [], mode: 'extractive' };
  }
  return {
    type: 'answer',
    fundsDetected: fundCodes.map((c) => UNIVERSE.find((u) => u.code === c).name),
    fundCodes, followUp,
    answer: comparison ? `Side-by-side comparison of ${comparison.map((c) => c.name).join(' and ')} from factsheet data and AMFI NAV history.` : null,
    comparison,
    facts,
    passages: relevant,
    mode: 'extractive', note: null,
  };
}

// ---- Document library ----
export const corpusStats = () => ({
  documents: DOCUMENTS.map((d) => {
    const pages = corpus().filter((p) => p.doc === d.id);
    return {
      ...d, url: docUrl(d), localUrl: localDocUrl(d), pages: pages.length,
      chunks: chunks.filter((c) => c.doc === d.id).length,
      words: pages.reduce((s, p) => s + (p.text.match(/\S+/g)?.length ?? 0), 0),
      funds: UNIVERSE.filter((u) => u.doc === d.id || (fundPages.get(u.code) && [...fundPages.get(u.code)].some((k) => k.startsWith(d.id + ':')))).map((u) => u.name),
      localAvailable: fs.existsSync(path.join(DOCS_DIR, d.file)),
    };
  }),
  chunks: chunks.length,
});

// Full-text search for the library: page-level hits with a highlighted-ready snippet.
export function searchDocuments(q, { docId = null, limit = 20 } = {}) {
  const hits = retrieve(q, { k: limit, docId });
  return hits.map((h) => ({ doc: h.doc, title: h.title, docType: h.docType, page: h.page, url: h.url, localUrl: h.localUrl, excerpt: h.excerpt, score: +h.score.toFixed(2), terms: h.terms }));
}

export function pageText(docId, page) {
  const pg = corpus().find((p) => p.doc === docId && p.page === +page);
  const d = docById(docId);
  return pg && d ? { doc: docId, title: d.title, page: +page, text: pg.text, url: docUrl(d, page) } : null;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'document';

// Add an uploaded PDF: save it, extract page text, register it and rebuild the index.
export async function addDocument(buffer, { title, type = 'Other', publisher = 'Uploaded by adviser', asOf = null, sourceUrl = '' }) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(buffer), verbosity: 0 }).promise;
  const base = slug(title);
  let id = `user-${base}`, n = 2;
  while (docById(id)) id = `user-${base}-${n++}`;
  const pages = [];
  for (let pn = 1; pn <= pdf.numPages; pn++) {
    const tc = await (await pdf.getPage(pn)).getTextContent();
    const lines = new Map();
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      lines.set(y, (lines.get(y) || '') + it.str + (it.hasEOL ? '' : ' '));
    }
    const text = [...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, t]) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    pages.push({ doc: id, page: pn, text });
  }
  const textChars = pages.reduce((s, x) => s + x.text.length, 0);
  if (textChars < 200) throw Object.assign(new Error('No extractable text found in this PDF (it may be a scanned image). Upload a text-based PDF.'), { status: 422 });
  const file = `${id}.pdf`;
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, file), buffer);
  const doc = { id, file, title, publisher, type, asOf, url: sourceUrl || '', uploaded: true, uploadedAt: new Date().toISOString() };
  DOCUMENTS.push(doc);
  saveUserDocs();
  userCorpus = [...userCorpus, ...pages];
  fs.writeFileSync(userCorpusFile, JSON.stringify(userCorpus));
  buildIndex();
  return { ...doc, pages: pages.length };
}

export function removeDocument(id) {
  const i = DOCUMENTS.findIndex((d) => d.id === id);
  if (i < 0) return { status: 404, error: 'not found' };
  if (!DOCUMENTS[i].uploaded) return { status: 403, error: 'Built-in official documents cannot be removed.' };
  const [d] = DOCUMENTS.splice(i, 1);
  saveUserDocs();
  userCorpus = userCorpus.filter((p) => p.doc !== id);
  fs.writeFileSync(userCorpusFile, JSON.stringify(userCorpus));
  try { fs.unlinkSync(path.join(DOCS_DIR, d.file)); } catch {}
  buildIndex();
  return { status: 200, removed: id };
}
