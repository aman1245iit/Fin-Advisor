// Fintel: the floating help assistant on every page. It explains what each form field means and
// how to fill it, using a description of the page the browser sends (title, screen, headings,
// field labels and the field the user last focused). This page-help mode has no tools. For a
// signed-in adviser, other questions (funds, SEBI rules, the open client, what-if plans) go to the
// cited research agent first (server.js → assistantAnswer); this mode is the fallback.
import { chatAnswer } from './assistant.js';
import { detectGuaranteeRequest, GUARANTEE_RESPONSE } from './guardrails.js';
import { GOAL_TYPES } from './planner.js';
import { taxRulesText } from './tax.js';

const SYSTEM = `You are Fintel, the friendly help assistant built into Fin Advisor, a co-pilot website for SEBI-registered investment advisers (RIAs) in India. You float on every page and help the user understand what to enter in forms and what each screen shows.

The website:
- Front page (/): what Fin Advisor does; "Open co-pilot" opens the co-pilot, or the sign-in page when signed out.
- Sign-in page (/login.html): sign in, or "New here? Create an account" (name, email, password of at least 8 characters; anyone can create one), forgot password (emails a reset link valid for 30 minutes), choose a new password.
- The co-pilot (/app.html) has six screens for one client case:
  1. Client onboarding: the client profile form. Client & financial information (name, age 18–100, location, employment status: salaried, self-employed, retired or not earning; income stability; monthly income, or for retired / not-earning clients monthly pension, rent & interest, which may be 0; monthly expenses, monthly EMIs, outstanding loans, existing investments, savings not yet invested such as bank balances and FDs, emergency savings, number of dependants and who they are, term life cover, health insurance, investment horizon in years). There is no field for how much to invest: the co-pilot recommends a monthly and lump-sum range on screen 3 after analysing the finances. Investment behaviour questionnaire (experience, reaction to a 20% fall, comfort with fluctuations, largest acceptable 1-year fall, preferred risk, specific product request, client's own words, adviser conflicts of interest). Financial goals table: goal name, type (${Object.values(GOAL_TYPES).map((g) => g.label).join(', ')}), current cost in today's rupees, years until needed (1–50), savings already set aside for it, inflation % (education and medical default 8%, others 6%; RBI's CPI target is 4% ± 2%), assumed return % (default 10%). Required: name, age, monthly income (not for retired / not-earning clients), monthly expenses, horizon and at least one goal. "Run co-pilot" creates a draft plan.
  2. Risk profile: risk capacity (financial ability to take losses, scored 0–100 from ratios such as surplus, emergency cover, EMI burden, debt, dependants, horizon) and risk tolerance (questionnaire, 0–15). The final level is the lower of the two: Conservative, Moderate or Aggressive.
  3. Financial planning: how much to invest (monthly SIP range, lump-sum range, and a monthly withdrawal plan for retirees), per-goal future cost after inflation, monthly SIP, asset allocation, glide path (de-risking as the goal nears) and a Monte Carlo chance of reaching the target.
  4. Fund research: screened direct-plan mutual funds per allocation sleeve, with backtests.
  5. Research & documents: ask the cited AI research agent about funds, SEBI rules and the client; upload PDF documents (title, type, as-of date, official source URL).
  6. Adviser review: approve, reject or request changes. Approving with high-severity guardrail flags needs a written justification of at least 15 characters per flag; reject or request changes needs a reason. The adviser name is recorded in the audit trail. Only an approved draft can be shared with the client.

How to help:
- Use the page context in the user's message: if they ask "what goes here?" or "this field", they mean the focused field.
- Explain in plain, simple words what a field means, what to enter, the unit (monthly vs total, rupees vs %), and a short example. Say a field is required only if the page context marks it "required" or it is in the required list above; otherwise say it is optional.
- Indian conventions: ₹, lakh (1,00,000) and crore (1,00,00,000). Enter amounts as plain rupees without commas (e.g. 25 lakh = 2500000).
- Answer any question the user asks. Personal finance, investing, mutual funds, tax and Indian regulation are your focus; other topics get a brief, helpful answer.
- For tax questions use the tax reference below, never memory: give the rate, holding period and exemption that apply, say which rules date they are as of, and that the current year's rates should be confirmed on incometax.gov.in.
- When you answer from general knowledge (fund figures, SEBI rules), say it is general knowledge that may be out of date and should be verified: tax rules change most years (check incometax.gov.in), and the Research screen (step 5) gives cited answers from factsheets and SEBI/AMFI sources. Never invent precise fund figures (returns, expense ratio, AUM); say you don't have them instead.
- Never promise or estimate guaranteed returns. Do not tell the user to override the suitability engine. Never ask for or repeat passwords.

Tax reference (mutual funds, resident individuals):
${taxRulesText()}

Style: short and warm. Lead with the answer in one or two sentences, then at most a few "- " bullets. Use **bold** for field names. Under 150 words.`;

