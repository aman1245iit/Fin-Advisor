import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { db, audit, now, dbRemote, remoteUrl } from './db.js';
import { runPipeline } from './engine/pipeline.js';
import { corpusStats, searchDocuments, pageText, addDocument, removeDocument } from './engine/rag.js';
import { assistantAnswer, llmEnabled, providers } from './engine/assistant.js';
import { fintelAnswer } from './engine/fintel.js';
import { DOC_TYPES, DOCS_DIR } from './engine/sources.js';
import { allFunds, THRESHOLDS, RANK_WEIGHTS } from './engine/funds.js';
import { CAPACITY_RULES, CAPACITY_BANDS, TOLERANCE_QUESTIONS, TOLERANCE_BANDS } from './engine/risk.js';
import { ASSET_ASSUMPTIONS, ASSET_VOLATILITY, GOAL_TYPES, EQUITY_STRESS_FALL, GLIDE_START, GLIDE_END } from './engine/planner.js';
import { SPECIAL_REQUESTS } from './engine/guardrails.js';
import { renderClientReport, renderBlocked } from './client-report.js';
import { authRouter, authReady, requireAdviser, sessionAdviser } from './auth.js';
import { mailConfigured, sendMail } from './mailer.js';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
const app = express();
// Routes match exactly as written, so /API/cases cannot reach /api/cases past the sign-in check.
app.set('case sensitive routing', true);
app.use(express.json({ limit: '2mb' }));
// Requests wait until the database tables exist (the first request after a cold start on Vercel).
app.use((_req, _res, next) => authReady.then(() => next(), next));
app.use('/api/auth', authRouter);

// Sign-in required for the co-pilot, its data and uploaded documents. Public: the front page,
// the sign-in page, static assets, the fund and document statistics the front page shows, and
// approved client reports (/client/<share token>), which the adviser shares with the client.
// Fintel (the floating help assistant) is public so it can help on the sign-in page; it is rate-limited.
// The contact form is public too, and limited per IP.
const PUBLIC_API = new Set(['GET /api/funds', 'GET /api/docs', 'GET /api/public-stats', 'POST /api/fintel', 'POST /api/contact']);
// The path as the file system sees it: decoded, lower-case (Windows ignores case) and without
// trailing dots or spaces (Windows drops them), so /App.html, /%61pp.html and /app.html. are all
// recognised as the co-pilot page.
function guardPath(raw) {
  try { return decodeURIComponent(raw).toLowerCase().replace(/[.\s]+$/, ''); } catch { return null; }
}
app.use((req, res, next) => {
  const p = guardPath(req.path);
  if (p === null || p.includes(':') || p.includes('\\')) return res.status(400).json({ error: 'Bad request path.' });
  if (p === '/app.html' || p === '/docs' || p.startsWith('/docs/')) return requireAdviser(req, res, next);
  if ((p === '/api' || p.startsWith('/api/')) && !PUBLIC_API.has(`${req.method} ${p}`)) return requireAdviser(req, res, next);
  next();
});
app.use(express.static(PUBLIC_DIR, { caseSensitive: true }));
// Local copies of the source PDFs, so page links work offline and for uploaded documents.
app.use('/docs', express.static(DOCS_DIR, { caseSensitive: true, setHeaders: (res) => res.setHeader('Content-Type', 'application/pdf') }));

const MIN_JUSTIFICATION = 15;
const parse = (row, key) => (row ? JSON.parse(row[key]) : null);
const latestDraft = (caseId) => db.get('SELECT * FROM drafts WHERE case_id = ? ORDER BY version DESC LIMIT 1', caseId);

const MAX_GOALS = 10;
const MAX_AMOUNT = 1e12; // ₹1 lakh crore: anything larger is a typing error
const isBlank = (v) => v === undefined || v === null || v === '';
// A finite number, or NaN for blanks, booleans, objects and text such as "abc".
const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
const between = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

