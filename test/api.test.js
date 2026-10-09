import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3100 + Math.floor(Math.random() * 800);
const BASE = `http://localhost:${PORT}`;
const dir = mkdtempSync(path.join(tmpdir(), 'door-test-'));
const dbFile = path.join(dir, 'test.db');
const env = {
  ...process.env, PORT: String(PORT), BASE_URL: BASE, TURSO_DATABASE_URL: `file:${dbFile}`, VERCEL: '',
  LIVEKIT_URL: 'wss://example.livekit.cloud', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'x'.repeat(40),
};
let server;
const invites = {};

// A fetch wrapper with its own cookie jar, so each "device" is separate.
const device = () => {
  let cookie = '';
  return async (p, body, headers = {}) => {
    const res = await fetch(BASE + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { cookie }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})), setCookie: set };
  };
};
const A = device(), B = device(), anon = device();

before(async () => {
  const out = execFileSync('node', ['scripts/door.js', 'new', 'Simar', 'Mira'], { env, encoding: 'utf8' });
  for (const line of out.split('\n')) {
    const m = /^(\w+): .*\?invite=([\w-]+)$/.exec(line);
    if (m) invites[m[1]] = m[2];
  }
  assert.ok(invites.Simar && invites.Mira, 'seed printed two invite links');
  server = spawn('node', ['server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => { server?.kill(); rmSync(dir, { recursive: true, force: true }); });

test('serves the page with strict security headers', async () => {
  const r = await anon('/');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /example\.livekit\.cloud/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('API refuses anonymous callers', async () => {
  for (const p of ['/api/status', '/api/push/key']) assert.equal((await anon(p)).status, 401);
  assert.equal((await anon('/api/token', {})).status, 401);
  assert.equal((await anon('/api/knock', {})).status, 401);
});

test('invites work once and set an HttpOnly cookie', async () => {
  assert.equal((await anon('/api/join', { code: 'nope' })).status, 400);
  const a = await A('/api/join', { code: invites.Simar });
  assert.equal(a.status, 200);
  assert.match(a.setCookie, /HttpOnly/i);
  assert.match(a.setCookie, /SameSite=Lax/i);
  assert.equal((await B('/api/join', { code: invites.Mira })).status, 200);
  assert.equal((await anon('/api/join', { code: invites.Simar })).status, 400, 'a used invite is dead');
});

test('presence: each side sees the other once they have polled', async () => {
  assert.equal((await A('/api/status')).json.other.online, false);
  await B('/api/status');
  const s = await A('/api/status');
  assert.deepEqual(s.json.other, { name: 'Mira', online: true });
  assert.equal(s.json.me.name, 'Simar');
});

test('cross-origin POSTs are refused', async () => {
  const r = await A('/api/knock', {}, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('nobody gets a video token before a knock', async () => {
  assert.equal((await A('/api/token', {})).status, 403);
  assert.equal((await B('/api/token', {})).status, 403);
});

test('knock, answer, and the no-peek rule', async () => {
  const k = await A('/api/knock', {});
  assert.equal(k.status, 200);
  assert.ok(k.json.id);

  assert.ok((await B('/api/status')).json.incoming, 'B sees the knock');
  assert.equal((await B('/api/token', {})).status, 403, 'B cannot join before answering');

  const t = await A('/api/token', {});
  assert.equal(t.status, 200, 'the knocker can wait inside');
  const claims = JSON.parse(Buffer.from(t.json.token.split('.')[1], 'base64url').toString());
  assert.equal(claims.video.roomJoin, true);
  assert.ok(claims.exp - claims.nbf <= 600, 'token lives 10 minutes at most');
  assert.equal(t.json.url, 'wss://example.livekit.cloud');

  assert.equal((await B('/api/answer', {})).json.ok, true);
  assert.equal((await B('/api/token', {})).status, 200, 'B can join after answering');
});

test('hanging up closes the door again', async () => {
  assert.equal((await A('/api/hangup', {})).status, 200);
  assert.equal((await A('/api/token', {})).status, 403);
  assert.equal((await B('/api/token', {})).status, 403);
});

test('an answered call that goes quiet stops granting tokens', async () => {
  assert.ok((await A('/api/knock', {})).json.id);
  assert.equal((await B('/api/answer', {})).json.ok, true);
  assert.equal((await A('/api/token', {})).status, 200);
  const db = new DatabaseSync(dbFile);
  db.prepare("UPDATE knocks SET touched = ? WHERE status = 'answered'").run(Date.now() - 20 * 60 * 1000);
  db.close();
  assert.equal((await A('/api/token', {})).status, 403);
  assert.equal((await B('/api/token', {})).status, 403);
  await A('/api/hangup', {});
});

test('an unparseable Origin is refused cleanly and API responses are never cached', async () => {
  assert.equal((await A('/api/knock', {}, { Origin: 'null' })).status, 403);
  assert.equal((await A('/api/status')).headers.get('cache-control'), 'no-store');
});

test('a knock nobody answers is swept to missed, with no timer involved', async () => {
  assert.ok((await A('/api/knock', {})).json.id);
  assert.ok((await B('/api/status')).json.incoming, 'ringing at first');
  const db = new DatabaseSync(dbFile);
  db.prepare("UPDATE knocks SET created = ? WHERE status = 'ringing'").run(Date.now() - 2 * 60 * 1000);
  db.close();
  assert.equal((await B('/api/status')).json.incoming, null, 'no longer offered to B');
  assert.equal((await A('/api/token', {})).status, 403, 'A cannot keep waiting inside either');
  const check = new DatabaseSync(dbFile);
  const row = check.prepare('SELECT status FROM knocks ORDER BY id DESC LIMIT 1').get();
  check.close();
  assert.equal(row.status, 'missed');
});

test('rate-limit counters are stored in the database, not in memory', async () => {
  const check = new DatabaseSync(dbFile);
  const n = check.prepare("SELECT COUNT(*) AS n FROM rate_hits WHERE key LIKE 'knock:%'").get().n;
  check.close();
  assert.ok(n >= 1, `expected knock hits in the table, found ${n}`);
});

test('the LiveKit browser build is served from the page itself', async () => {
  const res = await fetch(`${BASE}/vendor/livekit-client.umd.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.ok((await res.arrayBuffer()).byteLength > 100_000);
});

test('on Vercel the app is exported, not started', async () => {
  const out = execFileSync('node', ['-e', "import('./server.js').then((m) => console.log(typeof m.default))"], {
    env: { ...env, VERCEL: '1' }, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(out.trim(), 'function');
});

test('knocks at the same moment become an answer', async () => {
  assert.ok((await A('/api/knock', {})).json.id);
  const r = await B('/api/knock', {});
  assert.equal(r.json.answered, true);
  await A('/api/hangup', {});
});

test('push subscriptions must be https and complete', async () => {
  const keys = { p256dh: 'k', auth: 'a' };
  assert.equal((await A('/api/push/subscribe', { subscription: { endpoint: 'http://x.test/p', keys } })).status, 400);
  assert.equal((await A('/api/push/subscribe', { subscription: { endpoint: 'https://x.test/p' } })).status, 400);
  assert.equal((await A('/api/push/subscribe', { subscription: { endpoint: 'https://x.test/p', keys } })).status, 200);
});

test('knock spam is rate limited', async () => {
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await A('/api/knock', {})).status);
  assert.ok(codes.includes(429), `expected a 429 in ${codes}`);
});
