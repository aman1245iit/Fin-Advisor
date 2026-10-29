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
let cookie = ''; // the signed-in adviser's session, sent by call()
let serverOut = ''; // without SMTP, reset emails are printed here
const ADVISER = { name: 'A. Sharma', email: 'a.sharma@example.com', password: 'first-pass-123' };

const raw = async (p, body, method = body ? 'POST' : 'GET', session = cookie) => {
  const r = await fetch(base + p, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  const set = r.headers.get('set-cookie');
  return { status: r.status, json, text, headers: r.headers, cookie: set ? set.split(';')[0] : null };
};
const call = (p, body, method) => raw(p, body, method);

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), DB_PATH: path.join(dbDir, 't.db'), ANTHROPIC_API_KEY: '', FREE_AI_API_KEY: '', SMTP_HOST: '', APP_URL: '' }, stdio: 'pipe' });
  server.stdout.on('data', (d) => { serverOut += d; });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('running') && resolve());
    server.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  // The first account can be created without signing in.
  const r = await raw('/api/auth/signup', ADVISER, 'POST', '');
  assert.equal(r.status, 201);
  cookie = r.cookie;
});

// The reset link from the last email printed to the server console.
async function lastResetLink() {
  await new Promise((res) => setTimeout(res, 100));
  const links = [...serverOut.matchAll(/(http:\/\/localhost:\d+\/login\.html\?reset=[\w-]+)/g)];
  return links.at(-1)?.[1];
}
after(() => server.kill());