function validateClient(c) {
  const errors = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['client profile is required'];
  for (const k of ['name', 'age', 'monthlyIncome', 'monthlyExpenses', 'horizonYears']) if (isBlank(c[k])) errors.push(`${k} is required`);
  if (!isBlank(c.name) && (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100)) errors.push('name must be text, up to 100 characters');
  if (!isBlank(c.age) && !(Number.isInteger(num(c.age)) && between(num(c.age), 18, 100))) errors.push('age must be a whole number between 18 and 100');
  if (!isBlank(c.monthlyIncome) && !between(num(c.monthlyIncome), 1, MAX_AMOUNT)) errors.push('monthlyIncome must be a positive amount');
  if (!isBlank(c.horizonYears) && !between(num(c.horizonYears), 1, 50)) errors.push('horizonYears must be 1–50');
  // Amounts and counts that may be left blank but cannot be negative or text.
  for (const k of ['monthlyExpenses', 'monthlyEmi', 'outstandingLoans', 'existingInvestments', 'emergencySavings', 'monthlyInvestable']) {
    if (!isBlank(c[k]) && !between(num(c[k]), 0, MAX_AMOUNT)) errors.push(`${k} must be zero or a positive amount`);
  }
  if (!isBlank(c.dependants) && !(Number.isInteger(num(c.dependants)) && between(num(c.dependants), 0, 20))) errors.push('dependants must be a whole number 0–20');
  if (!Array.isArray(c.goals) || !c.goals.length) errors.push('at least one goal is required');
  else if (c.goals.length > MAX_GOALS) errors.push(`at most ${MAX_GOALS} goals per client`);
  else for (const [i, g] of c.goals.entries()) {
    if (!g || typeof g !== 'object') { errors.push(`goal ${i + 1}: invalid`); continue; }
    if (!isBlank(g.name) && (typeof g.name !== 'string' || g.name.length > 100)) errors.push(`goal ${i + 1}: name must be text, up to 100 characters`);
    if (!between(num(g.currentCost), 1, MAX_AMOUNT)) errors.push(`goal ${i + 1}: current cost must be positive`);
    if (!(Number.isInteger(num(g.years)) && between(num(g.years), 1, 50))) errors.push(`goal ${i + 1}: years must be a whole number 1–50`);
    if (!isBlank(g.existingSavings) && !between(num(g.existingSavings), 0, MAX_AMOUNT)) errors.push(`goal ${i + 1}: savings must be zero or a positive amount`);
    if (!(num(g.inflation) >= 0 && num(g.inflation) < 0.3)) errors.push(`goal ${i + 1}: inflation must be 0–30%`);
    if (!(num(g.assumedReturn) >= 0 && num(g.assumedReturn) < 0.5)) errors.push(`goal ${i + 1}: assumed return must be 0–50%`);
  }
  return errors;
}

// The SEBI registration shown next to the signed-in adviser's name on an approval, e.g. INA000012345.
const SEBI_REG = /^IN[A-Z]\d{9}$/;
const shareToken = () => crypto.randomBytes(24).toString('base64url');

function diff(a = {}, b = {}, prefix = '') {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[k], vb = b[k];
    if (va && vb && typeof va === 'object' && typeof vb === 'object') out.push(...diff(va, vb, `${prefix}${k}.`));
    else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ field: prefix + k, from: va ?? null, to: vb ?? null });
  }
  return out;
}

async function caseView(id) {
  const c = await db.get('SELECT * FROM cases WHERE id = ?', id);
  if (!c) return null;
  const drafts = await db.all('SELECT id, version, status, created_at, created_by, change_summary FROM drafts WHERE case_id = ? ORDER BY version DESC', id);
  const latest = await latestDraft(id);
  return {
    id: c.id, status: c.status, createdAt: c.created_at, updatedAt: c.updated_at,
    client: parse(c, 'client_json'),
    draft: latest ? { id: latest.id, version: latest.version, status: latest.status, ...parse(latest, 'draft_json'), ...(latest.status === 'APPROVED' ? { shareToken: latest.share_token } : {}) } : null,
    history: drafts.map((d) => ({ ...d, change_summary: d.change_summary ? JSON.parse(d.change_summary) : null })),
    reviews: (await db.all('SELECT * FROM reviews WHERE case_id = ? ORDER BY id DESC', id)).map((r) => ({ ...r, justifications: JSON.parse(r.justifications_json || '{}') })),
    audit: (await db.all('SELECT * FROM audit WHERE case_id = ? ORDER BY id DESC LIMIT 100', id)).map((a) => ({ ...a, detail: JSON.parse(a.detail_json) })),
  };
}

