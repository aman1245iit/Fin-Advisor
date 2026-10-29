// Adviser accounts: sign-up, sign-in, sessions, settings and password reset by email.
//
// Passwords are stored as scrypt hashes. Sessions are random tokens in an HttpOnly cookie;
// only their SHA-256 is stored. "Forgot password" emails a one-time reset link that expires
// after 30 minutes (SMTP settings in .env; see mailer.js). An administrator on the server can
// also run `npm run reset-password -- <email>`.
//
// The first account can be created by anyone (workspace set-up). After that, only a signed-in
// adviser can add another adviser.
import crypto from 'node:crypto';
import express from 'express';
import { db, ready, audit, now } from './db.js';
import { sendMail } from './mailer.js';

export const COOKIE = 'fa_session';
const SESSION_DAYS = 7;
const RESET_MINUTES = 30;
export const MIN_PASSWORD = 8;
const KEYLEN = 64;

// ---------- Hashing ----------
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifySecret(secret, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(secret), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
// Run the same work for an unknown email, so response time does not reveal which emails exist.
const DUMMY_HASH = hashSecret(crypto.randomBytes(16).toString('hex'));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- Validation ----------
const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function checkName(name) {
  const n = String(name ?? '').trim();
  if (n.length < 2 || n.length > 80) throw httpError(400, 'Enter your name (2–80 characters).');
  return n;
}
function checkEmail(email) {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e) || e.length > 254) throw httpError(400, 'Enter a valid email address.');
  return e;
}
function checkPassword(pw, { name, email } = {}) {
  const p = String(pw ?? '');
  if (p.length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (p.length > 200) throw httpError(400, 'Password is too long.');
  const lower = p.toLowerCase();
  if ((email && lower === normEmail(email)) || (name && lower === String(name).trim().toLowerCase())) throw httpError(400, 'Password must not be your name or email.');
  return p;
}
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Storage ----------
// recovery_hash is unused (recovery codes were replaced by email reset links); kept so
// existing databases need no migration.
export const authReady = ready.then(() => db.exec(`
  CREATE TABLE IF NOT EXISTS advisers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    recovery_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    adviser_id INTEGER NOT NULL REFERENCES advisers(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    adviser_id INTEGER NOT NULL REFERENCES advisers(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
`));

export const adviserCount = async () => (await db.get('SELECT COUNT(*) AS n FROM advisers')).n;
const byEmail = (email) => db.get('SELECT * FROM advisers WHERE email = ?', normEmail(email));
const byId = (id) => db.get('SELECT * FROM advisers WHERE id = ?', id);
const publicAdviser = (a) => (a ? { id: a.id, name: a.name, email: a.email, createdAt: a.created_at } : null);

export async function createAdviser({ name, email, password }) {
  const n = checkName(name), e = checkEmail(email);
  const p = checkPassword(password, { name: n, email: e });
  if (await byEmail(e)) throw httpError(409, 'An adviser with this email already exists.');
  const r = await db.run('INSERT INTO advisers (name, email, password_hash, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    n, e, hashSecret(p), '', now(), now());
  return publicAdviser(await byId(r.lastInsertRowid));
}

async function setPassword(adviserId, password) {
  await db.run('UPDATE advisers SET password_hash = ?, updated_at = ? WHERE id = ?', hashSecret(password), now(), adviserId);
  await db.run('DELETE FROM password_resets WHERE adviser_id = ?', adviserId);
}

// Sets a new password and returns it; for the server-side reset script.
export async function adminResetPassword(email) {
  await authReady;
  const a = await byEmail(email);
  if (!a) throw httpError(404, `No adviser with email ${normEmail(email)}.`);
  const temp = crypto.randomBytes(9).toString('base64url');
  await setPassword(a.id, temp);
  await db.run('DELETE FROM sessions WHERE adviser_id = ?', a.id);
  await audit(null, 'ADVISER_PASSWORD_RESET_BY_ADMIN', { adviser: a.email });
  return temp;
}

// ---------- Sessions ----------
async function startSession(res, adviserId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  await db.run('INSERT INTO sessions (token_hash, adviser_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), adviserId, now(), expires.toISOString());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
}
const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
function tokenOf(req) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}
export async function sessionAdviser(req) {
  const token = tokenOf(req);
  if (!token) return null;
  await authReady;
  const s = await db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!s || s.expires_at < now()) return null;
  return publicAdviser(await byId(s.adviser_id));
}

// ---------- Attempt limits per email+IP in a 15-minute window ----------
// Sign-in: 5 failures. Reset emails: 3 requests (stops the form being used to flood an inbox).
const WINDOW_MS = 15 * 60_000;
function limiter(max, message) {
  const hits = new Map();
  const key = (req, email) => `${req.ip}|${normEmail(email)}`;
  return {
    check(req, email) {
      const h = hits.get(key(req, email));
      if (h && h.count >= max && Date.now() - h.first < WINDOW_MS) {
        throw httpError(429, `${message} Try again in ${Math.ceil((WINDOW_MS - (Date.now() - h.first)) / 60_000)} minute(s).`);
      }
    },
    hit(req, email) {
      const k = key(req, email), h = hits.get(k);
      if (!h || Date.now() - h.first >= WINDOW_MS) hits.set(k, { count: 1, first: Date.now() });
      else h.count++;
    },
    clear: (req, email) => hits.delete(key(req, email)),
  };
}
const loginLimit = limiter(5, 'Too many attempts.');
const resetLimit = limiter(3, 'Too many reset requests.');

// ---------- Middleware ----------
// Attaches req.adviser. API calls without a session get 401; pages redirect to the sign-in page.
export async function requireAdviser(req, res, next) {
  try { req.adviser = await sessionAdviser(req); } catch (e) { return next(e); }
  if (req.adviser) return next();
  if (req.path.toLowerCase().startsWith('/api/')) return res.status(401).json({ error: 'Please sign in.', signIn: true });
  res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
}

// ---------- Routes (/api/auth/...) ----------
const wrap = (fn) => async (req, res) => {
  try { await authReady; await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' }); if (!e.status) console.error(e); }
};

// Reset links point at APP_URL (set it when the site is not on localhost). The request's Host
// header is never used, so a forged Host cannot redirect a reset link to another site.
const appUrl = () => (process.env.APP_URL?.trim() || `http://localhost:${+process.env.PORT || 4400}`).replace(/\/+$/, '');

export const authRouter = express.Router();

authRouter.get('/me', wrap(async (req, res) => {
  res.json({ adviser: await sessionAdviser(req), canSignUp: (await adviserCount()) === 0 });
}));

// First account: open. Later accounts: only a signed-in adviser can add one (Settings).
authRouter.post('/signup', wrap(async (req, res) => {
  const current = await sessionAdviser(req);
  if ((await adviserCount()) > 0 && !current) throw httpError(403, 'This workspace already has an adviser. Ask them to add you from Settings, or sign in.');
  const adviser = await createAdviser(req.body ?? {});
  await audit(null, 'ADVISER_CREATED', { adviser: adviser.email, by: current?.email ?? 'self (first account)' });
  if (!current) await startSession(res, adviser.id, req);
  res.status(201).json({ adviser });
}));

authRouter.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body ?? {};
  loginLimit.check(req, email);
  const a = await byEmail(email);
  const ok = verifySecret(String(password ?? ''), a?.password_hash ?? DUMMY_HASH) && !!a;
  if (!ok) { loginLimit.hit(req, email); throw httpError(401, 'Email or password is incorrect.'); }
  loginLimit.clear(req, email);
  await startSession(res, a.id, req);
  await audit(null, 'ADVISER_SIGNED_IN', { adviser: a.email });
  res.json({ adviser: publicAdviser(a) });
}));

