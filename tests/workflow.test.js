// End-to-end approval workflow against a real server on a temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { senior, patna } from './fixtures.js';

const port = 4500 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-'));
let server;

const raw = async (p, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
const call = raw;

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), DB_PATH: path.join(dbDir, 't.db'), ANTHROPIC_API_KEY: '', FREE_AI_API_KEY: '', SMTP_HOST: '', APP_URL: '' }, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('running') && resolve());
    server.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});
after(() => server.kill());

test('no sign-in: the co-pilot and its data are open', async () => {
  assert.equal((await raw('/')).status, 200);
  assert.equal((await raw('/app.html')).status, 200);
  assert.equal((await raw('/api/cases')).status, 200);
  assert.equal((await raw('/docs/ppfcf-sid.pdf')).status, 200);
  const login = await raw('/login.html');
  assert.equal(login.status, 302, 'old sign-in links redirect');
  assert.equal(login.headers.get('location'), '/app.html#/onboard');
  assert.equal((await raw('/api/auth/me')).status, 404, 'account API removed');
  const stats = await raw('/api/public-stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.json.funds > 0 && !('client_name' in stats.json));
  assert.equal(typeof stats.json.cases, 'number');
  for (const p of ['/app.html::$DATA', '/%E0%A4%A']) assert.equal((await raw(p)).status, 400, p);
});

test('client output is blocked until approval; high flags need justification', async () => {
  const { json: v } = await call('/api/cases', { client: senior });
  assert.equal(v.draft.status, 'PENDING_REVIEW');
  assert.equal(v.draft.shareToken, undefined, 'no client link before approval');
  assert.equal((await call(`/client/${v.id}`)).status, 404, 'case numbers are not report links');

  const blocked = await call(`/api/cases/${v.id}/review`, { action: 'approve', adviser: 'A. Sharma' });
  assert.equal(blocked.status, 422);
  assert.deepEqual(blocked.json.missing, v.draft.guardrails.blocking);

  const justifications = Object.fromEntries(v.draft.guardrails.blocking.map((id) => [id, 'Discussed with client; small-cap request declined, diversified plan agreed.']));
  assert.equal((await call(`/api/cases/${v.id}/review`, { action: 'approve', registration: 'not-a-number', justifications })).status, 400);
  // The decision is signed with the name the adviser set in Settings.
  const ok = await call(`/api/cases/${v.id}/review`, { action: 'approve', adviser: '  Anita Sharma ', registration: 'ina000012345', justifications });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.draft.status, 'APPROVED');
  assert.equal(ok.json.reviews[0].adviser, 'Anita Sharma · INA000012345');
  assert.match(ok.json.draft.shareToken, /^[\w-]{32}$/);
  assert.equal((await raw(`/client/${v.id}`, null, 'GET', '')).status, 404);
  const report = await raw(`/client/${ok.json.draft.shareToken}`, null, 'GET', '');
  assert.equal(report.status, 200);
  assert.match(report.text, /Approved by Anita Sharma · INA000012345/);
  assert.match(report.text, /cannot be guaranteed/);
  assert.ok(ok.json.audit.some((a) => a.event === 'APPROVAL_BLOCKED'));

  // A new version retires the old link until the next approval.
  const re = await call(`/api/cases/${v.id}`, { adviserNotes: 'Added a note.' }, 'PUT');
  assert.equal(re.json.history[0].created_by, 'Adviser', 'unnamed changes are signed as Adviser');
  assert.equal((await raw(`/client/${ok.json.draft.shareToken}`, null, 'GET', '')).status, 403);
});
test('reject, then edit and resubmit creates a new version with recorded changes', async () => {
  const { json: v } = await call('/api/cases', { client: patna });
  assert.equal((await call(`/api/cases/${v.id}/review`, { action: 'reject', adviser: 'A. Sharma' })).status, 400, 'reason required');
  const rej = await call(`/api/cases/${v.id}/review`, { action: 'reject', adviser: 'A. Sharma', note: 'Retirement target too high, revisit.' });
  assert.equal(rej.json.draft.status, 'REJECTED');
  assert.equal((await call(`/api/cases/${v.id}/review`, { action: 'approve', adviser: 'A. Sharma' })).status, 409);

  const client = { ...patna, goals: patna.goals.map((g, i) => (i === 0 ? { ...g, currentCost: 15000000 } : g)) };
  const debt = v.draft.funds.find((f) => f.sleeve === 'debt');
  const alt = debt.eligible[1].code;
  const re = await call(`/api/cases/${v.id}`, { client, overrides: { debt: alt }, adviserNotes: 'Lowered retirement target.', adviser: 'A. Sharma' }, 'PUT');
  assert.equal(re.json.draft.version, 2);
  assert.equal(re.json.draft.status, 'PENDING_REVIEW');
  const changes = re.json.history[0].change_summary.map((c) => c.field);
  assert.ok(changes.includes('client.goals.0.currentCost'));
  assert.ok(changes.includes('fundOverride.debt'));
  assert.equal(re.json.draft.funds.find((f) => f.sleeve === 'debt').selected.code, alt);
  assert.equal(re.json.history[1].status, 'REJECTED');
});

test('invalid profiles are rejected', async () => {
  const r = await call('/api/cases', { client: { ...patna, age: 12, goals: [] } });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.length >= 2);
  const goal = patna.goals[0];
  const bad = [
    { age: 'abc' }, { age: 30.5 }, { monthlyIncome: -5 }, { monthlyIncome: 'lots' }, { monthlyExpenses: -1 }, { horizonYears: 0 },
    { emergencySavings: -100 }, { dependants: 2.5 }, { name: { first: 'x' } }, { name: 'x'.repeat(101) },
    { goals: [{ ...goal, years: 0.5 }] }, { goals: [{ ...goal, currentCost: 'abc' }] }, { goals: [{ ...goal, existingSavings: -1 }] },
    { goals: Array.from({ length: 11 }, () => goal) },
  ];
  for (const change of bad) {
    const res = await call('/api/cases', { client: { ...patna, ...change } });
    assert.equal(res.status, 400, JSON.stringify(change).slice(0, 80));
  }
  assert.equal((await call('/api/cases', { client: { ...patna, emergencySavings: '', dependants: '' } })).status, 201, 'optional fields may be blank');
});

test('document library: search, page text, built-in documents cannot be deleted', async () => {
  const s = await call('/api/docs/search?q=exit%20load');
  assert.equal(s.status, 200);
  assert.ok(s.json.hits.length > 0 && s.json.hits[0].url.includes('#page='));
  const pg = await call(`/api/docs/${s.json.hits[0].doc}/pages/${s.json.hits[0].page}`);
  assert.ok(pg.json.text.length > 50);
  assert.equal((await call('/api/docs/sebi-cat-2017', null, 'DELETE')).status, 403);
  assert.equal((await call('/api/docs?title=x', null, 'POST')).status, 400);
});