async function createDraft(caseId, client, { overrides, adviserNotes, by, changes }) {
  const draft = runPipeline(client, { overrides, adviserNotes });
  const prev = await latestDraft(caseId);
  const version = (prev?.version ?? 0) + 1;
  if (prev && prev.status === 'PENDING_REVIEW') await db.run("UPDATE drafts SET status = 'SUPERSEDED' WHERE id = ?", prev.id);
  await db.run('INSERT INTO drafts (case_id, version, status, draft_json, created_at, created_by, change_summary) VALUES (?, ?, ?, ?, ?, ?, ?)', caseId, version, 'PENDING_REVIEW', JSON.stringify(draft), now(), by, changes ? JSON.stringify(changes) : null);
  await db.run("UPDATE cases SET status = 'PENDING_REVIEW', client_json = ?, client_name = ?, updated_at = ? WHERE id = ?", JSON.stringify(client), client.name, now(), caseId);
  await audit(caseId, 'DRAFT_CREATED', { version, by, flags: draft.guardrails.flags.length, blocking: draft.guardrails.blocking, changes });
  await audit(caseId, 'SENT_TO_ADVISER_DASHBOARD', { version });
  return version;
}

// ---------- API ----------
app.get('/api/meta', (_req, res) => {
  res.json({
    rules: { CAPACITY_RULES, CAPACITY_BANDS, TOLERANCE_QUESTIONS, TOLERANCE_BANDS, ASSET_ASSUMPTIONS, ASSET_VOLATILITY, GOAL_TYPES, EQUITY_STRESS_FALL, GLIDE_START, GLIDE_END, THRESHOLDS, RANK_WEIGHTS, SPECIAL_REQUESTS },
    corpus: corpusStats(),
    docTypes: DOC_TYPES,
    llm: llmEnabled(),
  });
});

app.get('/api/funds', (_req, res) => res.json(allFunds()));

// Counts for the public front page (no client names). Client cases are private: the count is
// included only for a signed-in adviser, and left out for visitors.
app.get('/api/public-stats', async (req, res) => {
  const docs = corpusStats().documents ?? [];
  res.json({
    funds: allFunds().length,
    docs: docs.length,
    pages: docs.reduce((s, d) => s + (d.pages || 0), 0),
    ...((await sessionAdviser(req)) ? { cases: (await db.get('SELECT COUNT(*) AS n FROM cases')).n } : {}),
  });
});

app.get('/api/cases', async (_req, res) => {
  res.json(await db.all('SELECT id, client_name, status, created_at, updated_at FROM cases ORDER BY updated_at DESC'));
});

app.post('/api/cases', async (req, res) => {
  const client = req.body.client ?? {};
  const errors = validateClient(client);
  if (errors.length) return res.status(400).json({ errors });
  const r = await db.run('INSERT INTO cases (client_name, client_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', client.name, JSON.stringify(client), 'DRAFT', now(), now());
  const id = r.lastInsertRowid;
  await audit(id, 'CLIENT_PROFILE_SUBMITTED', { by: req.adviser.name, adviserId: req.adviser.id });
  await createDraft(id, client, { by: 'co-pilot' });
  res.status(201).json(await caseView(id));
});

app.get('/api/cases/:id', async (req, res) => {
  const v = await caseView(+req.params.id);
  return v ? res.json(v) : res.status(404).json({ error: 'not found' });
});

