import './env.js';
import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import webpush from 'web-push';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, ensureSchema, one, all, run, sha, rand } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT = 'mailto:admin@example.com',
  TELEGRAM_BOT_TOKEN, PORT = '3000', NODE_ENV, VERCEL,
} = process.env;
const BASE_URL = process.env.BASE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');
const prod = NODE_ENV === 'production';

const KNOCK_MS = 60_000;          // how long a knock rings before it counts as missed
const ONLINE_MS = 15_000;         // a device counts as online if it polled this recently
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const RECONNECT_MS = 15 * 60 * 1000;
let pushOn = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushOn) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); } catch (e) {
    console.error('Push disabled: bad VAPID settings:', e.message); // keep the door working without push
    pushOn = false;
  }
}

// ---------- helpers ----------
// Serverless rule: nothing may be left running after a response (no timers, no fire-and-forget),
// and nothing may live in memory between requests. State is in the database; side effects are awaited.
const now = () => Date.now();

function lkOrigins() {
  if (!LIVEKIT_URL) return '';
  const { host } = new URL(LIVEKIT_URL);
  return (prod ? ['wss', 'https'] : ['wss', 'https', 'ws', 'http']).map((p) => `${p}://${host}`).join(' ');
}

function rate(name, max, windowMs, keyOf) {
  return async (req, res, next) => {
    const key = `${name}:${keyOf(req)}`;
    const t = now();
    const r = await db.batch([
      { sql: 'DELETE FROM rate_hits WHERE at < ?', args: [t - 10 * 60_000] },
      { sql: 'INSERT INTO rate_hits(key, at) VALUES (?, ?)', args: [key, t] },
      { sql: 'SELECT COUNT(*) AS n FROM rate_hits WHERE key = ? AND at > ?', args: [key, t - windowMs] },
    ], 'write');
    if (r[2].rows[0].n > max) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
    next();
  };
}

const otherOf = (user) => one('SELECT id, name, last_seen FROM users WHERE door_id = ? AND id <> ?', user.door_id, user.id);
// A knock from the other person that is still ringing (a door has exactly two people).
const incomingFor = (user) =>
  one(`SELECT id FROM knocks WHERE door_id = ? AND from_user <> ? AND status = 'ringing' AND created > ? ORDER BY id DESC LIMIT 1`,
    user.door_id, user.id, now() - KNOCK_MS);

async function notify(userId, { title, body, tag }) {
  const payload = JSON.stringify({ title, body, tag });
  const jobs = [];
  if (pushOn) {
    for (const s of await all('SELECT endpoint, sub_json FROM subs WHERE user_id = ?', userId)) {
      jobs.push((async () => {
        try {
          await webpush.sendNotification(JSON.parse(s.sub_json), payload, { TTL: 60, urgency: 'high', timeout: 5000 });
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) await run('DELETE FROM subs WHERE endpoint = ?', s.endpoint);
          else console.error('push failed:', e.statusCode || e.message);
        }
      })());
    }
  }
  const chat = (await one('SELECT telegram_chat_id AS c FROM users WHERE id = ?', userId))?.c;
  if (TELEGRAM_BOT_TOKEN && chat) {
    const msg = { chat_id: chat, text: `${title}\n${body}` };
    if (BASE_URL.startsWith('https://')) msg.reply_markup = { inline_keyboard: [[{ text: 'Open the door', url: BASE_URL }]] };
    jobs.push((async () => {
      try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) console.error('telegram failed:', r.status); // never log the URL: it contains the token
      } catch (e) { console.error('telegram failed:', e.name); }
    })());
  }
  await Promise.allSettled(jobs);
}

