# WebChat AI Backend

A minimal multi-tenant backend that lets you (or your clients) generate
embeddable chat widget snippets — **without ever exposing your Groq API key
or any client's trained knowledge base** in the browser.

This is the missing piece that turns the WebChat AI HTML demo into something
you can actually hand out to other people/clients as a real product.

## Why this exists

The original single-file WebChat AI HTML demo puts your Groq API key directly
into the `<script>` snippet it generates. That's fine on your own site — it's
**not** fine to give to a client, because anyone can view-source their page
and steal your key. This backend fixes that by moving the key, the knowledge
base, and all logic onto a server you control. Client sites only ever talk
to *your* server.

```
Client website  ──POST /api/chat──▶  YOUR server  ──▶  Groq API
  (embed.js,                          (holds the key,
   no secrets)  ◀──── reply ─────      the knowledge base,
                                       rate limits, logging)
```

## Setup

```bash
npm install
```

Edit `.env` and fill in:
- `GROQ_API_KEY` — your real Groq key (get one free at console.groq.com)
- `JWT_SECRET` — a long random string, e.g. `openssl rand -hex 32`. Signs the
  login tokens issued by `/api/auth/login` — every admin/agency endpoint now
  requires a real bearer token instead of a shared secret header.
- `OWNER_EMAIL` / `OWNER_PASSWORD` — read exactly once, on first boot against
  an empty database, to create the first owner login. Not read again after
  that — change your password from the dashboard afterward.

Then run:

```bash
npm start          # production
npm run dev        # auto-restarts on file changes
```

Server starts on `http://localhost:3000` (or whatever `PORT` you set).

> **Database note:** This uses Firestore via the `firebase-admin` package —
> set `FIREBASE_SERVICE_ACCOUNT` in `.env` to your Firebase service account
> JSON (see the deployment section below for where to get it). No schema to
> create — collections appear automatically on first write.

## How to create a bot (i.e. "train" a client's site)