authRouter.post('/logout', wrap(async (req, res) => {
  const token = tokenOf(req);
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  clearCookie(res);
  res.json({ ok: true });
}));

// Forgot password: email a one-time reset link. The reply is the same whether or not the email
// has an account, so the form cannot be used to find out who is registered.
const FORGOT_REPLY = `If an account exists for that email, we've sent a link to reset the password. It expires in ${RESET_MINUTES} minutes.`;
authRouter.post('/forgot', wrap(async (req, res) => {
  const email = checkEmail(req.body?.email);
  resetLimit.check(req, email);
  resetLimit.hit(req, email);
  const a = await byEmail(email);
  if (a) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run('DELETE FROM password_resets WHERE expires_at < ?', now());
    await db.run('INSERT INTO password_resets (token_hash, adviser_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      sha256(token), a.id, now(), new Date(Date.now() + RESET_MINUTES * 60_000).toISOString());
    const link = `${appUrl()}/login.html?reset=${token}`;
    await audit(null, 'ADVISER_PASSWORD_RESET_REQUESTED', { adviser: a.email });
    try {
      await sendMail({
        to: a.email,
        subject: 'Reset your Fin Advisor password',
        text: `Hello ${a.name},\n\nSomeone asked to reset the password for your Fin Advisor account. To choose a new password, open this link within ${RESET_MINUTES} minutes:\n\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays the same.\n\nFin Advisor`,
        html: `<p>Hello ${escapeHtml(a.name)},</p><p>Someone asked to reset the password for your Fin Advisor account. To choose a new password, open this link within ${RESET_MINUTES} minutes:</p><p><a href="${link}">Reset my password</a></p><p>If you didn't ask for this, ignore this email; your password stays the same.</p><p>Fin Advisor</p>`,
      });
    } catch (e) {
      console.error(`Password-reset email to ${a.email} failed: ${e.message}`);
    }
  }
  res.json({ ok: true, message: FORGOT_REPLY });
}));

