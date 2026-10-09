// Admin commands. Run from the project folder (they use whatever database your .env points at):
//   node scripts/door.js new "Simar" "Her" [telegramChatId1] [telegramChatId2]
//   node scripts/door.js invite "Simar"      (a fresh single-use link, e.g. for a second device)
//   node scripts/door.js revoke "Simar"      (signs out every device of that person)
import '../env.js';
import crypto from 'node:crypto';
import { db, ensureSchema, all, run, makeInvite } from '../db.js';

const base = (process.env.BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000')).replace(/\/$/, '');
const [cmd, ...args] = process.argv.slice(2);
const link = (code) => `${base}/?invite=${code}`;
const find = async (name) => {
  const rows = await all('SELECT id, name FROM users WHERE lower(name) = lower(?)', name);
  if (rows.length !== 1) { console.error(rows.length ? `Several people are named "${name}".` : `Nobody named "${name}".`); process.exit(1); }
  return rows[0];
};

await ensureSchema();

if (cmd === 'new' && args.length >= 2) {
  const [a, b, chatA, chatB] = args;
  const doorId = crypto.randomBytes(16).toString('base64url'); // 128-bit door id
  await run('INSERT INTO doors(id, created) VALUES (?, ?)', doorId, Date.now());
  for (const [name, chat] of [[a, chatA], [b, chatB]]) {
    const id = crypto.randomUUID();
    await run('INSERT INTO users(id, door_id, name, telegram_chat_id, created) VALUES (?, ?, ?, ?, ?)', id, doorId, name, chat || null, Date.now());
    console.log(`${name}: ${link(await makeInvite(id))}`);
  }
  console.log('\nEach link works once and expires in 24 hours. Open it on the device that should belong to that person.');
} else if (cmd === 'invite' && args[0]) {
  const u = await find(args[0]);
  console.log(`${u.name}: ${link(await makeInvite(u.id))}`);
} else if (cmd === 'revoke' && args[0]) {
  const u = await find(args[0]);
  const r = await run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', u.id);
  await run('DELETE FROM subs WHERE user_id = ?', u.id);
  console.log(`Signed out ${u.name} everywhere (${r.changes} session${r.changes === 1 ? '' : 's'}).`);
} else {
  console.log('Usage:\n  node scripts/door.js new "Name A" "Name B" [chatIdA] [chatIdB]\n  node scripts/door.js invite "Name"\n  node scripts/door.js revoke "Name"');
  db.close();
  process.exit(cmd ? 1 : 0);
}
db.close();
