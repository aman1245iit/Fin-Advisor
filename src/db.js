// SQLite persistence (Node's built-in node:sqlite): cases, draft versions, review decisions,
// research Q&A and an append-only audit log.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// On Vercel the deployed code is read-only; only /tmp is writable (and it is wiped between instances).
const dataDir = process.env.VERCEL ? '/tmp' : path.resolve(import.meta.dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH ?? path.join(dataDir, 'copilot.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
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
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('drafts', 'share_token')) db.exec('ALTER TABLE drafts ADD COLUMN share_token TEXT');
if (!hasColumn('reviews', 'adviser_id')) db.exec('ALTER TABLE reviews ADD COLUMN adviser_id INTEGER');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS drafts_share_token ON drafts(share_token)');
// Drafts approved before share links existed get one, so they can still be shared.
for (const { id } of db.prepare("SELECT id FROM drafts WHERE status = 'APPROVED' AND share_token IS NULL").all()) {
  db.prepare('UPDATE drafts SET share_token = ? WHERE id = ?').run(crypto.randomBytes(24).toString('base64url'), id);
}

export const now = () => new Date().toISOString();
export function audit(caseId, event, detail) {
  db.prepare('INSERT INTO audit (case_id, event, detail_json, created_at) VALUES (?, ?, ?, ?)').run(caseId, event, JSON.stringify(detail ?? null), now());
}
