# Fin Advisor — Adviser Co-pilot

A working co-pilot for a SEBI-registered Investment Adviser (RIA). The adviser enters a client once; the co-pilot profiles risk, builds goal-based mutual fund plans, screens direct-plan funds from the AMFI universe, backtests the mix over ten years, answers research questions from official documents with page citations, and runs suitability guardrails. **Nothing reaches the client until the adviser approves it.**

```
npm install
npm start            # http://localhost:4400
npm test             # 36 tests: engines, glide path, Monte Carlo, options, guardrails, research, AI assistant, workflow
```

Optional: put a free key in `.env` as `FREE_AI_API_KEY` (Groq `gsk_…`, Google Gemini `AIza…` or OpenRouter `sk-or-…`; see `.env.example`) or set `ANTHROPIC_API_KEY` to turn on the **AI research & planning agent**. Claude is used when both are set. The Research screen needs one of these keys: every question is answered by the AI agent. Every figure comes from the engines, the documents or official SEBI-regulated sources (see *Integration principle*).

**Accounts.** The co-pilot needs sign-in (the front page, its statistics and approved client reports stay public). On first run, open http://localhost:4400 and use the person icon to create the first adviser account (name, email, password). **Forgot password?** on the sign-in page emails a one-time reset link that expires after 30 minutes; set up SMTP in `.env` (section 3, e.g. a Gmail App Password) to send real emails, otherwise the link is printed in the server window. In the co-pilot, the gear icon opens **Settings**: theme (System / Light / Dark), the name and SEBI registration used to sign approvals, the start screen (new client or the last case), workspace status, and sign out. `npm run reset-password -- <email>` on the server issues a temporary password as a last resort. The public pages also include **About us**, **Contact us**, **Privacy policy** and **Terms & conditions** (`/about.html`, `/contact.html`, `/privacy.html`, `/terms.html`), linked from every footer. Contact-form messages are emailed to `CONTACT_EMAIL` (default: `SMTP_USER`), or printed in the server window without SMTP; each IP can send 5 per hour. Passwords are stored as scrypt hashes; sessions are HttpOnly cookies; 5 failed sign-ins lock an email for 15 minutes, and reset emails are limited to 3 per 15 minutes.

## Workflow

```
Client profile submitted → Risk & suitability checks → Goal-based plan → Fund research & backtest
→ Guardrail validation → Draft on adviser dashboard → Adviser reviews / edits
→ Approve or reject → Client output released only after approval
```

| Screen | What it shows |
|---|---|
| 1 Client onboarding | One form: finances, liabilities, dependants, behaviour questionnaire, product requests, goals. No preloaded clients: every case starts from a blank profile. |
| 2 Risk profile | Capacity vs tolerance scores, factor tables, conflict-resolution matrix, conflicts requiring review. |
| 3 Financial planning | Future cost, SIP (effective, nominal, glide-path), chance of reaching each goal and SIP for 80% confidence, allocation, **four "where to invest" options**, glide path, de-risking schedule with ₹ switch amounts, Monte Carlo goal projection. |
| 4 Fund research | Selection criteria, shortlist per sleeve with reasons, excluded funds, performance, 10-year backtest vs benchmarks. |
| 5 Research & documents | AI research agent (library, engines and official SEBI-regulated sources) with cited answers, comparisons and follow-ups; document library with full-text search, page viewer, PDF upload. |
| 6 Adviser review | Full draft, warnings, calculations, sources, disclosures; **Approve / Reject / Request changes / Edit and resubmit**; version history with field-level change log; audit trail; client report link (HTTP 403 until approved). |

## 1. Risk profiling (`src/engine/risk.js`)

**Risk capacity**: every factor is scored **out of 10**, then combined as a simple average (all factors count equally) and scaled ×10, so the capacity score is out of 100.

| Factor | Score out of 10 |
|---|---|
| Age | ≤29: 10 · 30–39: 8 · 40–49: 6 · 50–59: 4 · 60+: 2 |
| Horizon | <3y: 0 · 3–4: 2 · 5–6: 4 · 7–9: 6 · 10–14: 8 · 15+: 10 |
| Monthly surplus after expenses & EMIs, % of income | ≤10%: 0 · ≤25%: 4 · ≤40%: 7 · more: 10 |
| Emergency savings, months of outgo | ≤1: 0 · ≤3: 3 · ≤6: 6 · more: 10 |
| EMI burden, % of income | 0: 10 · ≤10%: 8 · ≤30%: 5 · ≤50%: 2 · more: 0 |
| Dependants | 0: 10 · 1: 7 · 2: 5 · 3: 3 · 4+: 1 |
| Income stability | stable 10 · variable 6 · irregular 0 |

Low < 40 ≤ Medium < 70 ≤ High (out of 100). Hard caps: horizon < 3 years → Low; horizon < 5 years or age ≥ 65 → at most Medium.

**Risk tolerance**: five questions scored 0–3 (experience, reaction to a 20% fall, comfort with fluctuations, largest acceptable one-year fall, stated preference). Conservative ≤ 5 < Moderate ≤ 10 < Aggressive.

