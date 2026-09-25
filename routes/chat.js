// routes/chat.js
// PUBLIC endpoint — this is what every client's embedded <script> snippet calls.
// It is intentionally open to any origin (the widget has to work on any client's
// site), but it never exposes your Groq key — that lives only in process.env here.

const express = require('express');
const { db, nowStamp } = require('../db');
const { generateAnswer } = require('../lib/answerEngine');
const router = express.Router();

// In-memory per-token rate limiting (resets on restart — fine for a single-process
// deploy; move to Redis if you ever run multiple server instances)
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10);
const hits = new Map(); // token -> [timestamps]

function isRateLimited(token) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(token) || []).filter(t => t > windowStart);
  arr.push(now);
  hits.set(token, arr);
  return arr.length > RATE_LIMIT;
}

// Increments today's usage counters for a bot. Firestore has no
// "UPSERT ... ON CONFLICT DO UPDATE" — a transaction is the equivalent:
// read-then-write atomically so concurrent requests don't clobber each other.
// tokensUsed is 0 for routes that never call Groq (e.g. human-message).
async function bumpUsage(token, tokensUsed = 0) {
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.collection('usage_daily').doc(`${token}__${today}`);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (doc.exists) {
      tx.update(ref, {
        request_count: (doc.data().request_count || 0) + 1,
        token_count: (doc.data().token_count || 0) + tokensUsed,
      });
    } else {
      tx.set(ref, { bot_token: token, day: today, request_count: 1, token_count: tokensUsed });
    }
  });
}

// Read-only lookup of today's usage so the pre-flight limit check below
// doesn't need its own transaction — only bumpUsage needs the atomicity.
async function getTodayTokenUsage(token) {
  const today = new Date().toISOString().slice(0, 10);
  const doc = await db.collection('usage_daily').doc(`${token}__${today}`).get();
  return doc.exists ? (doc.data().token_count || 0) : 0;
}

// Shown to visitors instead of a real answer once a bot's daily_token_limit
// is hit and overage_action is 'block' — this is a deliberate, friendly
// stop rather than the raw 429 Groq itself would eventually return, and
// (more importantly) it protects the shared free-tier budget from being
// exhausted by one bot so every other bot on the same key can keep working.
const LIMIT_REACHED_REPLY = "Thanks for reaching out — this assistant has hit its usage limit for today and will be back online shortly. Feel free to leave your question here and the team will follow up directly.";

router.post('/chat', async (req, res) => {
  try {
    const { token, message, history = [], pageContext } = req.body;
    if (!token || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'token and message are required' });
    }

    const botDoc = await db.collection('bots').doc(token).get();
    if (!botDoc.exists || botDoc.data().is_active === false) {
      return res.status(404).json({ error: 'Unknown or inactive bot token' });
    }
    const bot = { token: botDoc.id, ...botDoc.data() };

    if (isRateLimited(token)) {
      return res.status(429).json({ error: 'This bot is receiving too many requests. Try again shortly.' });
    }

    // Log the question — this is what powers the Analytics dashboard
    await db.collection('questions').add({
      bot_token: token, question: message.slice(0, 500),
      visitor_id: req.body.visitorId || null, asked_at: nowStamp(), is_human_request: false,
    });

    // Usage cap (set per-bot from the agency dashboard's Customize tab —
    // null/0 means unlimited). Checked BEFORE calling Groq, not after, so a
    // bot that's already over its limit never spends another token getting
    // there — the whole point is protecting the remaining shared daily
    // budget for every other bot on the same GROQ_API_KEY.
    if (bot.daily_token_limit && bot.overage_action !== 'allow') {
      const usedToday = await getTodayTokenUsage(token);
      if (usedToday >= bot.daily_token_limit) {
        await bumpUsage(token); // still counts as a request for the dashboard, just 0 tokens
        return res.json({ reply: LIMIT_REACHED_REPLY, suggestions: [], unsure: false, limitReached: true });
      }
    }

    // pageContext (from an AI Pilot popup click, if enabled) is the actual
    // extracted text of the page section the visitor was looking at when
    // they asked — never raw HTML — capped here regardless of what's sent,
    // so a misbehaving client can't blow up prompt size.
    let result;
    try {
      result = await generateAnswer(bot, message, history, pageContext);
    } catch (err) {
      if (err.upstream) return res.status(502).json({ error: "Sorry, I'm having trouble answering right now. Please try again in a moment." });
      throw err;
    }
    await bumpUsage(token, result.usage?.totalTokens || 0);

    // Human handoff toggle: when OFF, an uncertain answer never surfaces
    // "Talk to a Human" — it just reads as a normal, friendly dead end. The
    // widget only shows that prompt when `unsure` is true (see embed.js),
    // so overriding both fields here is the single place that decision needs
    // to live, regardless of which page-assistant/analytics code also reads
    // `unsure` down the line.
    if (result.unsure && bot.human_handoff_enabled === false) {
      result = {
        reply: "I'm not sure about that — is there anything else I can help with?",
        suggestions: result.suggestions || [],
        unsure: false,
      };
    }

    res.json(result); // { reply, suggestions, unsure } — unsure tells the widget whether to offer "Talk to a Human"
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Called when a visitor uses "Talk to a Human" in the widget, and for every
// message they send afterward. Doesn't touch Groq — just logs the message
// into a real per-visitor conversation thread (human_messages), so multiple
// messages from the same visitor stay grouped together instead of looking
// like separate unrelated people, and so an agent's reply can actually be
// delivered back.
router.post('/human-message', async (req, res) => {
  try {
    const { token, message, visitorId } = req.body;
    if (!token || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'token and message are required' });
    }
    if (!visitorId || typeof visitorId !== 'string') {
      return res.status(400).json({ error: 'visitorId is required' });
    }

    const botDoc = await db.collection('bots').doc(token).get();
    if (!botDoc.exists || botDoc.data().is_active === false) {
      return res.status(404).json({ error: 'Unknown or inactive bot token' });
    }

    if (isRateLimited(token)) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }

    await db.collection('human_messages').add({
      bot_token: token, visitor_id: visitorId, sender: 'visitor',
      message: message.slice(0, 1000), created_at: nowStamp(), read_by_agent: false,
    });
    await bumpUsage(token);

    res.json({ ack: true });
  } catch (err) {
    console.error('Human-message route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUBLIC — the widget polls this every few seconds while in human mode, to
// pick up any reply an agent sends from the dashboard. No admin secret
// needed: visitorId itself is an unguessable per-browser random string (see
// embed.js), so knowing it is equivalent to being that visitor.
router.get('/human-messages/:token/:visitorId', async (req, res) => {
  try {
    const { token, visitorId } = req.params;
    const snap = await db.collection('human_messages')
      .where('bot_token', '==', token).where('visitor_id', '==', visitorId).get();
    const messages = snap.docs
      .map(d => ({ sender: d.data().sender, message: d.data().message, created_at: d.data().created_at }))
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    res.json({ messages });
  } catch (err) {
    console.error('Human-messages poll error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
