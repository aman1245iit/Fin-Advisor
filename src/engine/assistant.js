// AI research assistant: a language model with tools over the same deterministic engines and documents.
//
// The model decides which tools to call (document search, fund facts, comparisons, page reads,
// the client case, what-if goal plans, and official SEBI-regulated websites) and writes the
// answer. Every tool result is registered as a numbered source [S1], [S2]…, and the answer must
// cite them. Guardrails stay deterministic:
//  • guarantee requests are answered by the fixed compliance text before any model call;
//  • every number in the answer must appear in a tool result or the question, otherwise the model
//    is asked to correct it, and if it still fails the answer is withheld;
//  • external reads are limited to official domains (official.js);
//  • the assistant explains the suitability engine's output but cannot change it.
//
// Two providers share the tools and the checks: Claude (ANTHROPIC_API_KEY) and a free
// OpenAI-compatible provider (FREE_AI_API_KEY: Groq, Google Gemini or OpenRouter).
import Anthropic from '@anthropic-ai/sdk';
import { DOCUMENTS, docById } from './sources.js';
import { SLEEVES } from './universe.js';
import { retrieve, fundFacts, compareFunds, findFund, fundList, pageText } from './rag.js';
import { OFFICIAL_DOMAINS, readOfficial, searchOfficial } from './official.js';
import { detectGuaranteeRequest, GUARANTEE_RESPONSE } from './guardrails.js';
import { allocate, planGoal, simulateGoal, GOAL_TYPES } from './planner.js';
import { LEVELS } from './risk.js';
import { shortlist } from './funds.js';
import { investRangeText } from './pipeline.js';

export const MODEL = 'claude-opus-5-5';
const MAX_TURNS = 10;
const MAX_CORRECTIONS = 2;
let client;
// Test hooks: inject a stand-in for the Anthropic client, or for fetch (free provider).
export const _setClient = (c) => { client = c; };
let fetchImpl = (...a) => fetch(...a);
export const _setFetch = (f) => { fetchImpl = f; };

