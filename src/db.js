// SQLite persistence through libSQL: cases, draft versions, review decisions, research Q&A
// and an append-only audit log.
//
// Locally the database is a file (data/copilot.db, or DB_PATH). On Vercel the file system is
// wiped between instances, so set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (a free hosted
// libSQL database from turso.tech or the Vercel Marketplace) and the same SQL runs there.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';

// The Vercel Marketplace can add a custom prefix (e.g. STORAGE_TURSO_DATABASE_URL), so any name
// ending in TURSO_DATABASE_URL / TURSO_AUTH_TOKEN is accepted.
const envEnding = (...names) => {
  for (const n of names) if (process.env[n]?.trim()) return process.env[n].trim();
  const key = Object.keys(process.env).find((k) => names.some((n) => k.endsWith(`_${n}`)) && process.env[k]?.trim());
  return key ? process.env[key].trim() : '';
};
export const remoteUrl = envEnding('TURSO_DATABASE_URL', 'LIBSQL_URL');
export const dbRemote = Boolean(remoteUrl);
// False on Vercel without a hosted database: each instance then has its own temporary copy, so
// an account made on one instance is unknown to the next and sign-in fails.
export const dbPersistent = dbRemote || !process.env.VERCEL;

function localUrl() {
  if (process.env.DB_PATH) return pathToFileURL(path.resolve(process.env.DB_PATH)).href;
  // Without a hosted database, Vercel can only write to /tmp, which does not last.
  const dir = process.env.VERCEL ? '/tmp' : path.resolve(import.meta.dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  return pathToFileURL(path.join(dir, 'copilot.db')).href;
}
if (!dbPersistent) console.warn('TURSO_DATABASE_URL is not set: data is kept in /tmp and will be lost. Accounts and reset links will not work reliably.');

const client = createClient(dbRemote
  ? { url: remoteUrl, authToken: envEnding('TURSO_AUTH_TOKEN', 'LIBSQL_AUTH_TOKEN') || undefined }
  : { url: localUrl() });

// Small promise API in the shape of node:sqlite's prepare().get/all/run.
const exec = (sql, args) => client.execute({ sql, args });
export const db = {
  get: async (sql, ...args) => (await exec(sql, args)).rows[0],
  all: async (sql, ...args) => (await exec(sql, args)).rows,
  run: async (sql, ...args) => {
    const r = await exec(sql, args);
    return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid === undefined ? undefined : Number(r.lastInsertRowid) };
  },
  exec: (sql) => client.executeMultiple(sql),
  // Several statements as one transaction: all apply or none. Each is [sql, ...args].
  batch: (stmts) => client.batch(stmts.map(([sql, ...args]) => ({ sql, args })), 'write'),
};

async function migrate() {
  if (!dbRemote) await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      client_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      change_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id),
      draft_id INTEGER NOT NULL REFERENCES drafts(id),
      action TEXT NOT NULL,
      adviser TEXT NOT NULL,
      note TEXT,
      justifications_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS research (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER,
      question TEXT NOT NULL,
      answer_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER,
      event TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Columns added after the first release; existing databases get them on start-up.
  const hasColumn = async (table, col) => (await db.all(`PRAGMA table_info(${table})`)).some((c) => c.name === col);
  if (!(await hasColumn('drafts', 'share_token'))) await db.exec('ALTER TABLE drafts ADD COLUMN share_token TEXT');
  if (!(await hasColumn('reviews', 'adviser_id'))) await db.exec('ALTER TABLE reviews ADD COLUMN adviser_id INTEGER');
  // Each case belongs to the adviser who added it. Older cases are matched to their adviser
  // through the CLIENT_PROFILE_SUBMITTED audit entry; any left unmatched are shown to no one.
  if (!(await hasColumn('cases', 'adviser_id'))) {
    await db.exec('ALTER TABLE cases ADD COLUMN adviser_id INTEGER');
    await db.exec(`UPDATE cases SET adviser_id = (
      SELECT json_extract(a.detail_json, '$.adviserId') FROM audit a
      WHERE a.case_id = cases.id AND a.event = 'CLIENT_PROFILE_SUBMITTED' ORDER BY a.id LIMIT 1)`);
  }
  await db.exec('CREATE INDEX IF NOT EXISTS cases_adviser ON cases(adviser_id)');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS drafts_share_token ON drafts(share_token)');
  // Drafts approved before share links existed get one, so they can still be shared.
  for (const { id } of await db.all("SELECT id FROM drafts WHERE status = 'APPROVED' AND share_token IS NULL")) {
    await db.run('UPDATE drafts SET share_token = ? WHERE id = ?', crypto.randomBytes(24).toString('base64url'), id);
  }
}
// Resolves once the core tables exist; other modules chain their own tables onto it.
export const ready = migrate();

export const now = () => new Date().toISOString();
export async function audit(caseId, event, detail) {
  await db.run('INSERT INTO audit (case_id, event, detail_json, created_at) VALUES (?, ?, ?, ?)', caseId, event, JSON.stringify(detail ?? null), now());
}