// A knock nobody answered within a minute becomes "missed", and the other person is told.
// Done lazily (on status checks, knocks and hang-ups) because there is no timer to do it for us.
async function sweepMissed() {
  const rows = await all(
    "UPDATE knocks SET status = 'missed' WHERE status = 'ringing' AND created < ? RETURNING from_user, door_id",
    now() - KNOCK_MS);
  await Promise.all(rows.map(async (k) => {
    const [who, target] = await Promise.all([
      one('SELECT name FROM users WHERE id = ?', k.from_user),
      one('SELECT id FROM users WHERE door_id = ? AND id <> ?', k.door_id, k.from_user),
    ]);
    if (who && target) await notify(target.id, { title: 'Missed knock', body: `${who.name} knocked a minute ago`, tag: 'missed' });
  }));
}

// ---------- app ----------
const app = express();
if (prod) app.set('trust proxy', 1);
app.disable('x-powered-by');

// On Vercel the page is served by their CDN, so the same security headers are set in vercel.json.
if (!VERCEL) {
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
        "media-src 'self' blob:", `connect-src 'self' ${lkOrigins()}`.trim(), "worker-src 'self' blob:",
        "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
      ...(prod && { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
    });
    next();
  });
}

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// CSRF: cookies are SameSite=Lax and the API only reads JSON; also refuse cross-origin POSTs outright.
// An unparseable Origin (such as the literal "null" from sandboxed frames) is refused too.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers.origin) {
    let host = null;
    try { host = new URL(req.headers.origin).host; } catch { /* host stays null */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request refused.' });
  }
  next();
});
app.use(express.json({ limit: '10kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', async (req, res, next) => { await ensureSchema(); next(); });

async function auth(req, res, next) {
  const tok = /(?:^|;\s*)door_session=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  const user = tok && await one(
    `SELECT u.id, u.name, u.door_id FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires > ?`, sha(tok), now());
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  req.user = user;
  next();
}

// Anyone who opens the site picks one of the two names; that device then stays signed in.
app.post('/api/enter', rate('enter', 10, 60_000, (req) => req.ip), async (req, res) => {
  let [door] = await all('SELECT id FROM doors ORDER BY created LIMIT 1');
  if (!door) { door = { id: rand(16) }; await run('INSERT INTO doors(id, created) VALUES (?, ?)', door.id, now()); }
  const users = await all('SELECT id, name FROM users WHERE door_id = ? ORDER BY created', door.id);
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.json({ names: users.map((u) => u.name), full: users.length >= 2 });
  let user = users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (!user) {
    if (users.length >= 2) return res.status(400).json({ error: 'This door already has two people. Pick one of the names.' });
    user = { id: crypto.randomUUID() };
    await run('INSERT INTO users(id, door_id, name, created) VALUES (?, ?, ?, ?)', user.id, door.id, name, now());
  }
  const token = rand(32);
  await run('INSERT INTO sessions(token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)', sha(token), user.id, now(), now() + SESSION_MS);
  res.cookie('door_session', token, { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: SESSION_MS, path: '/' });
  res.json({ ok: true });
});

app.post('/api/join', rate('join', 10, 60_000, (req) => req.ip), async (req, res) => {
  const h = sha(String(req.body?.code || ''));
  const [inv] = await all('UPDATE invites SET used = 1 WHERE code_hash = ? AND used = 0 AND expires > ? RETURNING user_id', h, now());
  if (!inv) return res.status(400).json({ error: 'This invite is not valid, or it was already used.' });
  const token = rand(32);
  await run('INSERT INTO sessions(token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)', sha(token), inv.user_id, now(), now() + SESSION_MS);
  res.cookie('door_session', token, { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: SESSION_MS, path: '/' });
  res.json({ ok: true });
});

app.get('/api/status', auth, async (req, res) => {
  const { user } = req;
  const t = now();
  const [, other, incoming] = await Promise.all([
    run('UPDATE users SET last_seen = ? WHERE id = ?', t, user.id),
    otherOf(user),
    incomingFor(user),
    sweepMissed(),
  ]);
  res.json({
    me: { name: user.name },
    other: other ? { name: other.name, online: t - other.last_seen < ONLINE_MS } : null,
    incoming: incoming ? { id: incoming.id } : null,
  });
});

app.post('/api/knock', auth, rate('knock', 5, 60_000, (req) => req.user.id), async (req, res) => {
  const { user } = req;
  const other = await otherOf(user);
  if (!other) return res.status(409).json({ error: 'Nobody else has this door yet.' });

  // Both knocked at once: the second knock simply answers the first.
  const crossing = await incomingFor(user);
  if (crossing) {
    await run("UPDATE knocks SET status = 'answered', touched = ? WHERE id = ?", now(), crossing.id);
    return res.json({ answered: true });
  }
  await sweepMissed();
  await run("UPDATE knocks SET status = 'cancelled' WHERE from_user = ? AND status = 'ringing'", user.id);
  const { lastInsertRowid } = await run('INSERT INTO knocks(door_id, from_user, created, touched) VALUES (?, ?, ?, ?)', user.door_id, user.id, now(), now());
  await notify(other.id, { title: `${user.name} is at the door`, body: 'Tap to open the door', tag: 'knock' });
  res.json({ id: Number(lastInsertRowid) });
});

app.post('/api/answer', auth, async (req, res) => {
  const { user } = req;
  const r = await run(
    "UPDATE knocks SET status = 'answered', touched = ? WHERE door_id = ? AND from_user <> ? AND status = 'ringing' AND created > ?",
    now(), user.door_id, user.id, now() - KNOCK_MS);
  res.json({ ok: r.changes > 0 });
});

app.post('/api/hangup', auth, async (req, res) => {
  await sweepMissed(); // a knock that rang out is reported as missed before it is closed
  await run("UPDATE knocks SET status = 'ended' WHERE door_id = ? AND status IN ('ringing', 'answered')", req.user.door_id);
  res.json({ ok: true });
});

// No peek: the knocker may join while their own knock rings; the other person only after answering.
// An answered call keeps granting tokens only while someone is actively (re)joining: if both sides
// vanish without hanging up, it goes quiet after RECONNECT_MS instead of staying open for hours.
app.post('/api/token', auth, rate('token', 20, 60_000, (req) => req.user.id), async (req, res) => {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) return res.status(503).json({ error: 'Video is not set up on the server yet.' });
  const { user } = req;
  const allowed = await one(
    `SELECT id FROM knocks WHERE door_id = ? AND (
       (status = 'answered' AND touched > ?) OR (status = 'ringing' AND from_user = ? AND created > ?)
     ) ORDER BY id DESC LIMIT 1`,
    user.door_id, now() - RECONNECT_MS, user.id, now() - KNOCK_MS - 5000);
  if (!allowed) return res.status(403).json({ error: 'The door is closed. Knock or answer first.' });
  await run('UPDATE knocks SET touched = ? WHERE id = ?', now(), allowed.id);
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: user.id, name: user.name, ttl: '10m' });
  at.addGrant({ roomJoin: true, room: user.door_id, canPublish: true, canSubscribe: true, canPublishData: false });
  res.json({ token: await at.toJwt(), url: LIVEKIT_URL });
});

app.get('/api/push/key', auth, (req, res) => res.json({ key: pushOn ? VAPID_PUBLIC : null }));

app.post('/api/push/subscribe', auth, async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || !String(sub.endpoint).startsWith('https://')) {
    return res.status(400).json({ error: 'Not a valid push subscription.' });
  }
  await run(`INSERT INTO subs(endpoint, user_id, sub_json, created) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, sub_json = excluded.sub_json`,
    sub.endpoint, req.user.id, JSON.stringify(sub), now());
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, async (req, res) => {
  await run('DELETE FROM subs WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), req.user.id);
  res.json({ ok: true });
});

// Local development serves the page itself; on Vercel the CDN serves public/ and this line is ignored.
app.use(express.static(path.join(here, 'public'), { maxAge: 0 }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
});

if (!VERCEL) app.listen(Number(PORT), () => console.log(`The Door is open at ${BASE_URL} (port ${PORT})`));

export default app;