// Reset link: a valid, unused, unexpired token sets the new password and signs the adviser in.
// Every other session is signed out.
authRouter.post('/reset', wrap(async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  const row = token ? await db.get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(String(token))) : null;
  if (!row || row.used_at || row.expires_at < now()) throw httpError(400, 'This reset link is invalid or has expired. Ask for a new one.');
  const a = await byId(row.adviser_id);
  const p = checkPassword(newPassword, { name: a.name, email: a.email });
  await setPassword(a.id, p); // also removes this and any other outstanding reset links
  await db.run('DELETE FROM sessions WHERE adviser_id = ?', a.id);
  loginLimit.clear(req, a.email);
  await audit(null, 'ADVISER_PASSWORD_RESET', { adviser: a.email });
  await startSession(res, a.id, req);
  res.json({ adviser: publicAdviser(a) });
}));

// Settings: name any time; email or password only with the current password.
authRouter.put('/me', wrap(async (req, res) => {
  const me = await sessionAdviser(req);
  if (!me) throw httpError(401, 'Please sign in.');
  const a = await byId(me.id);
  const { name, email, currentPassword, newPassword } = req.body ?? {};
  const n = name !== undefined ? checkName(name) : a.name;
  const e = email !== undefined ? checkEmail(email) : a.email;
  const changingSecret = e !== a.email || !!newPassword;
  if (changingSecret && !verifySecret(String(currentPassword ?? ''), a.password_hash)) throw httpError(401, 'Current password is incorrect.');
  if (e !== a.email && (await byEmail(e))) throw httpError(409, 'Another adviser already uses this email.');
  const p = newPassword ? checkPassword(newPassword, { name: n, email: e }) : null;
  await db.run('UPDATE advisers SET name = ?, email = ?, updated_at = ? WHERE id = ?', n, e, now(), a.id);
  if (p) {
    await setPassword(a.id, p);
    // Sign out other devices; keep this session.
    await db.run('DELETE FROM sessions WHERE adviser_id = ? AND token_hash != ?', a.id, sha256(tokenOf(req)));
  }
  await audit(null, 'ADVISER_SETTINGS_CHANGED', { adviser: e, name: n !== a.name, email: e !== a.email, password: !!newPassword });
  res.json({ adviser: publicAdviser(await byId(a.id)) });
}));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
