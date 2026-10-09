# The Door

A private door between two people. One taps the door (knock), the other gets a notification, taps the door to answer, and the door opens into a full-screen video call. Whichever device answers is the one that sends video.

Design notes: this follows the Anywhere Door project plan. The name and artwork are original; the idea is inspired by a well-known anime gadget, so draw your own door if you ever publish it for others.

## How it works

```
her device ──1 knock──▶ API (one Vercel function) ──2 check──▶ Turso database
                         │
                         └─3 push─▶ Apple/Google push (+ Telegram backup) ─4 buzz─▶ your devices
both devices ──5 video──▶ LiveKit Cloud (relay + TURN)
the page itself (HTML, CSS, JS, icons) ──▶ Vercel's CDN
```

- **Sign-in:** a single-use invite link per device (24 hours). Opening it sets an HttpOnly session cookie (30 days). Each phone or laptop needs its own link.
- **No peek:** the knocker can wait inside the room while their own knock rings; the other person only gets a video token after tapping to answer. Hanging up closes the door for both, and a call that goes quiet without a hang-up stops granting tokens after 15 minutes.
- **Two people only:** only the two users of a door can ever get a token for its room.
- **Camera consent:** the camera starts only after a tap on that device. A LIVE badge is always visible.
- **Knock timeout:** 60 seconds. After that the knocker sees a "busy" message and the other person gets a "missed knock" alert.

## Deploy on Vercel (about 30 minutes)

You need free accounts on GitHub, Vercel, Turso and LiveKit Cloud.

1. **Database.** In the Turso dashboard create a database, then copy its URL (`libsql://...`) and create a token. Pick the location closest to you. Vercel's function region is set in `vercel.json` (`bom1`, Mumbai). If Turso has no location near Mumbai, choose the nearest one and change `regions` in `vercel.json` to the Vercel region nearest to it, so the function and database sit close together.
2. **LiveKit.** Create a project at cloud.livekit.io and copy the URL, API key and secret.
3. **Push keys.** `npm install`, then `npm run vapid`.
4. **GitHub.** Create a **private** repository and push this folder. `.gitignore` already keeps `.env` and database files out.
5. **Vercel.** Import the repository (framework preset: Other). Under Environment Variables add: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT`, and optionally `TELEGRAM_BOT_TOKEN`. Deploy.
6. **Create the door.** On your computer, copy `.env.example` to `.env`, fill in the same Turso values, and set `BASE_URL` to your Vercel address (for example `https://your-project.vercel.app`). Then run `npm run door -- new "Simar" "Her name"`. It prints one invite link for each of you.
7. Open each link on that person's device. Add more devices later with `npm run door -- invite "Simar"`. Sign someone out everywhere with `npm run door -- revoke "Simar"`.

Camera, push and installing to the Home Screen need https, which Vercel provides.

**iPhone:** Web Push only works from the installed icon (Share, then Add to Home Screen), iOS 16.4 or later.

**Vercel's free Hobby plan** is for personal, non-commercial use, which fits this. If you ever open the door to the public, check Vercel's current terms first.

## Run it locally

`npm install`, `cp .env.example .env`, leave the Turso values empty (it then uses a local `door.db` file), fill in the LiveKit and VAPID values, `npm run door -- new "A" "B"`, `npm start`. Open the links at `http://localhost:3000`.

## Why it is built this way (Vercel runs short-lived functions)

A Vercel function can stop after any response, and two requests may hit different copies, so:

- **Data is in Turso**, not a file or memory. Locally the same code uses a `file:` database.
- **No timers.** A knock that rings out is marked "missed" the next time anyone checks the door status, knocks or hangs up, and the missed-knock alert is sent then. The knocker's own page checks within a minute, so this is normally prompt, but it is not clock-exact.
- **Rate limits are counted in the database**, so they hold across copies.
- **Push and Telegram alerts are sent before the response returns**, so Vercel cannot cut them off. A knock therefore takes a moment longer to confirm.
- **The page polls every 5 seconds only while it is open and visible**, and not during a call. Closed or hidden pages rely on push. As arithmetic: two devices open about 4 hours a day is roughly 170,000 status calls a month, so check your plan's current limits.
- **LiveKit's browser build is committed in `public/vendor/`**, because Vercel's CDN serves only `public/`. After upgrading `livekit-client`, run `npm run vendor` and commit the result.
- **Security headers for the page live in `vercel.json`**, because the CDN serves the page and not Express. The LiveKit address there is a wildcard for `*.livekit.cloud`, because `vercel.json` cannot read environment variables.

## Tests

`npm test` (17 checks) starts the server on a temporary local database and checks: invite single-use, cookie flags, CSP and no-cache headers, cross-origin and `null`-origin refusal, no tokens before a knock, the no-peek rule, quiet calls going stale, unanswered knocks becoming missed without a timer, database-backed rate limits, same-moment knocks, hang-up, push validation, serving the LiveKit file, and the app being exported (not started) when `VERCEL` is set.

The front-end logic (door states, knock, answer, timeout, controls) was also driven in jsdom against the real server with LiveKit stubbed: 14 of 14 checks passed. That harness lives outside the project.

**Not tested here** (needs real accounts and devices): the deployment on Vercel itself (the setup follows Vercel's current Express documentation but was not run on Vercel), a real Turso database (tests use the same library on a local file), live video, real push delivery, Telegram and the missed-knock alert, iOS install, and the door animation on real screens.

## Files

| File | Job |
|---|---|
| `server.js` | The API (exported for Vercel), rate limits, push and Telegram sending |
| `db.js` | Database connection, tables, helpers |
| `vercel.json` | Region, security headers for the page, root rewrite |
| `scripts/door.js` | Create the door, issue invites, revoke devices |
| `scripts/vendor.js` | Copies the LiveKit browser build into `public/vendor/` |
| `public/index.html`, `app.css` | The door scene and call screen |
| `public/app.js` | Door states, knocking, call, controls |
| `public/sw.js` | Shows the knock when the page is closed |

## Dependencies

| Package | Why |
|---|---|
| `express` | Routing; Vercel runs it as one function |
| `@libsql/client` | Talks to Turso (and to a local file in development); the one package added for Vercel |
| `livekit-server-sdk` | Signs short-lived video tokens |
| `livekit-client` | Browser video, copied into `public/vendor/` so the page loads no third-party scripts |
| `web-push` | Sends Web Push knocks |

Built into Node and used instead of packages: `process.loadEnvFile` (.env), `node:test` (tests), `fetch` (Telegram).