Every bot now belongs to an agency client record — create the client first
(or use the dashboard's Add Client flow), then create the bot under it. All
of this is normally done through `agency.html`, but here's the raw API:

```bash
# 1. Log in to get a token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@youragency.com","password":"yourpassword"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 2. Create the client
CLIENT_ID=$(curl -s -X POST http://localhost:3000/api/agency/clients \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Acme Software","websiteUrl":"https://acme.com"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['client']['id'])")

# 3. Create the bot under that client
curl -X POST http://localhost:3000/api/admin/bots \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"clientId\": $CLIENT_ID,
    \"name\": \"Acme Support Bot\",
    \"siteUrl\": \"https://acme.com\",
    \"siteName\": \"Acme\",
    \"colorGrad\": \"linear-gradient(135deg,#3d45e0,#818af9)\",
    \"greeting\": \"Hi! Ask me anything about Acme.\",
    \"knowledgeBase\": \"...the scraped + refined site content...\"
  }"
```

Response:
```json
{ "token": "sp_AbCdEf123456..." }
```

That token is everything the client needs. Give them this one line to paste
before `</body>` on their site:

```html
<script src="https://your-server.com/embed/sp_AbCdEf123456....js"></script>
```

That's the whole "paste this and boom you have a chat assistant" experience
— except now it's safe to hand out, because the snippet only contains a
public token, never your key or their knowledge base in plaintext.

## Updating / retraining a bot

```bash
curl -X PATCH http://localhost:3000/api/admin/bots/sp_AbCdEf123456... \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{ "knowledgeBase": "...new refined content...", "greeting": "New greeting!" }'
```

## Viewing analytics for a bot

Analytics now requires a real login too (owner, or the worker assigned to
that bot's client) — no more "whoever holds the token" access:

```bash
curl http://localhost:3000/api/analytics/sp_AbCdEf123456... -H "Authorization: Bearer $TOKEN"
```

Returns total questions, today's count, most-asked questions, hourly
activity, last-7-days breakdown, and a recent question feed — the same data
the Analytics page in the WebChat AI demo showed, but now persisted server-side
and queryable any time instead of living only in browser memory.

## Endpoints reference

### "Talk to a Human" — how it works

Every embedded widget has a "Talk to a Human" option that appears after bot
replies (more prominently when the AI says it doesn't know something). This
is a real, working two-way conversation — not just a logging stub:

- The widget generates a stable random `visitorId` (stored in that visitor's
  browser via `localStorage`), so multiple messages from the same person
  stay grouped into one conversation instead of looking like separate
  unrelated people.
- Messages go to `POST /api/human-message`, stored in the `human_messages`
  table.
- The widget **polls** `GET /api/human-messages/:token/:visitorId` every 4
  seconds while connected, so it picks up whatever an agent replies.
- If the same visitor returns later (same browser, same site), the widget
  checks for existing history on load and reconnects automatically —
  they'll see their old messages and any reply that came in since.

**To see and reply to these**, from the dashboard's Inbox:
- `GET /api/admin/human-conversations/:token` — every visitor who's messaged
  this bot, grouped, most recent first, with an unread count each.
- `GET /api/admin/human-conversations/:token/:visitorId` — the full thread
  with one visitor (also marks their messages as read).
- `POST /api/admin/human-reply` — send a reply; the visitor's widget picks
  it up on its next poll.

There's no push notification (email/Slack/etc.) when a new message comes in
— you have to check the Inbox. That's a reasonable next addition if this
gets real usage.

| Method | Path                                          | Auth                     | Purpose |
|--------|-----------------------------------------------|--------------------------|---------|
| POST   | `/api/chat`                                   | none (public)            | What every embedded widget calls |
| POST   | `/api/human-message`                          | none (public)            | Visitor sends a message in human mode |
| GET    | `/api/human-messages/:token/:visitorId`       | none (visitorId = access)| Widget polls this for agent replies |
| GET    | `/embed/:token.js`                            | none (public)            | Serves the secret-free embed snippet |
| GET    | `/api/analytics/:token`                       | none (token = access)    | Per-bot analytics |
| GET    | `/api/admin/human-conversations/:token`       | Bearer token (owner/assigned worker) | List visitor conversations |
| GET    | `/api/admin/human-conversations/:token/:vId`  | Bearer token (owner/assigned worker) | Full thread with one visitor |
| POST   | `/api/admin/human-reply`                      | Bearer token (owner/assigned worker) | Agent sends a reply |
| POST   | `/api/admin/bots`                             | Bearer token (owner/assigned worker) | Create a new bot for a client, get its token |
| PATCH  | `/api/admin/bots/:token`                      | Bearer token (owner/assigned worker) | Update/retrain a bot |
| GET    | `/api/admin/bots`                             | Bearer token (owner: all, worker: assigned only) | List accessible bots |
| DELETE | `/api/admin/bots/:token`                      | Bearer token (owner/assigned worker) | Delete a bot + its data |
| POST   | `/api/auth/login`                             | none (public)             | Log in, get a JWT |
| GET    | `/api/auth/me`                                | Bearer token              | Current user + client info |
| GET/POST/PATCH/DELETE | `/api/agency/clients*`         | Bearer token (owner/worker, scoped) | Clients / Add Client / Client Reports |
| GET/POST/PATCH/DELETE | `/api/agency/workers*`         | Bearer token (owner only) | Hire/manage agency workers |
| POST/GET/PATCH | `/api/agency/quality-tests*`, `/api/agency/client-tasks*` | Bearer token (owner/worker, scoped) | AI Quality Testing + optimization log |
| GET    | `/api/client-portal/dashboard`                | Bearer token (client only) | The data behind client.html |
| GET    | `/health`                                     | none                      | Uptime check |

### AI Pilot — controlled on-page guide

Pilot is a per-bot opt-in feature (default: off). When enabled from the
dashboard's **AI Pilot** tab, the embedded widget answers questions as
usual, but for "where is / show me / find" style requests it can also make
the visitor's browser move a cursor toward, scroll to, highlight, or safely
click a real element already on their current page. It is NOT a general
browser agent — see `routes/pilot.js` for the full allowlist and navigation
boundary policy. Key points:

- The model never receives raw HTML and never outputs selectors or
  JavaScript. The widget scans the visible page client-side, sends a closed
  list of candidate elements (id + text/aria-label/title/role), and the
  model can only reference those exact ids.
- Every plan is re-validated server-side against the allowlisted verbs
  (`move_cursor`, `scroll`, `highlight`, `click`), the business owner's
  allowed-action toggles, and a same-origin navigation boundary — then
  re-checked again client-side immediately before each click.
- Clicking is refused outright on anything that looks like a submit,
  purchase, payment, delete, or password-related action, and on any link
  that would leave the current origin.
- The Pilot engine script (`GET /pilot/:token.js`) is only served — and only
  loaded by the widget — for bots that have Pilot turned on, so bots without
  it see zero extra network/JS cost.

| Method | Path                                       | Auth                    | Purpose |
|--------|---------------------------------------------|--------------------------|---------|
| POST   | `/api/pilot/plan`                           | none (public)            | Widget sends the question + page candidates, gets back an answer and/or a validated action plan |
| POST   | `/api/pilot/event`                          | none (public)            | Widget reports how a plan finished, for analytics |
| GET    | `/api/pilot/config/:token`                  | none (token = access)    | Widget checks whether Pilot is on before loading anything |
| GET    | `/pilot/:token.js`                          | none (public)            | The Pilot client engine (cursor/scroll/highlight/click + DOM scan) |
| GET    | `/api/admin/page-assistant/:token`          | Bearer token (owner/assigned worker) | Read a bot's AI Pilot config |
| PATCH  | `/api/admin/page-assistant/:token`          | Bearer token (owner/assigned worker) | Update a bot's AI Pilot config |
| GET    | `/api/admin/page-assistant-analytics/:token`| Bearer token (owner/assigned worker) | Requests / success rate / most-clicked suggestions |

## Deploying to Render (free tier)

This repo includes a `render.yaml` Blueprint for the web service. The
database (Firestore) lives in Firebase, not Render — see the Firebase setup
step first.

0. **Set up Firestore** (one-time, in Firebase Console): **Build → Firestore
   Database → Create database** → production mode. Then **Project Settings
   → Service Accounts → Generate new private key** → save that JSON, you'll
   paste it into `FIREBASE_SERVICE_ACCOUNT` in step 3. Use the SAME Firebase
   project your frontend's `firebase deploy --only hosting` deploys to.

1. **Push this `backend/` folder to its own GitHub repository.**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   # create a new repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
   Your `.gitignore` already excludes `.env` and `node_modules/` — never commit
   `.env`, it has your real secrets in it.

2. **On Render** (https://dashboard.render.com): **New → Blueprint** → connect
   the GitHub repo you just pushed. Render reads `render.yaml` and shows you
   the web service it's about to create.

3. **It'll prompt you for the secrets** marked `sync: false` in `render.yaml`:
   `GROQ_API_KEY`, `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT` (the service
   account JSON from step 0, pasted as one line — or base64-encode it first,
   both work), `JWT_SECRET`, `OWNER_EMAIL`, `OWNER_PASSWORD`. `OWNER_EMAIL`/
   `OWNER_PASSWORD` only matter on the very first deploy, to create your
   first login.

4. Click **Apply**. Render builds and deploys. First deploy takes a few minutes.

5. Once live, your backend URL will be something like
   `https://webchat-ai-backend.onrender.com`. Check it:
   ```bash
   curl https://webchat-ai-backend.onrender.com/health
   ```

**One free-tier thing worth knowing:** the web service spins down after 15
minutes of no traffic, and takes 30-60 seconds to wake back up on the next
request — the first message to an idle bot will feel slow once, then it's
normal speed again. (Firestore itself has no equivalent expiry or spin-down —
that was specifically a Render free-Postgres limitation this project no
longer has.)

## Staying awake + backups

Two automations are included, both as GitHub Actions workflows in
`.github/workflows/`:

### Keep-alive (`keepalive.yml`)
Pings `/health` every 10 minutes so Render's free tier never spins your
service down from inactivity. **Setup:** in your GitHub repo → Settings →
Secrets and variables → Actions → add a secret named `BACKEND_URL` with your
real Render URL (e.g. `https://webchat-ai-backend.onrender.com`).

Honest limitation: GitHub disables scheduled workflows after 60 days with no
commits to the repo, and cron timing isn't guaranteed to the minute. For a
more reliable version of the same thing, a free https://uptimerobot.com
account pinging the same `/health` URL every 5 minutes works well alongside
this (or instead of it) and doesn't depend on repo activity.

### Automatic daily backups (`backup.yml`)
Every day at 03:00 UTC, dumps every Firestore collection into
`backups/latest.json` and commits it to the repo — a safety net against
accidental deletion, not against any expiry (Firestore's free tier doesn't
expire). **Setup:** add a secret named `FIREBASE_SERVICE_ACCOUNT` with the
same service account JSON you used in Render.

### Restoring a backup

If you ever need to rebuild from a backup (accidental deletion, moving to a
new Firebase project, etc.):
```bash
FIREBASE_SERVICE_ACCOUNT="...service account JSON..." npm run restore
```
This rewrites every document from `backups/latest.json` back into Firestore
with its **exact original ID** — bot tokens and user emails (and therefore
every client's embed `<script>` tag and every login) keep working unchanged.

## Production checklist before letting real clients use this

This is a solid, working foundation — but a few things are intentionally
left simple so you can extend them as you grow:

- **Admin auth** is a single shared secret right now. Fine for you alone;
  swap for real per-client login (sessions, JWT, or an auth provider) before
  letting clients log in and self-serve their own bot creation.
- **Rate limiting** is in-memory per-process. If you ever run more than one
  server instance behind a load balancer, move the limiter to Redis so all
  instances share the same counters.
- **No usage caps / billing** yet — `usage_daily` table tracks request counts
  per bot per day, so you have the data to build "free tier = 100 msgs/day"
  style limits whenever you want them.
- **HTTPS** — deploy behind a host that gives you TLS for free (Render,
  Railway, Fly.io, a reverse proxy with Let's Encrypt, etc.) before going
  live; browsers will warn on/block mixed content otherwise.
- **CORS on `/api/chat`** is wide open by design — that endpoint must be
  callable from any client domain. Everything else (`/api/admin/*`) is
  protected by the secret header instead of CORS, since CORS only restricts
  browsers, not curl/server-to-server calls.

## File structure

```
webchat-ai-backend/
├── server.js          # entry point, wires up routes + middleware
├── db/
│   └── index.js        # Firestore connection + helpers (nowStamp, queryInChunks)
├── routes/
│   ├── chat.js          # public POST /api/chat — the core proxy to Groq
│   ├── embed.js          # serves the secret-free widget script
│   ├── analytics.js       # per-token analytics
│   ├── admin.js            # create/update/list/delete bots
│   └── scrape.js            # server-side page fetcher for the Train AI tab
├── scripts/
│   ├── backup.js         # dump every Firestore collection to backups/latest.json
│   └── restore.js         # rebuild Firestore from that backup, same doc IDs/tokens
├── .github/workflows/
│   ├── keepalive.yml    # pings /health every 10 min so Render doesn't sleep it
│   └── backup.yml        # runs backup.js daily, commits the result
├── render.yaml         # Render Blueprint (web service only — DB is Firestore/Firebase)
├── .env
└── package.json
```