**Conflict rule:** proposed level = **the lower of capacity and tolerance**, so it never exceeds either. Goal-level horizon, liquidity and loss rules can lower it further. Flagged conflicts: capacity above tolerance (medium), tolerance above capacity (high), inconsistent answers (e.g. "high" preference but would sell in a fall), and an aggressive profile with near-term obligations (goal within 3 years, emergency fund < 3 months, or EMIs > 40% of income).

Patna example (38, ₹1.5 L income, ₹60 k expenses, 22 years, parents, low risk) → Capacity **High** (84.3/100), Tolerance **Conservative** (4) → **Conservative**: *"low tolerance for market volatility"*.

## 2. Goal planning (`src/engine/planner.js`)

* Future cost `FV = C(1+i)^n`. Worked check: ₹25 L at 6% for 15 years = ₹59.91 L.
* Monthly rate uses the **effective annual convention** `r = (1+R)^(1/12) − 1`. The nominal `R/12` SIP is shown alongside it.
* SIP `P = FV_gap·r / ((1+r)^N − 1)`, paid at the end of each month. Existing savings grow at R and are subtracted.
* **Glide-path SIP:** the allocation is recomputed every year, and the SIP is solved against the falling expected return. The recommended SIP is the higher of the flat and glide-path SIPs.
* **Projection:** the deterministic line uses the recommended SIP on the glide path. A **Monte Carlo** simulation (2,000 paths, monthly log-normal returns, each year's mean and volatility from that year's allocation, fixed seed so drafts are reproducible) gives the 10th–90th percentile range, the **chance of reaching the target**, and the **SIP needed for 75 / 80 / 90% confidence**. Saving at the *expected* return reaches the target only about half the time, which is why the confidence SIPs are shown.

**Allocation rules (per goal, re-run each year → glide path)**
1. Base equity by risk level: 35 / 60 / 80%.
2. Loss cap: equity ≤ max acceptable fall ÷ 40% assumed equity stress fall.
3. Essential goals (education, medical, emergency): −10 points of equity. Medical keeps ≥ 20% liquid.
4. **Glide:** equity = long-term equity × clamp((years left − 3) ÷ 7). Full equity at 10+ years, a little less each year after that, **0% inside 3 years**. No single-year cliffs.
5. Liquid share of the non-equity money rises linearly from 0% at 5 years to 100% at 2 years. Gold (5–10%) tapers from 5 years to 0 at 2 years.
6. Equity split by risk level across large, flexi, mid and small caps. Mid and small caps are folded into large caps for goals under 7 years.

**De-risking schedule:** every year where the mix changes becomes a switch, with the projected corpus and the ₹ amount to move. Years are grouped into Growth, Transition and Capital-protection phases, with execution notes (redirect SIPs first, STP over 3–6 months, check exit loads and capital-gains tax).

**Where to invest (options):** the same allocation filled four ways, using only funds that passed screening. *Recommended* (top-ranked), *Low-cost index* (index fund where eligible, else lowest TER), *Alternative picks* (runner-up, preferring a different AMC) and *Simple* (all equity in one flexi-cap fund). Each shows weighted TER, fund/AMC count and a 10-year backtest. The first three can be applied to the draft in one click, which creates a new version for review.

Asset assumptions for projections (illustrative, not forecasts): return large 10%, flexi 10.5%, mid 11.5%, small 12%, debt 6.75%, liquid 6%, gold 7%; volatility 16 / 17 / 21 / 25 / 3 / 0.5 / 14%.

## 3. Fund screening & backtest (`src/engine/funds.js`, `backtest.js`)

**Universe:** 23 direct-plan growth schemes across 8 sleeves (Nippon India and PPFAS) whose official factsheets could be downloaded. AMFI scheme codes, plan type and latest NAV come from AMFI `NAVAll.txt`. Full NAV history comes from the AMFI-code mirror at `api.mfapi.in`, and each scheme's latest NAV was cross-checked against AMFI (all 23 match). TER, AUM, managers, manager start dates, benchmark and tracking error were extracted from the factsheet pages with **page references**. AUM on PPFAS pages is matched by text position, because the flattened text order is unreliable there.

**Screening sequence:** (1) direct plan + growth option in the required sleeve → (2) exclude missing or unreliable critical data → (3) thresholds below → (4) percentile ranking → (5) shortlist with a written reason.

| Group | Min history | Min AUM | Max TER | Other |
|---|---|---|---|---|
| Equity (active) | 5y | ₹1,000 Cr | 1.0% | lead manager ≥ 2y |
| Equity (index) | 5y | ₹500 Cr | 0.5% | tracking error ≤ 0.5% |
| Debt | 5y | ₹1,000 Cr | 0.6% | manager ≥ 1y |
| Liquid / arbitrage | 3y | ₹1,000 Cr | 0.4% | |
| Gold | 5y | ₹500 Cr | 0.5% | |

Ranking weights: median rolling 1-year return 30%, max drawdown 20%, TER 20%, volatility 10%, AUM 10%, stewardship 10% (manager tenure, or tracking error for index funds). Metrics come from direct-plan NAVs over a common 5-year window (3 years for liquid).

