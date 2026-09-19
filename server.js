// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const chatRoute = require('./routes/chat');
const adminRoute = require('./routes/admin');
const analyticsRoute = require('./routes/analytics');
const embedRoute = require('./routes/embed');
const scrapeRoute = require('./routes/scrape');
const inboxRoute = require('./routes/inbox');
const pageAssistantRoute = require('./routes/pageassistant');
const authRoute = require('./routes/auth');
const workersRoute = require('./routes/workers');
const clientsRoute = require('./routes/clients');
const clientPortalRoute = require('./routes/clientPortal');

const app = express();
const PORT = process.env.PORT || 3000;

// Fly.io terminates TLS at its edge and forwards requests over plain HTTP
// internally, setting X-Forwarded-Proto to tell you the original scheme.
// Without this, req.protocol always reports 'http' even for real HTTPS
// requests — which breaks routes/embed.js's apiBase (it'd bake in an http://
// URL, which then redirects and silently turns POST requests into GETs).
app.set('trust proxy', 1);

// Basic safety nets
app.use(express.json({ limit: '200kb' }));

// /api/chat and /embed/*.js must be reachable from ANY origin — that's the
// whole point, client sites embed this on domains you don't control.
app.use(cors());

// A blunt global rate limiter as a second layer of defense, on top of the
// per-token limiter inside routes/chat.js
app.use('/api/chat', rateLimit({
  windowMs: 60 * 1000,
  max: 60, // generous global ceiling; per-token limit in chat.js is the real control
  standardHeaders: true,
  legacyHeaders: false
}));

app.use('/api', chatRoute);
app.use('/api', analyticsRoute);
app.use('/api/auth', authRoute);            // login / me / change-password — all 3 roles
app.use('/api/agency', workersRoute);       // owner-only: hire/manage agency workers
app.use('/api/agency', clientsRoute);       // owner+worker: Clients / Add Client / Client Reports
app.use('/api/client-portal', clientPortalRoute); // client-only: simplified Client Dashboard
app.use('/api/admin', adminRoute);          // owner+worker: AI agent (bot) CRUD, scoped by client
app.use('/api/admin', scrapeRoute);
app.use('/api/admin', inboxRoute);
app.use('/', pageAssistantRoute); // /api/page-assistant/*, /api/admin/page-assistant* — this is "AI Pilot" in the dashboard
app.use('/', embedRoute);

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

if (!process.env.GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY is not set in .env — chat requests will fail until you add it.');
}

// Schema creation is async now (Postgres, not the old synchronous SQLite
// setup), so the server only starts accepting requests once it's confirmed
// the tables exist.
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`WebChat AI backend running on http://localhost:${PORT}`);
      console.log(`Embed snippets served from  http://localhost:${PORT}/embed/<token>.js`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });

