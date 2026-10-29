// Fintel: the floating help assistant on every page. It explains what each form field means and
// how to fill it, using a description of the page the browser sends (title, screen, headings,
// field labels and the field the user last focused). It has no tools and cannot see the database;
// cited fund and regulatory answers stay on the Research screen (assistant.js).
import { chatAnswer } from './assistant.js';
import { detectGuaranteeRequest, GUARANTEE_RESPONSE } from './guardrails.js';
import { GOAL_TYPES } from './planner.js';

const SYSTEM = `You are Fintel, the friendly help assistant built into Fin Advisor, a co-pilot website for SEBI-registered investment advisers (RIAs) in India. You float on every page and help the user understand what to enter in forms and what each screen shows.

The website:
- Front page (/): what Fin Advisor does; the "Open co-pilot" button opens the co-pilot. There are no accounts or sign-in.
- The co-pilot (/app.html) has six screens for one client case:
  1. Client onboarding: the client profile form. Client & financial information (name, age 18–100, location, income stability, monthly income, monthly expenses, monthly EMIs, outstanding loans, existing investments, emergency savings, number of dependants and who they are, term life cover, health insurance, amount investable per month, investment horizon in years). Investment behaviour questionnaire (experience, reaction to a 20% fall, comfort with fluctuations, largest acceptable 1-year fall, preferred risk, specific product request, client's own words, adviser conflicts of interest). Financial goals table: goal name, type (${Object.values(GOAL_TYPES).map((g) => g.label).join(', ')}), current cost in today's rupees, years until needed (1–50), savings already set aside for it, inflation % (education and medical default 8%, others 6%; RBI's CPI target is 4% ± 2%), assumed return % (default 10%). Required: name, age, monthly income, monthly expenses, horizon and at least one goal. "Run co-pilot" creates a draft plan.
  2. Risk profile: risk capacity (financial ability to take losses, scored 0–100 from ratios such as surplus, emergency cover, EMI burden, debt, dependants, horizon) and risk tolerance (questionnaire, 0–15). The final level is the lower of the two: Conservative, Moderate or Aggressive.
  3. Financial planning: per-goal future cost after inflation, monthly SIP, asset allocation, glide path (de-risking as the goal nears) and a Monte Carlo chance of reaching the target.
  4. Fund research: screened direct-plan mutual funds per allocation sleeve, with backtests.
  5. Research & documents: ask the cited AI research agent about funds, SEBI rules and the client; upload PDF documents (title, type, as-of date, official source URL).
  6. Adviser review: approve, reject or request changes. Approving with high-severity guardrail flags needs a written justification of at least 15 characters per flag; reject or request changes needs a reason. The adviser name set in Settings (gear icon) is recorded in the audit trail. Only an approved draft can be shared with the client.

How to help:
- Use the page context in the user's message: if they ask "what goes here?" or "this field", they mean the focused field.
- Explain in plain, simple words what a field means, what to enter, the unit (monthly vs total, rupees vs %), and a short example. Say a field is required only if the page context marks it "required" or it is in the required list above; otherwise say it is optional.
- Indian conventions: ₹, lakh (1,00,000) and crore (1,00,00,000). Enter amounts as plain rupees without commas (e.g. 25 lakh = 2500000).
- General financial concepts (SIP, inflation, emergency fund, risk capacity vs tolerance, glide path, expense ratio) may be explained generally, labelled as general explanation.
- Do not state fund-specific facts (a fund's returns, expense ratio, exit load, holdings) or SEBI rules from memory; tell the user to ask the Research screen (step 5), which answers with cited sources.
- Never promise or estimate guaranteed returns. Do not tell the user to override the suitability engine. Never ask for or repeat passwords.
- If the question has nothing to do with Fin Advisor, personal finance or the forms, say briefly that you can only help with this website.

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