test('accounts: sign-in required, settings, email reset link and limits', async () => {
  // Signed out: API and co-pilot are closed; front page, stats and sign-in page are open.
  assert.equal((await raw('/api/cases', null, 'GET', '')).status, 401);
  const page = await raw('/app.html', null, 'GET', '');
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/login\.html\?next=/);
  assert.equal((await raw('/', null, 'GET', '')).status, 200);
  assert.equal((await raw('/login.html', null, 'GET', '')).status, 200);
  const stats = await raw('/api/public-stats', null, 'GET', '');
  assert.equal(stats.status, 200);
  assert.ok(stats.json.funds > 0 && !('client_name' in stats.json));
  assert.ok(!('cases' in stats.json), 'case count hidden from visitors');
  assert.equal(typeof (await raw('/api/public-stats')).json.cases, 'number', 'shown when signed in');
  assert.equal((await raw('/app.html')).status, 200, 'signed in');

  // The session cookie is found even when other cookies come before it (Vercel adds its own).
  assert.equal((await raw('/api/cases', null, 'GET', `_vercel_jwt=abc; theme=dark; ${cookie}`)).status, 200);

  // New advisers can sign up on their own; an email can only be used once.
  const me = (await raw('/api/auth/me', null, 'GET', '')).json;
  assert.equal(me.canSignUp, true);
  assert.equal(me.hasAccounts, true);
  assert.equal(me.persistent, true);
  const newcomer = await raw('/api/auth/signup', { name: 'C. Iyer', email: 'c.iyer@example.com', password: 'newcomer-123' }, 'POST', '');
  assert.equal(newcomer.status, 201);
  assert.match(newcomer.cookie, /^fa_session=/, 'a new adviser is signed in straight away');
  assert.equal((await raw('/api/cases', null, 'GET', newcomer.cookie)).status, 200);
  assert.equal((await raw('/api/auth/signup', { name: 'Again', email: 'C.Iyer@example.com', password: 'another-123' }, 'POST', '')).status, 409);
  const added = await call('/api/auth/signup', { name: 'B. Rao', email: 'b.rao@example.com', password: 'second-pass-123' });
  assert.equal(added.status, 201);
  assert.equal(added.cookie, null, 'adding an adviser keeps your own session');

  // Sign-in: wrong password, then right one; email is case-insensitive.
  assert.equal((await raw('/api/auth/login', { email: ADVISER.email, password: 'nope-nope-1' }, 'POST', '')).status, 401);
  const login = await raw('/api/auth/login', { email: ADVISER.email.toUpperCase(), password: ADVISER.password }, 'POST', '');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);

  // Settings: rename freely; a new password needs the current one.
  assert.equal((await call('/api/auth/me', { name: 'Anita Sharma' }, 'PUT')).json.adviser.name, 'Anita Sharma');
  assert.equal((await call('/api/auth/me', { currentPassword: 'wrong-pass-1', newPassword: 'another-pass-1' }, 'PUT')).status, 401);
  assert.equal((await call('/api/auth/me', { currentPassword: ADVISER.password, newPassword: 'short' }, 'PUT')).status, 400);
  assert.equal((await call('/api/auth/me', { currentPassword: ADVISER.password, newPassword: 'second-pass-456' }, 'PUT')).status, 200);
  assert.equal((await raw('/api/cases', null, 'GET', login.cookie)).status, 401, 'other sessions signed out after a password change');
  assert.equal((await call('/api/cases')).status, 200, 'this session kept');

  // Forgot password: only the email is asked for; the same reply whether or not it has an account.
  const unknown = await raw('/api/auth/forgot', { email: 'nobody@example.com' }, 'POST', '');
  const before = serverOut.length;
  const forgot = await raw('/api/auth/forgot', { email: ADVISER.email }, 'POST', '');
  assert.equal(forgot.status, 200);
  assert.equal(forgot.json.message, unknown.json.message, 'no hint about which emails exist');
  const link = await lastResetLink();
  assert.ok(link && serverOut.indexOf(link) >= before, 'reset link emailed (printed without SMTP)');
  assert.match(serverOut, new RegExp(`To: ${ADVISER.email}`));
  assert.ok(!/nobody@example\.com/.test(serverOut), 'no email for an unknown address');
  const token = new URL(link).searchParams.get('reset');

  // The link sets a new password once, signs out every other session and signs this one in.
  assert.equal((await raw('/api/auth/reset', { token: 'made-up-token', newPassword: 'reset-pass-789' }, 'POST', '')).status, 400);
  assert.equal((await raw('/api/auth/reset', { token, newPassword: 'short' }, 'POST', '')).status, 400);
  const reset = await raw('/api/auth/reset', { token, newPassword: 'reset-pass-789' }, 'POST', '');
  assert.equal(reset.status, 200);
  assert.equal((await raw('/api/auth/reset', { token, newPassword: 'again-pass-000' }, 'POST', '')).status, 400, 'link works once');
  assert.equal((await call('/api/cases')).status, 401, 'reset signs out every session');
  cookie = reset.cookie;
  assert.equal((await call('/api/cases')).status, 200);
  assert.equal((await raw('/api/auth/login', { email: ADVISER.email, password: 'reset-pass-789' }, 'POST', '')).status, 200);

  // A newer password makes older unused links useless; reset emails are limited to 3 per 15 minutes.
  await raw('/api/auth/forgot', { email: ADVISER.email }, 'POST', '');
  const stale = new URL(await lastResetLink()).searchParams.get('reset');
  assert.equal((await call('/api/auth/me', { currentPassword: 'reset-pass-789', newPassword: 'newest-pass-321' }, 'PUT')).status, 200);
  assert.equal((await raw('/api/auth/reset', { token: stale, newPassword: 'whatever-pass-1' }, 'POST', '')).status, 400, 'older link cancelled');
  assert.equal((await raw('/api/auth/forgot', { email: ADVISER.email }, 'POST', '')).status, 200, 'third request allowed');
  assert.equal((await raw('/api/auth/forgot', { email: ADVISER.email }, 'POST', '')).status, 429, 'fourth refused');

  // Five failed attempts lock that email for a while.
  for (let i = 0; i < 4; i++) await raw('/api/auth/login', { email: 'b.rao@example.com', password: 'bad-pass-00' }, 'POST', '');
  assert.equal((await raw('/api/auth/login', { email: 'b.rao@example.com', password: 'second-pass-123' }, 'POST', '')).status, 200, 'under the limit');
  for (let i = 0; i < 5; i++) await raw('/api/auth/login', { email: 'b.rao@example.com', password: 'bad-pass-00' }, 'POST', '');
  assert.equal((await raw('/api/auth/login', { email: 'b.rao@example.com', password: 'second-pass-123' }, 'POST', '')).status, 429);

  // Sign out ends the session.
  const out = await raw('/api/auth/login', { email: ADVISER.email, password: 'newest-pass-321' }, 'POST', '');
  assert.equal((await raw('/api/auth/logout', {}, 'POST', out.cookie)).status, 200);
  assert.equal((await raw('/api/cases', null, 'GET', out.cookie)).status, 401);
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
  // The name sent by the browser is ignored: the decision is signed by the signed-in account.
  const ok = await call(`/api/cases/${v.id}/review`, { action: 'approve', adviser: 'Someone Else', registration: 'ina000012345', justifications });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.draft.status, 'APPROVED');
  assert.equal(ok.json.reviews[0].adviser, 'Anita Sharma · INA000012345'); // the account was renamed in the accounts test
  assert.match(ok.json.draft.shareToken, /^[\w-]{32}$/);
  assert.equal((await raw(`/client/${v.id}`, null, 'GET', '')).status, 404);
  const report = await raw(`/client/${ok.json.draft.shareToken}`, null, 'GET', '');
  assert.equal(report.status, 200);
  assert.match(report.text, /Approved by Anita Sharma · INA000012345/);
  assert.doesNotMatch(report.text, /Someone Else/);
  assert.match(report.text, /cannot be guaranteed/);
  assert.ok(ok.json.audit.some((a) => a.event === 'APPROVAL_BLOCKED'));

  // A new version retires the old link until the next approval.
  const re = await call(`/api/cases/${v.id}`, { adviserNotes: 'Added a note.' }, 'PUT');
  assert.equal(re.json.history[0].created_by, 'Anita Sharma');
  assert.equal((await raw(`/client/${ok.json.draft.shareToken}`, null, 'GET', '')).status, 403);
});

test('sign-in cannot be bypassed with other spellings of a path', async () => {
  for (const p of ['/API/cases', '/Api/meta', '/api/Cases', '/%61pi/cases', '/api%2Fcases']) {
    assert.ok([302, 400, 401, 404].includes((await raw(p, null, 'GET', '')).status), p);
  }
  for (const p of ['/App.html', '/APP.HTML', '/%61pp.html', '/app.html.', '/app.html%20', '/app.html::$DATA', '/DOCS/ppfcf-sid.pdf', '/Docs/ppfcf-sid.pdf', '/docs/ppfcf-sid.pdf']) {
    const r = await raw(p, null, 'GET', '');
    assert.ok([302, 400, 404].includes(r.status), `${p} → ${r.status}`);
  }
  const forged = await raw('/API/cases', { client: patna }, 'POST', '');
  assert.notEqual(forged.status, 201);
  assert.notEqual((await raw('/API/cases/1/review', { action: 'approve', adviser: 'Fake' }, 'POST', '')).status, 200);
  // Signed in, the normal spellings still work.
  assert.equal((await raw('/app.html')).status, 200);
  assert.equal((await raw('/docs/ppfcf-sid.pdf')).status, 200);
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