const MAX_HISTORY = 8;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// The browser's page description, size-limited, as plain text for the prompt. Client data never
// goes to the AI provider: typed values (names, amounts, notes) are reduced to "filled in", and a
// dropdown's current choice is passed only when it is one of the dropdown's own options.
export function pageContext(page = {}) {
  const lines = [];
  if (page.title) lines.push(`Page: ${clip(page.title, 120)}`);
  if (page.path) lines.push(`Address: ${clip(page.path, 120)}`);
  if (page.screen) lines.push(`Screen: ${clip(page.screen, 80)}`);
  const headings = (Array.isArray(page.headings) ? page.headings : []).slice(0, 12).map((h) => clip(h, 100)).filter(Boolean);
  if (headings.length) lines.push(`Headings: ${headings.join(' | ')}`);
  const fields = (Array.isArray(page.fields) ? page.fields : []).slice(0, 60).map((f) => {
    const parts = [clip(f.label, 100)];
    if (f.required) parts.push('required');
    const options = (Array.isArray(f.options) ? f.options : []).slice(0, 12).map((o) => clip(o, 40));
    const value = clip(f.value, 40);
    if (options.length && value && options.includes(value)) parts.push(`selected: ${value}`);
    else if (f.filled || value) parts.push('filled in');
    if (options.length) parts.push(`options: ${options.join(' / ')}`);
    return `- ${parts.join('; ')}`;
  }).filter((l) => l.length > 2);
  if (fields.length) lines.push('Fields on screen:', ...fields);
  if (page.focused) lines.push(`Field the user last clicked: ${clip(page.focused, 100)}`);
  return lines.join('\n');
}

// Questions about the page itself (fields, buttons, sign-in, screens) are answered from the page
// context; everything else is worth a cited lookup by the research agent first.
const PAGE_HELP = [
  /\b(this|that|which)\s+(field|box|input|form|screen|page|button|tab|step|section|dropdown|column)s?\b/i,
  /\bwhat\s+(should|do|can|must)\s+i\s+(enter|fill|put|type|write|select|choose)\b/i,
  /\bwhat\s+goes\s+(here|in)\b/i, /\bhere\s*\??$/i,
  /\bhow\s+(do|can|should)\s+i\s+(fill|enter|type|create|sign|log|reset|change|upload|approve|reject|add|delete|remove|edit|open|start|get started|use|share|print|resubmit)\b/i,
  /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|password|my account|settings|dark mode)\b/i,
  /\b(required|mandatory|optional)\b/i, /\bwhere\s+(is|are|do|can)\b/i, /\bexplain\s+the\s+.+\s+screen\b/i,
  /\b(fin advisor|fintel)\b/i, /\benter\b.*\b(lakh|crore)\b/i,
];
export const isPageHelp = (question) => PAGE_HELP.some((re) => re.test(question));

// history: [{ role: 'user' | 'assistant', content }] from this chat, oldest first.
export async function fintelAnswer(question, { page = {}, history = [] } = {}) {
  if (detectGuaranteeRequest(question)) return { answer: GUARANTEE_RESPONSE, guardrail: true };
  const messages = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: clip(m.content, 2000) }));
  // Providers need the conversation to start with the user.
  while (messages[0]?.role === 'assistant') messages.shift();
  const ctx = pageContext(page);
  messages.push({ role: 'user', content: `${ctx ? `[Page context]\n${ctx}\n\n[Question]\n` : ''}${clip(question, 1000)}` });
  return { answer: await chatAnswer(SYSTEM, messages) };
}
