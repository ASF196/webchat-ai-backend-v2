// routes/pageassistant.js
// AI PILOT — the widget's ONLY on-page intelligence feature. As a visitor
// scrolls, it notices which section of the page they're looking at and
// offers ONE relevant question as a popup above the chat launcher — e.g.
// landing on a "Practice Areas" section prompts "What areas do you
// practice in?". Clicking it asks that question in chat.
//
// No cursor movement, no clicking, no navigation — this only ever reads
// text (via the browser's own IntersectionObserver, client-side) and shows
// a button. See db/index.js for the page_assistant_* collections this uses.

const crypto = require('crypto');
const express = require('express');
const { db, nowStamp } = require('../db');
const { requireAuth, requireRole, requireBotAccess } = require('../lib/auth');
const router = express.Router();

const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = 'openai/gpt-oss-20b';

function safeParseJson(raw) {
  if (!raw) return null;
  let text = String(raw).trim().replace(/```(json)?/gi, '').trim();
  const start = text.indexOf('[');
  if (start === -1) return null;
  const end = text.lastIndexOf(']');
  if (end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through to salvage below */ }
  }
  // The model's response got cut off before a closing ']' (large batches of
  // sections can run past the token budget) — rather than throwing away
  // every question in the batch because the LAST one didn't finish, pull
  // out whichever {"section":...,"question":...} objects DID complete and
  // use those. A partial batch of real questions beats an empty one.
  const objMatches = text.slice(start).match(/\{[^{}]*\}/g);
  if (!objMatches) return null;
  const salvaged = [];
  for (const m of objMatches) {
    try { salvaged.push(JSON.parse(m)); } catch { /* skip the one broken object, keep the rest */ }
  }
  return salvaged.length ? salvaged : null;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — same page content, reuse the same questions

const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10);
const hits = new Map();
function isRateLimited(token) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(token) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(token, arr);
  return arr.length > RATE_LIMIT;
}

function logEvent(token, visitorId, eventType, pageUrl, label) {
  db.collection('page_assistant_events').add({
    bot_token: token, visitor_id: visitorId || null, event_type: eventType,
    page_url: pageUrl ? String(pageUrl).slice(0, 500) : null,
    label: label ? String(label).slice(0, 100) : null, created_at: nowStamp(),
  }).catch((err) => console.error('Page assistant event log failed:', err));
}

// page_url can contain characters Firestore doc IDs don't allow (/, long
// length) — hash it into a safe, deterministic ID so the same (bot, URL)
// pair always maps to the same cache doc (equivalent to the old table's
// composite primary key).
function cacheDocId(token, pageUrl) {
  const hash = crypto.createHash('sha1').update(pageUrl).digest('hex');
  return `${token}__${hash}`;
}

// ============================================================================
// PUBLIC
// ============================================================================
router.get('/api/page-assistant/config/:token', async (req, res) => {
  try {
    const doc = await db.collection('page_assistant_settings').doc(req.params.token).get();
    if (!doc.exists || !doc.data().enabled) return res.json({ enabled: false });
    const s = doc.data();
    res.json({ enabled: true, cooldownSeconds: s.cooldown_seconds ?? 0, maxSuggestions: s.max_suggestions ?? 6 });
  } catch (err) {
    console.error('Page assistant config error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// One batched call per page per visitor (then cached) — the widget sends
// every section it detected (name + short text extract), and gets back ONE
// natural question per section, grounded only in that section's own text.
router.post('/api/page-assistant/section-questions', async (req, res) => {
  try {
    const { token, pageUrl, sections } = req.body;
    if (!token || !pageUrl || !Array.isArray(sections) || !sections.length) {
      return res.status(400).json({ error: 'token, pageUrl, and a non-empty sections array are required' });
    }
    const botDoc = await db.collection('bots').doc(token).get();
    if (!botDoc.exists || botDoc.data().is_active === false) return res.status(404).json({ error: 'Unknown or inactive bot token' });

    const settingsDoc = await db.collection('page_assistant_settings').doc(token).get();
    if (!settingsDoc.exists || !settingsDoc.data().enabled) return res.json({ questions: [] });

    const cacheId = cacheDocId(token, pageUrl);
    const cachedDoc = await db.collection('page_assistant_cache').doc(cacheId).get();
    if (cachedDoc.exists) {
      const c = cachedDoc.data();
      const cachedAt = new Date(String(c.created_at).replace(' ', 'T') + 'Z').getTime();
      if (Date.now() - cachedAt < CACHE_TTL_MS) {
        let questions = [];
        try { questions = JSON.parse(c.questions || '[]'); } catch { /* ignore */ }
        if (questions.length) return res.json({ questions });
      }
    }

    if (isRateLimited(token)) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

    const cleanSections = sections.slice(0, 15).map((s) => ({
      name: String(s.name || '').slice(0, 80),
      text: String(s.text || '').slice(0, 900),
    })).filter((s) => s.name && s.text);
    if (!cleanSections.length) return res.json({ questions: [] });

    const prompt = `A visitor is scrolling through a webpage. For EACH section below, write the ONE most natural question a real visitor would have after reading just that section — the question that section itself would make someone wonder. The very first section (the hero/top of page) usually prompts something like "What is this page?" or "What does this company do?" — later sections should prompt more specific questions based on their actual content.

SECTIONS IN SCROLL ORDER (JSON):
${JSON.stringify(cleanSections)}

Respond with ONLY a JSON array, no markdown fences, no extra text, one entry per section IN THE SAME ORDER:
[{"section":"<exact section name from input>","question":"<short natural question, under 10 words>"}, ...]

Rules:
- Base each question ONLY on that section's own text — never invent something not actually there.
- Keep questions short and conversational, like something a person would actually type or tap.
- Write like a curious visitor talking out loud, not like the company's own marketing copy — plain everyday words, no jargon, no industry terms, no legalese or buzzwords even if the section itself uses them.
- A stranger who has never read this page should understand the question instantly, with zero re-reading.
- Don't repeat near-identical questions across sections.
- Never write vague meta-questions like "summarize this page" or "tell me more" — always ask about something SPECIFIC and concrete that's actually named or described in that section's text (a specific plan, service, feature, claim, or fact), so the question can be answered from that section alone.`;
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.4 }),
    });
    if (!groqRes.ok) {
      const errBody = await groqRes.text();
      console.error('Groq error (section-questions):', groqRes.status, errBody);
      return res.status(502).json({ error: 'Upstream AI provider error.' });
    }
    const data = await groqRes.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = safeParseJson(raw);
    const questions = Array.isArray(parsed)
      ? parsed.filter((q) => q && q.section && q.question).map((q) => ({
          section: String(q.section).slice(0, 80),
          question: String(q.question).slice(0, 100),
        })).slice(0, 15)
      : [];

    if (questions.length) {
      await db.collection('page_assistant_cache').doc(cacheId).set({
        bot_token: token, page_url: pageUrl, questions: JSON.stringify(questions), created_at: nowStamp(),
      });
    }

    res.json({ questions });
  } catch (err) {
    console.error('Section-questions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/api/page-assistant/event', async (req, res) => {
  try {
    const { token, visitorId, eventType, pageUrl, label } = req.body;
    if (!token || !['suggestion_shown', 'suggestion_clicked'].includes(eventType)) {
      return res.status(400).json({ error: 'token and a valid eventType are required' });
    }
    const botDoc = await db.collection('bots').doc(token).get();
    if (!botDoc.exists || botDoc.data().is_active === false) return res.status(404).json({ error: 'Unknown or inactive bot token' });
    logEvent(token, visitorId, eventType, pageUrl, label);
    res.json({ ok: true });
  } catch (err) {
    console.error('Page assistant event route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ADMIN
// ============================================================================
router.get('/api/admin/page-assistant/:token', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const doc = await db.collection('page_assistant_settings').doc(req.params.token).get();
    res.json({
      settings: doc.exists ? doc.data() : { bot_token: req.params.token, enabled: false, cooldown_seconds: 0, max_suggestions: 6 },
    });
  } catch (err) {
    console.error('Get page-assistant settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/api/admin/page-assistant/:token', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const b = req.body || {};
    const enabled = !!b.enabled;
    const cooldownSeconds = Number.isFinite(b.cooldownSeconds) ? Math.max(0, Math.min(60, Math.round(b.cooldownSeconds))) : 0;
    const maxSuggestions = Number.isFinite(b.maxSuggestions) ? Math.max(0, Math.min(20, Math.round(b.maxSuggestions))) : 6;

    await db.collection('page_assistant_settings').doc(req.params.token).set({
      enabled, cooldown_seconds: cooldownSeconds, max_suggestions: maxSuggestions, updated_at: nowStamp(),
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Update page-assistant settings error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

router.get('/api/admin/page-assistant-analytics/:token', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const snap = await db.collection('page_assistant_events').where('bot_token', '==', req.params.token).get();
    const events = snap.docs.map((d) => d.data());

    const shown = events.filter((e) => e.event_type === 'suggestion_shown').length;
    const clicked = events.filter((e) => e.event_type === 'suggestion_clicked').length;
    const clickRate = shown > 0 ? Math.round((clicked / shown) * 1000) / 10 : 0;

    const labelCounts = {};
    for (const e of events) {
      if (e.event_type !== 'suggestion_clicked' || !e.label) continue;
      labelCounts[e.label] = (labelCounts[e.label] || 0) + 1;
    }
    const mostClicked = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, count]) => ({ label, count }));

    res.json({ suggestionsShown: shown, suggestionsClicked: clicked, clickRate, mostClicked });
  } catch (err) {
    console.error('Page assistant analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