// Free providers with an OpenAI-compatible /chat/completions endpoint and tool calling.
// The provider is detected from the key's prefix; FREE_AI_PROVIDER, FREE_AI_MODEL and
// FREE_AI_BASE_URL override it.
export const FREE_PRESETS = {
  // Groq's free limits are per model, so a rate-limited call moves to the next model instead of waiting.
  groq: { label: 'Groq', prefix: 'gsk_', env: ['GROQ_API_KEY'], baseURL: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', fallbacks: ['openai/gpt-oss-20b'] },
  gemini: { label: 'Google Gemini', prefix: 'AIza', env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openrouter: { label: 'OpenRouter', prefix: 'sk-or-', env: ['OPENROUTER_API_KEY'], baseURL: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
};

// The key may be FREE_AI_API_KEY, or the name a provider's Vercel integration sets (GROQ_API_KEY,
// GEMINI_API_KEY, …), with or without the prefix the Vercel Marketplace can add (e.g. FIN_GROQ_API_KEY).
const FREE_KEY_NAMES = ['FREE_AI_API_KEY', ...Object.values(FREE_PRESETS).flatMap((p) => p.env)];
export function freeKeyName() {
  const names = Object.keys(process.env).filter((k) => process.env[k]?.trim());
  for (const n of FREE_KEY_NAMES) {
    const hit = names.find((k) => k === n) ?? names.find((k) => k.endsWith(`_${n}`));
    if (hit) return hit;
  }
  return null;
}

export function freeConfig() {
  const name = freeKeyName();
  const key = name && process.env[name].trim();
  if (!key) return null;
  const named = Object.keys(FREE_PRESETS).find((p) => FREE_PRESETS[p].env.some((n) => name === n || name.endsWith(`_${n}`)));
  const id = process.env.FREE_AI_PROVIDER?.trim().toLowerCase() || Object.keys(FREE_PRESETS).find((p) => key.startsWith(FREE_PRESETS[p].prefix)) || named;
  const preset = FREE_PRESETS[id] ?? {};
  const baseURL = (process.env.FREE_AI_BASE_URL?.trim() || preset.baseURL || '').replace(/\/+$/, '');
  const model = process.env.FREE_AI_MODEL?.trim() || preset.model;
  if (!baseURL || !model) return null; // unknown key type: set FREE_AI_PROVIDER or FREE_AI_BASE_URL + FREE_AI_MODEL
  const fallbacks = (process.env.FREE_AI_FALLBACK_MODELS?.trim() ? process.env.FREE_AI_FALLBACK_MODELS.split(',').map((m) => m.trim()) : preset.fallbacks ?? [])
    .filter((m) => m && m !== model);
  return { key, keyName: name, baseURL, model, fallbacks, label: preset.label ?? 'Free AI' };
}

const claudeEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
// Available providers, preferred first.
export function providers() {
  const out = [];
  if (claudeEnabled()) out.push({ id: 'claude', label: 'Claude', model: MODEL });
  const f = freeConfig();
  if (f) out.push({ id: 'free', label: `Free AI (${f.label})`, model: f.model });
  return out;
}
export const llmEnabled = () => providers().length > 0;

const SYSTEM = `You are the research and planning assistant inside Fin Advisor, a co-pilot for a SEBI-registered investment adviser (RIA) in India. The adviser is your user; the client never sees your answers directly.

How to work:
- Use the tools to find facts. Search the documents, look up fund facts, compare funds, read whole pages when a passage is cut off, and read the client case when the question is about this client.
- Start with the library and the engines. When they do not cover the question (a newer SEBI circular, a regulation, a fund or AMC outside the library, a current figure), use search_official_sources and read_official_source. These reach only official SEBI-regulated sources: SEBI, AMFI, RBI, the exchanges and depositories, SEBI-registered mutual fund AMCs, and the Income Tax Department. Tax rates and exemption limits change in most Budgets: for any tax question search with site "incometax.gov.in" and quote the current rules from what you read, never from memory. Never rely on any other website, blog or news source, and never answer fund-specific or regulatory facts from memory.
- Be thorough: when a question touches several things (e.g. a fund's cost, risk, returns and exit load), look each one up and cover them all. Prefer calling tools over saying you don't know.
- To plan funds for a goal ("I need ₹25 lakh in 12 years for my child's education", "where should I invest ₹10,000 a month for retirement?"), call plan_goal. It returns the future cost, the monthly SIP, the asset allocation, the screened fund for each part with its monthly amount, the chance of reaching the target and the de-risking path. Call it once per goal. If a client case is open, plan_goal uses that client's risk level unless the adviser gives one. If no case is open and the risk level is unknown, plan_goal assumes Moderate; say so and offer to re-run it for Conservative or Aggressive.
- When asked how much the client should invest, lead with the case's "Recommended investment" range (monthly, lump sum, and any SWP), then explain it from the reasons given there; the goals' total SIP is what the goals need, not the recommendation.
- Answer from tool results. Every tool result is labelled with source ids like [S3]. Cite the source id after each factual sentence, e.g. "The exit load is 1% if redeemed within 365 days [S2]."
- Copy every number exactly as it appears in a tool result (same digits and units). Do not compute new figures, convert units, round, or add numbers from memory. If a calculation is needed, say which figures from the sources the adviser should use.
- You may explain general concepts (what a SIP, an index fund or a glide path is) in plain words without a citation, but label it "General explanation" and use no figures in it (no rates, limits, holding periods or amounts). Fund-specific or regulatory facts must come from the tools; if neither the library nor the official sources cover them, say so and suggest which document the adviser could upload.
- Never promise, imply or estimate guaranteed returns. Past performance is not indicative of future results.
- The plan's allocation and fund shortlist come from deterministic suitability and screening engines. You may explain them; you must not recommend overriding suitability rules.

Style: be brief, but always cite: put the [S#] id right after every fact, table cell or bullet that comes from a tool, written exactly as [S1] (never "Source: …" or a document name). Lead with the direct answer in one or two sentences, then only the detail that matters. Use "- " bullets or one compact markdown table (comparisons; fund plans as Fund | Share | Monthly amount). Don't restate the question's inputs, repeat a figure twice, or add generic advice. Keep it under 200 words unless the adviser asks for more.`;

const TOOLS = [
  {
    name: 'search_documents',
    description: 'Full-text search (BM25) over the official documents: AMC factsheets, scheme information documents (SIDs), SEBI circulars, and any PDFs the adviser uploaded. Returns the best-matching passages with document and page. Use specific wording, e.g. "exit load", "investment objective", "riskometer", "definition of mid cap".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        fund: { type: 'string', description: 'Optional fund name to boost that fund\'s own pages.' },
        document_id: { type: 'string', description: 'Optional: restrict to one document id from list_documents.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_fund_facts',
    description: 'Structured facts for one fund in the screened universe: expense ratio (TER), AUM, fund managers and tenure, benchmark, tracking error, and returns/drawdown computed from AMFI NAV history. Each fact has its factsheet page.',
    input_schema: { type: 'object', properties: { fund: { type: 'string', description: 'Fund name (or AMFI scheme code).' } }, required: ['fund'], additionalProperties: false },
  },
  {
    name: 'compare_funds',
    description: 'Side-by-side comparison of 2–4 funds: TER, AUM, managers, benchmark, 1/3/5/10-year CAGR, max drawdown and volatility.',
    input_schema: { type: 'object', properties: { funds: { type: 'array', items: { type: 'string' }, description: 'Fund names.' } }, required: ['funds'], additionalProperties: false },
  },
  {
    name: 'list_funds',
    description: 'List every fund in the screened universe with AMC, SEBI category, allocation sleeve and whether it is an index fund.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_documents',
    description: 'List the documents in the library with id, type, publisher and as-of date.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_page',
    description: 'Read the full extracted text of one document page, e.g. to see a whole table that a search passage cut off.',
    input_schema: { type: 'object', properties: { document_id: { type: 'string' }, page: { type: 'integer' } }, required: ['document_id', 'page'], additionalProperties: false },
  },
  {
    name: 'get_client_case',
    description: 'The current client case: profile, risk profile, goals with SIPs, allocation and success probability, the shortlisted funds and why, the alternative investment options, and guardrail flags. Use for any question about this client or their plan.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'plan_goal',
    description: 'Plan where to invest for one financial goal using the co-pilot\'s planning and fund-screening engines: inflation-adjusted future cost, monthly SIP (flat, glide-path and recommended), asset allocation by risk level and horizon, the screened direct-plan fund for each sleeve with its monthly amount and alternatives, Monte Carlo chance of reaching the target, SIP for 80% confidence, and the de-risking phases. Amounts are in rupees (₹25 lakh = 2500000).',
    input_schema: {
      type: 'object',
      properties: {
        goal_name: { type: 'string', description: 'Short name, e.g. "Daughter\'s education".' },
        goal_type: { type: 'string', enum: Object.keys(GOAL_TYPES), description: 'Goal category; education, medical and emergency are treated as essential (less equity).' },
        current_cost: { type: 'number', description: 'What the goal costs in today\'s rupees. Give this or monthly_sip.' },
        monthly_sip: { type: 'number', description: 'Use when the investor states a monthly amount but no target (e.g. "invest ₹10,000 a month for 25 years"): returns the allocation, the fund split of that amount and the projected corpus.' },
        years: { type: 'number', description: 'Years until the money is needed (1–50).' },
        existing_savings: { type: 'number', description: 'Rupees already saved for this goal. Default 0.' },
        inflation: { type: 'number', description: 'Annual inflation for this goal as a decimal (0.06 = 6%). Default depends on goal type.' },
        assumed_return: { type: 'number', description: 'Annual return assumption as a decimal. Default: the expected return of the suggested allocation.' },
        risk_level: { type: 'string', enum: LEVELS, description: 'Default: the open client case\'s risk level, else Moderate.' },
        max_loss_pct: { type: 'number', description: 'Largest one-year fall the investor accepts, in percent. Default: the client\'s answer, else 20.' },
      },
      required: ['goal_type', 'years'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_official_sources',
    description: `Web search limited to official SEBI-regulated sources. Default sites: SEBI, AMFI and RBI. Use "site" to search one allowed domain instead, e.g. an AMC's website for its factsheet or SID. Returns titles, URLs and snippets; read a result with read_official_source before citing figures from it. Allowed domains: ${Object.keys(OFFICIAL_DOMAINS).join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "master circular mutual funds riskometer".' },
        site: { type: 'string', description: 'Optional: one allowed domain, e.g. "sebi.gov.in" or "hdfcfund.com".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_official_source',
    description: 'Read the text of one web page or PDF on an allowed official domain (SEBI, AMFI, RBI, NSE, BSE, NSDL, CDSL or a SEBI-registered AMC). Other URLs are refused. Long pages are trimmed to the lines around "find".',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL on an allowed domain.' },
        find: { type: 'string', description: 'Optional words to focus on in a long page, e.g. "exit load".' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

// ---------- Tool execution ----------
const pc = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
const inr = (x) => '₹' + Math.round(x).toLocaleString('en-IN');

function caseSummary(d) {
  const c = d.client, r = d.risk;
  const lines = [
    `Client: ${c.name}, age ${c.age}${c.location ? `, ${c.location}` : ''}${c.employmentStatus ? `, ${c.employmentStatus.replace('_', ' ')}` : ''}. Monthly income ${inr(r.financials.income)}, expenses ${inr(r.financials.expenses)}, EMIs ${inr(r.financials.emi)}, surplus ${inr(r.financials.surplus)}. Emergency cover ${r.financials.emergencyMonths.toFixed(1)} months. Dependants ${c.dependants || 0}.`,
    `Risk: capacity ${r.capacity.level} (${r.capacity.score}/100), tolerance ${r.tolerance.level} (${r.tolerance.score}/15), proposed ${r.final.level}. ${r.reasons.join(' ')}`,
    ...(d.plan.investRange ? [`HOW MUCH THE CLIENT SHOULD INVEST (the co-pilot's recommendation; answer "how much to invest" with this): ${investRangeText(d.plan.investRange)}. Reasons: ${d.plan.investRange.basis.join(' ')}`] : []),
    `SIP the goals would need in full (not the recommendation when it exceeds what is affordable): ${inr(d.plan.totalSip)} per month. Starting mix: ${Object.entries(d.plan.combinedAllocation).map(([k, v]) => `${SLEEVES[k].label} ${v}%`).join(', ')}.`,
    ...d.plan.goals.map((g) => `Goal "${g.name}" (${g.typeLabel}, ${g.years} years): future cost ${inr(g.futureCost)}, recommended SIP ${inr(g.recommendedSip)}, starting equity ${g.currentAllocation.equity}%, chance of reaching target ${(g.monteCarlo.successProb * 100).toFixed(0)}%, SIP for 80% confidence ${inr(g.monteCarlo.sipFor[80])}. De-risking: ${g.derisk.phases.map((p) => `${p.label} years ${p.from}–${p.to}`).join('; ')}.`),
    ...d.funds.map((s) => `Sleeve ${s.label} (${s.weight}%): ${s.selected ? `${s.selected.name}${s.overridden ? ' (adviser override)' : ''}. ${s.selected.explanation ?? ''}` : 'no eligible fund'}${s.eligible.length > 1 ? ` Other eligible: ${s.eligible.filter((f) => f.code !== s.selected?.code).map((f) => f.name).join(', ')}.` : ''}`),
    ...(d.investOptions ?? []).filter((o) => !o.sameAs).map((o) => `Option "${o.title}": ${o.fundCount} funds, weighted TER ${o.ter.toFixed(2)}%${o.history ? `, 10-year backtest CAGR ${pc(o.history.cagr)}, max drawdown ${pc(o.history.maxDrawdown)}` : ''}. Funds: ${o.sleeves.map((s) => s.fund).filter(Boolean).join(', ')}.`),
    `Guardrail flags: ${d.guardrails.flags.map((f) => `${f.severity.toUpperCase()} ${f.code}: ${f.message}`).join(' | ') || 'none'}.`,
  ];
  return lines.join('\n');
}

// Risk inputs for a what-if plan: as given, else the open case's, else Moderate.
function planRisk(input, draft) {
  const riskLevel = input.risk_level ?? draft?.risk?.final?.level ?? 'Moderate';
  const riskIndex = LEVELS.indexOf(riskLevel);
  if (riskIndex < 0) throw new Error(`risk_level must be one of ${LEVELS.join(', ')}.`);
  const riskFrom = input.risk_level ? 'as given' : draft ? 'from the open client case' : 'assumed, no client case open';
  return { riskLevel, riskIndex, riskFrom, maxLossPct: +input.max_loss_pct || +draft?.client?.maxLoss || 20 };
}

const fundSplitLines = (sl, monthly) => sl.map((s) => `- ${s.label} ${s.weight}%: ${s.selected ? `${s.selected.name}, ${inr((monthly * s.weight) / 100)} a month (TER ${s.selected.expenseRatio}%)` : 'no eligible fund in the universe'}${s.eligible.length > 1 ? `. Alternatives: ${s.eligible.filter((f) => f.code !== s.selected?.code).map((f) => f.name).join(', ')}` : ''}.`);

// What-if plan for a fixed monthly amount with no target: allocation, fund split and the
// simulated range of the corpus it could build.
function budgetPlanText(input, draft, source) {
  const type = input.goal_type, years = +input.years, sip = +input.monthly_sip, S = +input.existing_savings || 0;
  const { riskLevel, riskIndex, riskFrom, maxLossPct } = planRisk(input, draft);
  const inflation = input.inflation ?? GOAL_TYPES[type].inflation;
  // The planner builds the glide path; the cost is a placeholder because only the path is used.
  const g = planGoal({ name: input.goal_name || GOAL_TYPES[type].label, type, currentCost: 1, years, existingSavings: 0, inflation, assumedReturn: 0.08 },
    { riskIndex, maxLossPct, startAge: +draft?.client?.age || null });
  const mc = simulateGoal({ S, N: g.months, glide: g.glide, sip, target: 1 });
  const today = (x) => x / Math.pow(1 + inflation, years);
  const weights = g.currentAllocation.weights;
  const id = source(`Planning engine – ${g.name} (what-if)`);
  return [
    `[${id}] "${g.name}" (${g.typeLabel}): ${inr(sip)} a month for ${years} years${S ? ` plus ${inr(S)} already saved` : ''}. Risk level ${riskLevel} (${riskFrom}), max acceptable fall ${maxLossPct}%.`,
    `[${id}] Total invested ${inr(sip * g.months + S)}. Projected corpus (${mc.paths} simulated paths): pessimistic ${inr(mc.endP10)}, median ${inr(mc.endP50)}, optimistic ${inr(mc.endP90)}. In today's money at ${(inflation * 100).toFixed(2)}% inflation the median is ${inr(today(mc.endP50))}.`,
    `[${id}] Starting allocation: equity ${g.currentAllocation.equity}%; ${Object.entries(weights).map(([k, w]) => `${SLEEVES[k].label} ${w}%`).join(', ')}. Rules applied: ${g.currentAllocation.rules.join('; ')}.`,
    `[${id}] Where to invest each month (screened direct-plan growth funds):`,
    ...fundSplitLines(shortlist(weights), sip),
    `[${id}] De-risking: ${g.derisk.phases.map((p) => `${p.label} years ${p.from}–${p.to}`).join('; ')}. Equity reaches 0% in the last 3 years.`,
    `[${id}] Projections use assumed returns; they are calculations, not forecasts or guarantees.`,
  ].join('\n');
}

// What-if plan for one goal: the same planner and screening engines the drafts use.
function goalPlanText(input, draft, source) {
  const type = GOAL_TYPES[input.goal_type] ? input.goal_type : 'other';
  const cost = +input.current_cost, years = +input.years, budget = +input.monthly_sip;
  if (!(cost > 0) && !(budget > 0)) throw new Error('Give current_cost (the goal in today\'s rupees) or monthly_sip (the amount to invest each month).');
  if (!(years >= 1 && years <= 50)) throw new Error('years must be between 1 and 50.');
  if (!(cost > 0)) return budgetPlanText({ ...input, goal_type: type }, draft, source);
  const { riskLevel, riskIndex, riskFrom, maxLossPct } = planRisk(input, draft);
  const inflation = input.inflation ?? GOAL_TYPES[type].inflation;
  const start = allocate({ riskIndex, yearsLeft: years, goalType: type, maxLossPct });
  const g = planGoal({
    name: input.goal_name || GOAL_TYPES[type].label, type, currentCost: cost, years,
    existingSavings: +input.existing_savings || 0, inflation, assumedReturn: input.assumed_return ?? start.expectedReturn,
  }, { riskIndex, maxLossPct, startAge: +draft?.client?.age || null });
  const weights = g.currentAllocation.weights;
  const sl = shortlist(weights);
  const id = source(`Planning engine – ${g.name} (what-if)`);
  const pct2 = (x) => (x * 100).toFixed(2) + '%';
  return [
    `[${id}] Goal "${g.name}" (${g.typeLabel}): ${inr(cost)} today, needed in ${years} years. Risk level ${riskLevel} (${riskFrom}), max acceptable fall ${maxLossPct}%. Inflation ${pct2(inflation)}, assumed return ${pct2(+g.assumedReturn)}.`,
    `[${id}] Future cost ${inr(g.futureCost)}. Existing savings grow to ${inr(g.savingsFV)}; gap ${inr(g.gap)}.`,
    `[${id}] Monthly SIP: flat ${inr(g.sip)}, glide-path ${inr(g.sipGlide)}, recommended ${inr(g.recommendedSip)}. Chance of reaching the target at the recommended SIP ${(g.monteCarlo.successProb * 100).toFixed(0)}%; SIP for 80% confidence ${inr(g.monteCarlo.sipFor[80])}; for 90% confidence ${inr(g.monteCarlo.sipFor[90])}.`,
    `[${id}] Starting allocation: equity ${g.currentAllocation.equity}%; ${Object.entries(weights).map(([k, w]) => `${SLEEVES[k].label} ${w}%`).join(', ')}. Rules applied: ${g.currentAllocation.rules.join('; ')}.`,
    `[${id}] Where to invest each month (screened direct-plan growth funds):`,
    ...fundSplitLines(sl, g.recommendedSip),
    ...(+input.existing_savings > 0 ? [`[${id}] Existing savings of ${inr(+input.existing_savings)} split the same way as a lump sum.`] : []),
    `[${id}] De-risking: ${g.derisk.phases.map((p) => `${p.label} years ${p.from}–${p.to}`).join('; ')}. Equity reaches 0% in the last 3 years.`,
    `[${id}] Projections use assumed returns; they are calculations, not forecasts or guarantees.`,
  ].join('\n');
}

function makeExecutor({ draft, contextCodes }) {
  const sources = [];
  const addSource = (s) => {
    const key = `${s.label}|${s.url}`;
    let i = sources.findIndex((x) => `${x.label}|${x.url}` === key);
    if (i < 0) { sources.push({ id: `S${sources.length + 1}`, ...s }); i = sources.length - 1; }
    return sources[i].id;
  };
  const resolve = (name) => {
    const f = findFund(String(name));
    if (!f) throw new Error(`No fund in the universe matches "${name}". Call list_funds to see the available funds.`);
    return f;
  };
  const run = {
    search_documents({ query, fund, document_id }) {
      if (document_id && !docById(document_id)) throw new Error(`Unknown document_id "${document_id}". Call list_documents.`);
      const codes = fund ? [resolve(fund).code] : [];
      const hits = retrieve(query, { fundCodes: codes, k: 5, docId: document_id || null });
      if (!hits.length) return 'No matching passages.';
      return hits.map((h) => `[${addSource({ label: `${h.title}, p.${h.page}`, url: h.url, kind: 'document', doc: h.doc, page: h.page })}] (${h.doc}, page ${h.page}, relevance ${h.score.toFixed(1)}) ${h.excerpt}`).join('\n\n');
    },
    get_fund_facts({ fund }) {
      const f = resolve(fund);
      const onPlan = draft?.funds?.find((s) => s.selected?.code === f.code);
      const facts = fundFacts(f.code, '', { all: true }).map((x) => `[${addSource({ label: x.source.label, url: x.source.url, kind: x.computed ? 'computed' : 'factsheet' })}] ${x.text}`);
      if (onPlan) facts.push(`[${addSource({ label: `Screening engine – ${onPlan.label}`, url: '#/funds', kind: 'engine' })}] On this client's plan in ${onPlan.label}. ${onPlan.selected.explanation ?? ''}`);
      return facts.join('\n');
    },
    compare_funds({ funds }) {
      const rows = compareFunds([...new Set(funds.map((n) => resolve(n).code))]);
      return rows.map((r) => `[${addSource({ label: r.source.label, url: r.source.url, kind: 'factsheet' })}][${addSource({ label: r.navSource.label, url: r.navSource.url, kind: 'computed' })}] ${r.name} (${r.amc}, ${r.category}${r.passive ? ', index fund' : ''}): TER ${r.ter}%, AUM ₹${r.aumCr?.toLocaleString('en-IN')} Cr, benchmark ${r.benchmark}, managers ${r.managers.join(', ') || 'n/a'}${r.trackingError1y != null ? `, tracking error ${r.trackingError1y}%` : ''}; CAGR 1y ${pc(r.cagr1y)}, 3y ${pc(r.cagr3y)}, 5y ${pc(r.cagr5y)}, 10y ${pc(r.cagr10y)}; max drawdown ${pc(r.maxDrawdown)}, volatility ${pc(r.volatility)} over ${r.window} (NAV to ${r.asOf}).`).join('\n');
    },
    list_funds() {
      return fundList().map((f) => `${f.name} – ${f.amc}, ${f.category}, sleeve ${f.sleeve}${f.passive ? ', index' : ''}${contextCodes.includes(f.code) ? ' [on this client\'s plan]' : ''}`).join('\n');
    },
    list_documents() {
      return DOCUMENTS.map((d) => `${d.id}: ${d.title} (${d.type}; ${d.publisher}${d.asOf ? `; as of ${d.asOf}` : ''}${d.uploaded ? '; uploaded by adviser' : ''})`).join('\n');
    },
    read_page({ document_id, page }) {
      const pg = pageText(document_id, page);
      if (!pg) throw new Error(`No page ${page} in document "${document_id}".`);
      return `[${addSource({ label: `${pg.title}, p.${pg.page}`, url: pg.url, kind: 'document', doc: pg.doc, page: pg.page })}] ${pg.text.slice(0, 6000)}`;
    },
    get_client_case() {
      if (!draft) throw new Error('No client case is open. Answer from documents only.');
      return `[${addSource({ label: `Client case – draft v${draft.version ?? ''}`, url: '#/plan', kind: 'engine' })}]\n${caseSummary(draft)}`;
    },
    plan_goal(input) {
      return goalPlanText(input, draft, (label) => addSource({ label, url: draft ? '#/plan' : '#/research', kind: 'engine' }));
    },
    async search_official_sources({ query, site }) {
      const hits = await searchOfficial(String(query), site ? String(site) : '');
      if (!hits.length) return 'No results on the official sources. Try other words or a specific site.';
      return hits.map((h) => `${h.publisher} – ${h.title}\n${h.url}\n${h.snippet}`).join('\n\n');
    },
    async read_official_source({ url, find }) {
      const p = await readOfficial(String(url), find ? String(find) : '');
      const label = `${p.publisher} – ${decodeURIComponent(new URL(p.url).pathname.split('/').filter(Boolean).pop() || new URL(p.url).hostname)}`;
      return `[${addSource({ label, url: p.url, kind: 'external' })}] ${p.note ? `(${p.note}) ` : ''}${p.text}`;
    },
  };
  return { sources, run };
}

// Numbers in the answer must appear in the material the model was given.
function unsupportedNumbers(text, evidence) {
  const norm = (s) => s.replace(/(\d),(?=\d)/g, '$1');
  const ev = norm(evidence);
  const nums = norm(text.replace(/\[S\d+\]/g, '')).match(/\d+(\.\d+)?/g) || [];
  return [...new Set(nums.filter((n) => (n.length > 1 || n.includes('.')) && !ev.includes(n)))];
}

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

// ---------- Providers ----------
// Each adapter sends the running message list and returns
// { text, toolCalls: [{ id, name, input }], stop: 'tool_use' | 'end' | 'max_tokens' | 'refusal', model },
// appending the model's turn to `messages` in its own format.
// opts: { system, tools, effort, maxTokens } — defaults are the research assistant's.
const claudeAdapter = ({ system = SYSTEM, tools = TOOLS, effort = 'medium', maxTokens = 16000 } = {}) => ({
  async call(messages) {
    client ??= new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort },
      system,
      ...(tools.length ? { tools } : {}),
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });
    const stop = { tool_use: 'tool_use', refusal: 'refusal', max_tokens: 'max_tokens' }[response.stop_reason] ?? 'end';
    const toolCalls = response.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
    return { text: textOf(response.content), toolCalls, stop, model: response.model };
  },
  addToolResults(messages, results) {
    messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
  },
});

// OpenAI-compatible chat completions (Groq, Gemini, OpenRouter). Some providers reject
// `additionalProperties` in tool schemas, so it is stripped.
const OPENAI_TOOLS = TOOLS.map(({ name, description, input_schema: { additionalProperties, ...parameters } }) => ({ type: 'function', function: { name, description, parameters } }));

// Free tiers allow only a few thousand tokens a minute, and one research question makes several
// calls. On HTTP 429 wait as long as the provider asks (retry-after, or Groq's token-reset
// header such as "1m2.5s") and retry, within RATE_WAIT_BUDGET_MS per question.
const RATE_WAIT_BUDGET_MS = 75_000;
export function retryDelayMs(headers) {
  const after = headers?.get?.('retry-after');
  if (after && !Number.isNaN(+after)) return +after * 1000;
  const reset = headers?.get?.('x-ratelimit-reset-tokens') ?? '';
  const m = reset.match(/^(?:(\d+)m)?(?:([\d.]+)s)?$/);
  if (reset && m) return ((+m[1] || 0) * 60 + (+m[2] || 0)) * 1000;
  return 20_000;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// When each model's per-minute limit resets (ms timestamp), shared across questions so a
// limited model is skipped instead of being hit again.
const limitedUntil = new Map();
export const _resetLimits = () => limitedUntil.clear();

function freeAdapter(cfg, { system = SYSTEM, tools = OPENAI_TOOLS, maxTokens = 2000 } = {}) {
  let waited = 0;
  const models = [cfg.model, ...cfg.fallbacks];
  const payload = (model, messages) => ({
    model, messages: [{ role: 'system', content: system }, ...messages], ...(tools.length ? { tools, tool_choice: 'auto' } : {}), temperature: 0.2, max_tokens: maxTokens,
    // gpt-oss reasoning tokens count against the per-minute limit; keep them short.
    ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
  });
  return {
    async call(messages) {
      let r;
      for (;;) {
        // First model that is not rate-limited; if all are, wait for the earliest reset.
        const now = Date.now();
        const model = models.find((m) => (limitedUntil.get(m) ?? 0) <= now);
        if (!model) {
          const delay = Math.min(...models.map((m) => limitedUntil.get(m))) - now + 300;
          if (waited + delay > RATE_WAIT_BUDGET_MS) break;
          waited += delay;
          await sleep(delay);
          continue;
        }
        try {
          r = await fetchImpl(`${cfg.baseURL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
            body: JSON.stringify(payload(model, messages)),
            signal: AbortSignal.timeout(90_000),
          });
        } catch (e) { throw new Error(`${cfg.label} could not be reached (${e.message})`); }
        if (r.status !== 429) break;
        limitedUntil.set(model, Date.now() + Math.min(retryDelayMs(r.headers), 60_000));
      }
      if (!r) throw new Error(`${cfg.label} free-tier rate limit reached, try again in a minute`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = body.error?.message ?? body[0]?.error?.message ?? r.statusText;
        throw new Error(r.status === 429 ? `${cfg.label} free-tier rate limit reached, try again in a minute` : r.status === 401 || r.status === 403 ? `${cfg.label} rejected the API key` : `${cfg.label} error ${r.status}: ${msg}`);
      }
      const choice = body.choices?.[0];
      if (!choice?.message) throw new Error(`${cfg.label} returned no answer.`);
      const msg = choice.message;
      // Keep the message as returned (Gemini needs its thought signatures echoed back), minus
      // Groq's reasoning text, which would only use up the token limit on the next call.
      const { reasoning, ...kept } = msg;
      messages.push({ ...kept, role: 'assistant', content: msg.content ?? null });
      const toolCalls = (msg.tool_calls ?? []).map((t) => {
        let input = {};
        try { input = typeof t.function.arguments === 'string' ? JSON.parse(t.function.arguments || '{}') : t.function.arguments ?? {}; } catch { /* bad JSON: the tool reports the missing fields */ }
        return { id: t.id, name: t.function.name, input };
      });
      const stop = toolCalls.length ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'content_filter' ? 'refusal' : 'end';
      const text = (typeof msg.content === 'string' ? msg.content : (msg.content ?? []).map((p) => p.text ?? '').join('')).trim();
      return { text, toolCalls, stop, model: body.model ?? cfg.model };
    },
    addToolResults(messages, results) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    },
  };
}

// One plain chat turn without tools, for helpers with their own prompt (Fintel).
// messages: [{ role: 'user' | 'assistant', content: string }]. Returns the reply text.
export async function chatAnswer(system, messages, { maxTokens = 1200 } = {}) {
  const chosen = providers()[0];
  if (!chosen) throw new Error('The AI assistant is not set up.');
  const adapter = chosen.id === 'claude'
    ? claudeAdapter({ system, tools: [], effort: 'low', maxTokens: maxTokens * 4 })
    : freeAdapter(freeConfig(), { system, tools: [], maxTokens });
  const r = await adapter.call([...messages]);
  if (r.stop === 'refusal') throw new Error('The model declined this request.');
  if (!r.text) throw new Error(r.stop === 'max_tokens' ? 'The answer was cut off.' : 'The model returned no answer.');
  return r.text;
}

// Recent answers, so a repeated question (e.g. a suggestion chip) returns at once. The key covers
// everything the answer depends on: provider, question, case draft, previous turn and documents.
const CACHE_TTL_MS = 30 * 60_000, CACHE_MAX = 100;
const answerCache = new Map();
export const _clearCache = () => answerCache.clear();
const cacheKey = (provider, question, draft, history) => JSON.stringify([
  provider, question.trim().toLowerCase().replace(/\s+/g, ' '), draft ? `${draft.version}|${draft.generatedAt}` : null,
  history.at(-1)?.answer ?? null, DOCUMENTS.map((d) => d.id).join(','),
]);

// history: [{ question, answer }] from earlier turns of this case (plain text only).
// provider: 'claude' | 'free'; default is the first one configured.
export async function assistantAnswer(question, { draft = null, contextCodes = [], history = [], provider } = {}) {
  if (detectGuaranteeRequest(question)) {
    return { type: 'guardrail', answer: GUARANTEE_RESPONSE, facts: [], passages: [], sources: [], steps: [], mode: 'guardrail' };
  }
  const available = providers();
  const chosen = available.find((p) => p.id === provider) ?? available[0];
  if (!chosen) return null;
  const key = cacheKey(chosen.id, question, draft, history);
  const hit = answerCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return structuredClone(hit.answer);
  const a = await researchWithModel(question, { draft, contextCodes, history, chosen });
  if (a.type === 'answer') {
    answerCache.delete(key);
    answerCache.set(key, { at: Date.now(), answer: structuredClone(a) });
    if (answerCache.size > CACHE_MAX) answerCache.delete(answerCache.keys().next().value);
  }
  return a;
}

async function researchWithModel(question, { draft, contextCodes, history, chosen }) {
  const adapter = chosen.id === 'claude' ? claudeAdapter() : freeAdapter(freeConfig());
  const { sources, run } = makeExecutor({ draft, contextCodes });
  const steps = [];
  let evidence = question;
  const messages = [];
  for (const h of history.slice(-6)) {
    if (!h.question || !h.answer) continue;
    messages.push({ role: 'user', content: h.question }, { role: 'assistant', content: h.answer });
    evidence += '\n' + h.answer;
  }
  messages.push({ role: 'user', content: question + (draft ? '\n\n(A client case is open; use get_client_case if the question is about this client.)' : '') });

  let corrections = 0;
  for (let turn = 0; turn < MAX_TURNS + MAX_CORRECTIONS + 1; turn++) {
    const response = await adapter.call(messages);
    if (response.stop === 'refusal') throw new Error('The model declined this request.');

    if (response.stop === 'tool_use') {
      if (turn >= MAX_TURNS) throw new Error('The assistant used too many tool calls without answering.');
      const results = [];
      for (const b of response.toolCalls) {
        let content, isError = false;
        try {
          if (!run[b.name]) throw new Error(`Unknown tool ${b.name}`);
          content = String(await run[b.name](b.input ?? {}));
        } catch (e) { content = `Error: ${e.message}`; isError = true; }
        steps.push({ tool: b.name, input: b.input, ok: !isError, summary: isError ? content : `${content.split('\n').length} result line(s)` });
        evidence += '\n' + content;
        results.push({ id: b.id, content, isError });
      }
      adapter.addToolResults(messages, results);
      continue;
    }

    // Some models cite as 【S1】 or [S1, S3]; normalise to [S1][S3] so the UI can link them.
    const text = response.text
      .replace(/[【［[]\s*(S\d+(?:\s*[,，]\s*S\d+)*)\s*[】］\]]/g, '[$1]')
      .replace(/\[(S\d+(?:\s*,\s*S\d+)+)\]/g, (_, ids) => ids.split(/\s*,\s*/).map((id) => `[${id}]`).join(''));
    if (response.stop === 'max_tokens' && !text) throw new Error('The answer was cut off.');
    const bad = unsupportedNumbers(text, evidence);
    if (bad.length && corrections < MAX_CORRECTIONS) {
      corrections++;
      messages.push({ role: 'user', content: `Your answer contains figures that do not appear in any tool result: ${bad.join(', ')}. Rewrite the answer using only figures copied exactly from the tool results, or remove them.` });
      continue;
    }
    if (bad.length) {
      return {
        type: 'not_found', answer: `The AI agent could not verify every figure in its answer against the sources (${bad.join(', ')}), so the answer was withheld. Try asking more specifically, or check the documents directly.`,
        facts: [], passages: [], sources: [], steps, mode: 'ai-agent', provider: chosen.id,
      };
    }
    const cited = new Set((text.match(/\[S\d+\]/g) || []).map((s) => s.slice(1, -1)));
    return {
      type: 'answer',
      answer: text,
      sources: sources.filter((s) => cited.has(s.id)),
      allSources: sources.length,
      steps,
      facts: [], passages: [],
      mode: 'ai-agent',
      provider: chosen.id,
      model: response.model,
      note: !cited.size && sources.length ? 'The answer has no citations; verify it against the documents before relying on it.' : null,
    };
  }
  throw new Error('The assistant did not finish.');
}
