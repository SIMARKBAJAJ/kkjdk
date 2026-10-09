import './env.js';
import { createClient } from '@libsql/client';
import crypto from 'node:crypto';

// Hosted (Turso) when deployed, a plain local file when developing or testing.
export const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:door.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS doors (
     id TEXT PRIMARY KEY, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     door_id TEXT NOT NULL REFERENCES doors(id),
     name TEXT NOT NULL,
     telegram_chat_id TEXT,
     last_seen INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invites (
     code_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     expires INTEGER NOT NULL,
     used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     created INTEGER NOT NULL,
     expires INTEGER NOT NULL,
     revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS subs (
     endpoint TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     sub_json TEXT NOT NULL,
     created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS knocks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     door_id TEXT NOT NULL REFERENCES doors(id),
     from_user TEXT NOT NULL REFERENCES users(id),
     created INTEGER NOT NULL,
     touched INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'ringing')`, // ringing | answered | missed | cancelled | ended
  // Rate-limit counters live in the database because serverless instances share no memory.
  `CREATE TABLE IF NOT EXISTS rate_hits (
     key TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS rate_hits_key ON rate_hits(key, at)`,
];

// Runs once per server instance (one round trip), and is safe to repeat.
let ready = null;
export const ensureSchema = () =>
  (ready ||= db.batch(SCHEMA, 'write').catch((e) => { ready = null; throw e; }));

export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');

export const one = async (sql, ...args) => (await db.execute({ sql, args })).rows[0];
export const all = async (sql, ...args) => (await db.execute({ sql, args })).rows;
export const run = async (sql, ...args) => {
  const r = await db.execute({ sql, args });
  return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid };
};

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** Make a single-use invite for a user; returns the plain code (only its hash is stored). */
export async function makeInvite(userId) {
  const code = rand(24);
  await run('INSERT INTO invites(code_hash, user_id, expires) VALUES (?, ?, ?)', sha(code), userId, Date.now() + INVITE_TTL_MS);
  return code;
}
