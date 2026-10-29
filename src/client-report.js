// Server-rendered, printable client report. Only served for an APPROVED draft.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (x) => '₹' + Math.round(x).toLocaleString('en-IN');
const pct = (x, d = 1) => (x == null ? 'n/a' : (x * 100).toFixed(d) + '%');

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--paper:#f7f3ea;--card:#fffdf8;--ink:#1f2a2e;--muted:#5d6a6d;--line:#e3dccb;--teal:#0f5c5a;--saffron:#c8741c;--red:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 Inter,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1,h2{font-family:Fraunces,Georgia,serif;font-weight:600;letter-spacing:-.01em}
h1{font-size:30px;margin:0 0 4px}h2{font-size:20px;margin:32px 0 10px;color:var(--teal)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
td.n{text-align:right;font-variant-numeric:tabular-nums}.stamp{display:inline-block;border:2px solid var(--teal);color:var(--teal);border-radius:8px;padding:4px 10px;font-weight:600;transform:rotate(-2deg)}
.muted{color:var(--muted)}ul{padding-left:18px}.warn{color:var(--red)}
@media print{body{background:#fff}.card{break-inside:avoid}}
</style></head><body><main>${body}</main></body></html>`;

export function renderBlocked(status) {
  if (status === 'NOT_FOUND') return shell('Link not found', `<h1>Link not found</h1>
  <div class="card"><p>This report link is not valid. Please ask your adviser for the current link.</p></div>`);
  if (status === 'SUPERSEDED') return shell('Plan updated', `<h1>This plan has been updated</h1>
  <div class="card"><p>Your adviser has made a newer version of this plan. Please ask them for the link to the latest approved version.</p></div>`);
  return shell('Not yet approved', `<h1>Not available to the client</h1>
  <div class="card"><p>This recommendation is <b>${esc(status.replace(/_/g, ' ').toLowerCase())}</b>. Client-facing output is released only after the adviser approves the latest draft.</p>
  <p class="muted">Every attempt to open this page before approval is recorded in the audit log.</p></div>`);
}

export function renderClientReport(d, { version, adviser, approvedAt }) {
  const c = d.client;
  const goals = d.plan.goals.map((g) => `
    <div class="card"><h3 style="margin:0 0 6px;font-family:Fraunces,serif">${esc(g.name)} <span class="muted" style="font:13px Inter">· ${esc(g.typeLabel)} · in ${g.years} years</span></h3>
    <p>Today's cost ${inr(g.currentCost)} becomes about <b>${inr(g.futureCost)}</b> at ${pct(g.inflation)} assumed inflation. Monthly investment: <b>${inr(g.recommendedSip)}</b>.</p>
    <table><tr><th>Fund</th><th>Sleeve</th><th class="n">Share</th><th class="n">Monthly SIP</th></tr>
    ${g.instructions.lines.map((l) => `<tr><td>${esc(l.fund)}</td><td>${esc(l.sleeveLabel)}</td><td class="n">${l.weight}%</td><td class="n">${inr(l.monthly)}</td></tr>`).join('')}</table>
    ${g.instructions.shifts.length ? `<p class="muted" style="margin-top:10px">As the goal approaches, money moves from equity to safer funds:</p><ul>${g.instructions.shifts.map((s) => `<li>${esc(s.text.split('. ')[0])}</li>`).join('')}</ul>` : ''}
    </div>`).join('');
  return shell(`Investment plan – ${c.name}`, `
  <p class="muted" style="margin:0">Investment plan · draft v${version}</p>
  <h1>${esc(c.name)}</h1>
  <p><span class="stamp">Approved by ${esc(adviser)} · ${esc(approvedAt.slice(0, 10))}</span></p>
  <h2>Your risk profile</h2>
  <div class="card"><p>Ability to take risk: <b>${esc(d.risk.capacity.level)}</b> · Comfort with risk: <b>${esc(d.risk.tolerance.level)}</b> · Plan follows: <b>${esc(d.risk.final.level)}</b></p>
  <p class="muted">${d.risk.reasons.map(esc).join(' ')}</p></div>
  <h2>Your goals and monthly investments</h2>${goals}
  <div class="card"><b>Total monthly investment: ${inr(d.plan.totalSip)}</b></div>
  ${d.adviserNotes ? `<h2>Note from your adviser</h2><div class="card">${esc(d.adviserNotes)}</div>` : ''}
  <h2>Important</h2><div class="card"><p class="warn">${esc(d.disclosures.returns)}</p><ul>${[...d.disclosures.general.slice(0, 2), ...d.disclosures.conflicts].map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`);
}