**Backtest:** monthly NAVs (last NAV on or before month end; > 10 days stale = missing), `R_p = Σ wᵢRᵢ`, annual rebalancing, ₹1 L start, 120 months. It reports cumulative return, CAGR, annualised volatility, max drawdown, best and worst 12 months, and value over time. Benchmarks: a Nifty 50 index fund (direct), plus a passive reference (same equity share in that fund, the rest in a liquid fund). NAVs are net of TER. If a chosen fund is younger than 10 years, the oldest eligible fund in the same sleeve is used for the missing months, and this is disclosed.

**Limitations (also shown in the app):** survivorship bias (only today's schemes), look-ahead in selection (funds picked on today's metrics), benchmarks are investable proxies rather than TRI, exit loads, taxes and rebalancing costs are ignored, and the universe covers only two AMCs.

## 4. Research assistant & document library (`src/engine/assistant.js`, `rag.js`)

* **AI agent (with `ANTHROPIC_API_KEY`):** Claude (`claude-opus-5-5`, adaptive thinking, server-side refusal fallback) runs a tool loop over the app's own functions: `search_documents`, `get_fund_facts`, `compare_funds`, `list_funds`, `list_documents`, `read_page`, `get_client_case` and `plan_goal` (a what-if plan for any goal: future cost, SIP, allocation, screened fund and monthly amount per sleeve, chance of success, de-risking). The free provider (`FREE_AI_API_KEY`, any OpenAI-compatible endpoint) runs the same tools and checks. Every tool result is registered as a numbered source [S1], [S2]… and the answer must cite them. The UI shows the cited sources and the research steps.
* **Number check:** every figure in the answer must appear in a tool result or the question. If not, the model is asked to fix it (up to twice); if it still fails, the answer is withheld.
* Guarantee requests ("20% every year") get the fixed compliance text and never reach the model. The agent can explain the suitability engine's output but cannot change it.
* **Official sources:** `search_official_sources` and `read_official_source` (`src/engine/official.js`) let the agent search and read pages and PDFs only on SEBI, AMFI, RBI, NSE, BSE, NSDL, CDSL and SEBI-registered AMC websites. Any other URL is refused, including after redirects. These sources are cited like the library documents.
* **Document retrieval (used by the agent's tools):** BM25 over ~700-character chunks with query expansion (e.g. "exit load" also finds "redemption"), boosted to the named fund's pages. It returns structured facts, a **side-by-side comparison** when several funds are named, case-aware "why was this fund chosen" answers, and highlighted passages. Follow-ups ("what about its TER?") reuse the previous question's fund. 
* **Document library:** 5 built-in official documents (565 pages): PPFAS factsheet (Sep 2026), Nippon India factsheet (Oct 2026), Parag Parikh Flexi Cap SID, Parag Parikh Large Cap SID, SEBI circular SEBI/HO/IMD/DF3/CIR/P/2017/114. It has full-text search with page hits, a page-text viewer, local PDF copies served at `/docs/<file>#page=N`, filters by type, and **PDF upload** (text extracted with pdfjs, indexed immediately, removable). Uploaded documents are stored in `data/docs`, `data/user-docs.json` and `data/user-corpus.json`.

## 5. Guardrails & approval (`src/engine/guardrails.js`, `src/server.js`)

* Flags: unsuitable product requests (small-cap only, 100% equity, sectoral), checked against age, horizon, capacity, tolerance, emergency fund and goal purpose; return guarantees; unrealistic return or inflation assumptions; SIP above surplus or budget; thin emergency fund; high EMIs; missing life or health cover; no eligible fund; adviser overrides to excluded funds; AMC concentration.
* The co-pilot **does not follow** unsuitable requests. The plan stays on the suitability-based allocation.
* High-severity flags block approval until each has a written justification (enforced server-side, HTTP 422).
* Client output is served at `/client/<share token>`: a random link issued when a draft is approved, so reports cannot be found by counting case numbers. It works only while that draft is the latest version; otherwise it returns 403, and each attempt is logged.
* Approvals, rejections and resubmissions are signed by the signed-in account (the adviser can add a SEBI registration number, e.g. INA000012345); a name sent by the browser is ignored.
* Every submission, draft version (with a field-level diff), review decision, research question and client-output access is written to SQLite (`data/copilot.db`).
* Conflict-of-interest disclosure: fee-only, direct plans only, the universe limitation, and adviser-declared conflicts.

**Integration principle:** all figures come from deterministic engines. The language model (optional) only rephrases retrieved, cited text, and cannot override the suitability engine.

## Data refresh

```
npm run data:nav     # re-download AMFI NAVAll + NAV histories, cross-check
npm run data:docs    # re-extract PDF text in data/docs → data/corpus.json
npm run data:meta    # re-extract TER/AUM/managers from factsheet pages
```
To add a fund or document, register it in `src/engine/universe.js` / `src/engine/sources.js`, drop the PDF in `data/docs/`, and rerun the scripts.

*Mutual fund investments are subject to market risks. This prototype is a decision-support tool for a registered adviser, not investment advice.*
