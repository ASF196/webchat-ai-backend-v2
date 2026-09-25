// routes/analytics.js
// Per-bot analytics for the Agency Dashboard. Owner/worker only, and scoped
// to clients the caller can actually access. All aggregation (top questions,
// hourly buckets, last-7-days) happens here in JS after one flat fetch,
// since Firestore has no GROUP BY.

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole, requireBotAccess } = require('../lib/auth');
const router = express.Router();

router.get('/analytics/:token', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const bot = req.bot;
    const snap = await db.collection('questions').where('bot_token', '==', bot.token).get();
    const all = snap.docs
      .map(d => ({ question: d.data().question, asked_at: d.data().asked_at }))
      .sort((a, b) => (a.asked_at || '').localeCompare(b.asked_at || ''));

    const total = all.length;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const monthStr = todayStr.slice(0, 7); // YYYY-MM
    const todayCount = all.filter(q => q.asked_at.slice(0, 10) === todayStr).length;

    // Token usage for the "included in this client's plan" limit — see
    // daily_token_limit on the bot doc, set from the Customize tab.
    // usage_daily doc IDs are `${token}__${day}`, one query for every day
    // this bot has ever had traffic, filtered/summed here in JS (same
    // pattern as everything else in this file — Firestore has no GROUP BY).
    const usageSnap = await db.collection('usage_daily').where('bot_token', '==', bot.token).get();
    const usageDocs = usageSnap.docs.map(d => d.data());
    const todayUsage = usageDocs.find(u => u.day === todayStr);
    const monthTokens = usageDocs.filter(u => (u.day || '').startsWith(monthStr)).reduce((sum, u) => sum + (u.token_count || 0), 0);
    const monthRequests = usageDocs.filter(u => (u.day || '').startsWith(monthStr)).reduce((sum, u) => sum + (u.request_count || 0), 0);

    // Group identical (normalized) questions for "most asked"
    const norm = s => s.toLowerCase().trim().replace(/[?!.,]+$/, '').replace(/\s+/g, ' ');
    const groups = {};
    for (const q of all) {
      const key = norm(q.question);
      if (!groups[key]) groups[key] = { text: q.question, count: 0, last: q.asked_at };
      groups[key].count++;
      if (q.asked_at > groups[key].last) { groups[key].last = q.asked_at; groups[key].text = q.question; }
    }
    const topQuestions = Object.values(groups)
      .sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1))
      .slice(0, 10);

    // Hourly buckets for today
    const hourBuckets = new Array(24).fill(0);
    for (const q of all) {
      if (q.asked_at.slice(0, 10) === todayStr) {
        const hour = parseInt(q.asked_at.slice(11, 13), 10);
        hourBuckets[hour]++;
      }
    }

    // Last 7 days
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const count = all.filter(q => q.asked_at.slice(0, 10) === dayStr).length;
      last7.push({ date: dayStr, count });
    }

    res.json({
      bot: { name: bot.name, siteName: bot.site_name },
      total,
      today: todayCount,
      uniqueQuestions: Object.keys(groups).length,
      topQuestions,
      hourBuckets,
      last7days: last7,
      recent: all.slice(-20).reverse(),
      usage: {
        tokensToday: todayUsage?.token_count || 0,
        requestsToday: todayUsage?.request_count || 0,
        dailyTokenLimit: bot.daily_token_limit || null,
        overageAction: bot.overage_action || 'block',
        tokensThisMonth: monthTokens,
        requestsThisMonth: monthRequests,
      },
    });
  } catch (err) {
    console.error('Analytics route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
