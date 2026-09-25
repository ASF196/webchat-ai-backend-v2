// routes/inbox.js
// ADMIN endpoints — used by your dashboard's Conversations page (not by
// visitor sites). Groups human_messages by visitor_id into real conversation
// threads, and lets an agent actually reply.

const express = require('express');
const { db, nowStamp } = require('../db');
const { requireAuth, requireRole, requireBotAccess } = require('../lib/auth');
const router = express.Router();

// List every visitor who's messaged this bot, most recent first, each with
// their latest message + how many of their messages are still unread.
router.get('/human-conversations/:token', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const snap = await db.collection('human_messages').where('bot_token', '==', req.bot.token).get();
    const byVisitor = {};
    for (const d of snap.docs) {
      const m = d.data();
      (byVisitor[m.visitor_id] ||= []).push(m);
    }
    const conversations = Object.entries(byVisitor).map(([visitorId, msgs]) => {
      msgs.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      const last = msgs[msgs.length - 1];
      const unreadCount = msgs.filter(m => m.sender === 'visitor' && !m.read_by_agent).length;
      return { visitorId, lastMessageAt: last.created_at, unreadCount, lastMessage: last.message, lastSender: last.sender };
    }).sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));

    res.json({ conversations });
  } catch (err) {
    console.error('List human-conversations error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Full thread for one visitor — also marks their messages as read, since
// opening the conversation is what "read" means here.
router.get('/human-conversations/:token/:visitorId', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const { visitorId } = req.params;
    const snap = await db.collection('human_messages')
      .where('bot_token', '==', req.bot.token).where('visitor_id', '==', visitorId).get();

    const docs = snap.docs.map(d => ({ ref: d.ref, ...d.data() }))
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

    const batch = db.batch();
    let anyUnread = false;
    for (const m of docs) {
      if (m.sender === 'visitor' && !m.read_by_agent) { batch.update(m.ref, { read_by_agent: true }); anyUnread = true; }
    }
    if (anyUnread) await batch.commit();

    res.json({ messages: docs.map(({ sender, message, created_at }) => ({ sender, message, created_at })) });
  } catch (err) {
    console.error('Get human-conversation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Agent sends a reply — the visitor's widget picks this up on its next poll.
router.post('/human-reply', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const { visitorId, message } = req.body;
    if (!visitorId || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'token, visitorId, and message are required' });
    }
    await db.collection('human_messages').add({
      bot_token: req.bot.token, visitor_id: visitorId, sender: 'agent',
      message: message.slice(0, 1000), created_at: nowStamp(), read_by_agent: true,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Human-reply error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