// Edit and resubmit: adviser changes profile inputs, fund picks or notes → new draft version.
app.put('/api/cases/:id', async (req, res) => {
  const id = +req.params.id;
  const row = await db.get('SELECT * FROM cases WHERE id = ?', id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const prev = await latestDraft(id);
  const prevDraft = parse(prev, 'draft_json');
  const client = req.body.client ?? JSON.parse(row.client_json);
  const errors = validateClient(client);
  if (errors.length) return res.status(400).json({ errors });
  const overrides = req.body.overrides ?? prevDraft?.overrides ?? {};
  const adviserNotes = req.body.adviserNotes ?? prevDraft?.adviserNotes ?? '';
  const changes = [
    ...diff(JSON.parse(row.client_json), client, 'client.'),
    ...diff(prevDraft?.overrides ?? {}, overrides, 'fundOverride.'),
    ...(adviserNotes !== (prevDraft?.adviserNotes ?? '') ? [{ field: 'adviserNotes', from: prevDraft?.adviserNotes ?? '', to: adviserNotes }] : []),
  ];
  const by = req.adviser.name; // the signed-in account, never a name sent by the browser
  if (prev?.status === 'APPROVED' && !changes.length) return res.status(409).json({ error: 'Draft already approved and nothing changed.' });
  await createDraft(id, client, { overrides, adviserNotes, by, changes });
  await audit(id, 'EDITED_AND_RESUBMITTED', { by, changes: changes.length });
  res.json(await caseView(id));
});

app.post('/api/cases/:id/review', async (req, res) => {
  const id = +req.params.id;
  const { action, note = '', justifications = {} } = req.body;
  const d = await latestDraft(id);
  if (!d) return res.status(404).json({ error: 'no draft' });
  if (!['approve', 'reject', 'request_changes'].includes(action)) return res.status(400).json({ error: 'action must be approve, reject or request_changes' });
  if (typeof note !== 'string' || !justifications || typeof justifications !== 'object') return res.status(400).json({ error: 'Invalid note or justifications.' });
  // The decision is signed by the signed-in account; the browser can only add a SEBI registration number.
  const registration = String(req.body.registration ?? '').trim().toUpperCase();
  if (registration && !SEBI_REG.test(registration)) return res.status(400).json({ error: 'SEBI registration number should look like INA000012345.' });
  const adviser = registration ? `${req.adviser.name} · ${registration}` : req.adviser.name;
  if (d.status !== 'PENDING_REVIEW') return res.status(409).json({ error: `Draft v${d.version} is ${d.status}; only a pending draft can be reviewed.` });
  const draft = JSON.parse(d.draft_json);
  if (action === 'approve') {
    const missing = draft.guardrails.blocking.filter((fid) => String(justifications[fid] ?? '').trim().length < MIN_JUSTIFICATION);
    if (missing.length) {
      await audit(id, 'APPROVAL_BLOCKED', { adviser, missing });
      return res.status(422).json({ error: `Approval blocked: high-severity flags ${missing.join(', ')} need a written justification (min ${MIN_JUSTIFICATION} characters).`, missing });
    }
  }
  if ((action === 'reject' || action === 'request_changes') && note.trim().length < 5) return res.status(400).json({ error: 'Please give a reason.' });
  const status = { approve: 'APPROVED', reject: 'REJECTED', request_changes: 'CHANGES_REQUESTED' }[action];
  await db.run('UPDATE drafts SET status = ?, share_token = ? WHERE id = ?', status, action === 'approve' ? shareToken() : null, d.id);
  await db.run('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
  await db.run('INSERT INTO reviews (case_id, draft_id, action, adviser, adviser_id, note, justifications_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, d.id, action, adviser, req.adviser.id, note, JSON.stringify(justifications), now());
  await audit(id, `DRAFT_${status}`, { version: d.version, adviser, adviserId: req.adviser.id, email: req.adviser.email, note });
  res.json(await caseView(id));
});

// Research: every question goes to the AI agent (library, engines and official SEBI-regulated sources).
app.post('/api/research', async (req, res) => {
  const { question, caseId } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question required' });
  let draft = null, contextCodes = [], previous = [];
  if (caseId) {
    const row = await latestDraft(+caseId);
    draft = row ? { ...parse(row, 'draft_json'), version: row.version } : null;
    contextCodes = draft?.funds?.map((f) => f.selected?.code).filter(Boolean) ?? [];
    previous = (await db.all('SELECT question, answer_json FROM research WHERE case_id = ? ORDER BY id DESC LIMIT 6', +caseId)).reverse()
      .map((r) => { const a = JSON.parse(r.answer_json); return { question: r.question, answer: a.answer ?? (a.facts ?? []).map((f) => f.text).join(' '), fundCodes: a.fundCodes ?? [] }; });
  }
  if (!llmEnabled()) return res.status(503).json({ error: 'The AI agent is not set up. Add FREE_AI_API_KEY (or ANTHROPIC_API_KEY) to .env and restart the server.' });
  let a;
  try { a = await assistantAnswer(question, { draft, contextCodes, history: previous }); }
  catch (e) { a = { type: 'not_found', answer: `The AI agent could not finish this question (${e.message}). Please try again.`, facts: [], passages: [], sources: [], steps: [], mode: 'ai-agent' }; }
  await db.run('INSERT INTO research (case_id, question, answer_json, created_at) VALUES (?, ?, ?, ?)', caseId ?? null, question, JSON.stringify(a), now());
  if (caseId) await audit(+caseId, 'RESEARCH_QUESTION', { question, type: a.type, mode: a.mode });
  res.json(a);
});

// Fintel: form and page help on every page. Visitors get fewer questions than signed-in advisers.
const FINTEL_WINDOW_MS = 10 * 60_000;
const fintelHits = new Map();
app.post('/api/fintel', async (req, res) => {
  const question = String(req.body.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'Type a question.' });
  if (!llmEnabled()) return res.status(503).json({ error: 'Fintel is not set up yet. Add FREE_AI_API_KEY (or ANTHROPIC_API_KEY) to .env and restart the server.' });
  const adviser = await sessionAdviser(req);
  const key = adviser ? `a${adviser.id}` : `ip${req.ip}`, max = adviser ? 60 : 15;
  const h = fintelHits.get(key);
  if (!h || Date.now() - h.first >= FINTEL_WINDOW_MS) fintelHits.set(key, { count: 1, first: Date.now() });
  else if (++h.count > max) return res.status(429).json({ error: `You've asked a lot of questions in a short time. Try again in ${Math.ceil((FINTEL_WINDOW_MS - (Date.now() - h.first)) / 60_000)} minute(s).` });
  try { res.json(await fintelAnswer(question, { page: req.body.page, history: req.body.history })); }
  catch (e) { res.status(502).json({ error: `Fintel could not answer just now (${e.message}). Please try again.` }); }
});

// Contact form (public pages). Messages are emailed to CONTACT_EMAIL (default: the SMTP account);
// without SMTP they are printed in the server window, like reset links. 5 messages per IP per hour.
const CONTACT_WINDOW_MS = 60 * 60_000;
const CONTACT_TOPICS = ['General question', 'Demo or onboarding', 'Account or technical support', 'Privacy or data request', 'Partnership'];
const contactHits = new Map();
app.post('/api/contact', async (req, res) => {
  const field = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
  const name = field('name', 120), email = field('email', 200), organisation = field('organisation', 160), message = field('message', 5000);
  const topic = CONTACT_TOPICS.includes(req.body.topic) ? req.body.topic : CONTACT_TOPICS[0];
  const thanks = { ok: true, message: 'Thank you. Your message has been sent, and we will reply by email.' };
  if (field('website', 200)) return res.json(thanks); // honeypot: filled only by bots
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (message.length < 10) return res.status(400).json({ error: 'Write a message of at least 10 characters.' });
  const h = contactHits.get(req.ip);
  if (!h || Date.now() - h.first >= CONTACT_WINDOW_MS) contactHits.set(req.ip, { count: 1, first: Date.now() });
  else if (++h.count > 5) return res.status(429).json({ error: `You've sent several messages already. Try again in ${Math.ceil((CONTACT_WINDOW_MS - (Date.now() - h.first)) / 60_000)} minute(s).` });
  const to = process.env.CONTACT_EMAIL?.trim() || process.env.SMTP_USER?.trim() || '(CONTACT_EMAIL not set)';
  try {
    await sendMail({
      to, replyTo: `${name.replace(/[<>"\r\n]/g, '')} <${email}>`,
      subject: `[Fin Advisor contact] ${topic}: ${name}`.replace(/[\r\n]/g, ' '),
      text: `Name: ${name}\nEmail: ${email}\nFirm / registration: ${organisation || '-'}\nTopic: ${topic}\n\n${message}\n`,
    });
    res.json(thanks);
  } catch (e) {
    console.error('Contact message could not be emailed:', e.message);
    res.status(502).json({ error: 'Your message could not be sent just now. Please try again later.' });
  }
});

app.delete('/api/cases/:id/research', async (req, res) => {
  await db.run('DELETE FROM research WHERE case_id = ?', +req.params.id);
  await audit(+req.params.id, 'RESEARCH_CHAT_CLEARED', {});
  res.json({ ok: true });
});

// ---------- Document library ----------
app.get('/api/docs', (_req, res) => res.json(corpusStats()));
app.get('/api/docs/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Enter at least 2 characters.' });
  res.json({ q, hits: searchDocuments(q, { docId: req.query.doc || null, limit: Math.min(+req.query.limit || 20, 50) }) });
});
app.get('/api/docs/:id/pages/:page', (req, res) => {
  const p = pageText(req.params.id, +req.params.page);
  return p ? res.json(p) : res.status(404).json({ error: 'page not found' });
});
app.post('/api/docs', express.raw({ type: 'application/pdf', limit: '40mb' }), async (req, res) => {
  const title = String(req.query.title ?? '').trim();
  const type = DOC_TYPES.includes(req.query.type) ? req.query.type : 'Other';
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'Send the PDF as the request body with Content-Type application/pdf.' });
  if (req.body.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'That file is not a PDF.' });
  if (title.length < 3) return res.status(400).json({ error: 'A document title is required.' });
  try {
    const doc = await addDocument(req.body, { title, type, publisher: String(req.query.publisher || 'Uploaded by adviser'), asOf: req.query.asOf || null, sourceUrl: /^https?:\/\//.test(req.query.url ?? '') ? req.query.url : '' });
    await audit(null, 'DOCUMENT_UPLOADED', { id: doc.id, title, pages: doc.pages });
    res.status(201).json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/docs/:id', async (req, res) => {
  const r = removeDocument(req.params.id);
  if (r.status === 200) await audit(null, 'DOCUMENT_REMOVED', { id: req.params.id });
  res.status(r.status).json(r);
});

app.get('/api/cases/:id/research', async (req, res) => {
  res.json((await db.all('SELECT * FROM research WHERE case_id = ? ORDER BY id', +req.params.id)).map((r) => ({ question: r.question, ...JSON.parse(r.answer_json), at: r.created_at })));
});

// Client-facing output: the link carries a random token issued when a draft is approved, so
// reports cannot be found by counting case numbers. It works only while that draft is still the
// latest one; after a new version, the client needs the link from the next approval.
app.get('/client/:token', async (req, res) => {
  const token = req.params.token;
  const d = /^[\w-]{32}$/.test(token) ? await db.get('SELECT * FROM drafts WHERE share_token = ?', token) : null;
  if (!d) return res.status(404).send(renderBlocked('NOT_FOUND'));
  const latest = await latestDraft(d.case_id);
  if (latest.id !== d.id || d.status !== 'APPROVED') {
    await audit(d.case_id, 'CLIENT_OUTPUT_BLOCKED', { version: d.version, status: latest.id !== d.id ? `SUPERSEDED_BY_V${latest.version}` : d.status });
    return res.status(403).send(renderBlocked(latest.id !== d.id ? 'SUPERSEDED' : d.status));
  }
  const review = await db.get("SELECT * FROM reviews WHERE draft_id = ? AND action = 'approve' ORDER BY id DESC LIMIT 1", d.id);
  await audit(d.case_id, 'CLIENT_OUTPUT_VIEWED', { version: d.version });
  res.send(renderClientReport(JSON.parse(d.draft_json), { version: d.version, adviser: review.adviser, approvedAt: review.created_at }));
});

// Error pages. API callers keep getting JSON; browsers get the styled 404/500 pages.
const isApi = (req) => req.path === '/api' || req.path.startsWith('/api/');
app.use((req, res) => {
  if (isApi(req)) return res.status(404).json({ error: 'not found' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});
app.use((err, req, res, _next) => {
  // Client errors raised by middleware (e.g. malformed JSON, body too large) keep their status.
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return res.end();
  if (isApi(req) || status !== 500) return res.status(status).json({ error: status === 500 ? 'Something went wrong.' : err.message });
  res.status(500).sendFile(path.join(PUBLIC_DIR, '500.html'));
});

// On Vercel the platform runs the exported app as a function; locally it listens on PORT.
export default app;

const port = +process.env.PORT || 4400;
if (!process.env.VERCEL) {
  await authReady;
  app.listen(port, () => {
    console.log(`Adviser co-pilot running at http://localhost:${port}`);
    const ai = providers()[0];
    if (ai) console.log(`AI assistant: ${ai.label}, model ${ai.model}`);
    else if (process.env.FREE_AI_API_KEY?.trim()) console.warn('AI assistant OFF: FREE_AI_API_KEY is set but its provider is not recognised. Set FREE_AI_PROVIDER, or FREE_AI_BASE_URL and FREE_AI_MODEL, in .env.');
    else console.log('AI assistant off (no key in .env); research uses document search.');
    console.log(dbRemote ? `Database: hosted (${new URL(remoteUrl).host})` : 'Database: local file');
    console.log(mailConfigured()
      ? `Password-reset emails: sent via ${process.env.SMTP_HOST.trim()}`
      : 'Password-reset emails: SMTP not set up in .env, so reset links are printed here instead of emailed.');
  });
}
