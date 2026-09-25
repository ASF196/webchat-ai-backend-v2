// routes/clientPortal.js
// CLIENT-ONLY — powers the simplified Client Dashboard. A client only ever
// sees their own AI agent's numbers and a curated "what we've been doing
// for you" feed — never the agency's internal tools (worker names, other
// clients, quality-test internals, raw config). They CAN edit their own
// bot's look-and-feel (name, greeting, color, icon) — but not its training
// data or active status, which stay agency-managed.

const express = require('express');
const multer = require('multer');
const { db, nowStamp, queryInChunks } = require('../db');
const { requireAuth, requireRole } = require('../lib/auth');
const { uploadIconImage } = require('../lib/cloudinary');
const router = express.Router();
const iconUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth, requireRole('client'));

// A client's own primary bot — the one their dashboard and customization
// form both operate on. Firestore has no "ORDER BY created_at LIMIT 1"
// without an index for this filter, so fetch all (a client normally has
// exactly one bot anyway) and pick the earliest-created in JS.
async function getPrimaryBot(clientId) {
  const snap = await db.collection('bots').where('client_id', '==', clientId).get();
  const bots = snap.docs.map(d => ({ token: d.id, ...d.data() }));
  bots.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  return bots[0] || null;
}

router.get('/dashboard', async (req, res) => {
  try {
    const clientId = req.user.client_id;
    const clientDoc = await db.collection('clients').doc(clientId).get();
    if (!clientDoc.exists) return res.status(404).json({ error: 'Client not found' });
    const client = { id: clientDoc.id, name: clientDoc.data().name, status: clientDoc.data().status, website_url: clientDoc.data().website_url };

    const botsSnap = await db.collection('bots').where('client_id', '==', clientId).get();
    const bots = botsSnap.docs.map(d => ({ token: d.id, ...d.data() }));
    const tokens = bots.map(b => b.token);

    let questionsAnswered = 0, humanHandoffs = 0, pilotInteractions = 0;
    let last7days = [];
    if (tokens.length) {
      const [questions, humanMsgs, events] = await Promise.all([
        queryInChunks(db.collection('questions'), 'bot_token', tokens),
        queryInChunks(db.collection('human_messages'), 'bot_token', tokens),
        queryInChunks(db.collection('page_assistant_events'), 'bot_token', tokens),
      ]);
      questionsAnswered = questions.filter(q => !q.is_human_request).length;
      humanHandoffs = new Set(humanMsgs.map(m => m.visitor_id)).size;
      pilotInteractions = events.filter(e => e.event_type === 'suggestion_clicked').length;

      // A 7-day conversation trend for the dashboard's chart — combines
      // regular questions and human-handoff messages into one "activity
      // that day" count, since both represent a visitor engaging.
      const now = new Date();
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        const qCount = questions.filter(q => (q.asked_at || '').slice(0, 10) === dayStr).length;
        const hCount = humanMsgs.filter(m => m.sender === 'visitor' && (m.created_at || '').slice(0, 10) === dayStr).length;
        last7days.push({ date: dayStr, count: qCount + hCount });
      }
    }

    const totalConversations = questionsAnswered + humanHandoffs;
    const resolutionRate = totalConversations > 0
      ? Math.round((questionsAnswered / totalConversations) * 100)
      : null;

    const primary = bots[0] || null;

    const unreadAgencyMsgSnap = await db.collection('client_messages')
      .where('client_id', '==', clientId).where('sender', '==', 'agency').where('read_by_client', '==', false).get();

    // Unread visitor conversations — visitors talking to a human, waiting
    // on the client (not the agency) to reply. Only counted if this client
    // has actually turned handoff on; otherwise the tab won't even show.
    let unreadConversations = 0;
    if (tokens.length && primary && primary.human_handoff_enabled !== false) {
      const humanMsgsAll = await queryInChunks(db.collection('human_messages'), 'bot_token', tokens);
      const byVisitor = {};
      for (const m of humanMsgsAll) (byVisitor[m.visitor_id] ||= []).push(m);
      unreadConversations = Object.values(byVisitor).filter(msgs => msgs.some(m => m.sender === 'visitor' && !m.read_by_agent)).length;
    }

    res.json({
      client,
      // Everything client.html needs both to show status AND to pre-fill
      // the customization form + build the embed snippet, in one call.
      agent: primary ? {
        token: primary.token, name: primary.name, is_active: primary.is_active, created_at: primary.created_at,
        greeting: primary.greeting, color_grad: primary.color_grad, icon_key: primary.icon_key,
        icon_data_url: primary.icon_data_url || null,
        site_name: primary.site_name, orb_glow: primary.orb_glow !== false,
        glow_color: primary.glow_color || '#5b63f5',
        human_handoff_enabled: primary.human_handoff_enabled !== false,
        custom_notes: primary.custom_notes || '',
      } : null,
      status: { online: !!(primary && primary.is_active) },
      metrics: { conversations: totalConversations, questionsAnswered, resolutionRate, humanHandoffs, pilotInteractions },
      last7days,
      unreadMessages: unreadAgencyMsgSnap.size,
      unreadConversations,
    });
  } catch (err) {
    console.error('Client dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Visitor conversations for the client's own bot — this is the "someone on
// your site asked to talk to a human" inbox. It used to live only in the
// agency dashboard; it's the client's own customers, so it lives here now.
router.get('/conversations', async (req, res) => {
  try {
    const bot = await getPrimaryBot(req.user.client_id);
    if (!bot) return res.json({ conversations: [] });

    const snap = await db.collection('human_messages').where('bot_token', '==', bot.token).get();
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
    console.error('Client conversations fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/conversations/:visitorId', async (req, res) => {
  try {
    const bot = await getPrimaryBot(req.user.client_id);
    if (!bot) return res.status(404).json({ error: 'No AI agent found for your account' });

    const { visitorId } = req.params;
    const snap = await db.collection('human_messages')
      .where('bot_token', '==', bot.token).where('visitor_id', '==', visitorId).get();
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
    console.error('Client conversation thread error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/conversations/:visitorId/reply', async (req, res) => {
  try {
    const bot = await getPrimaryBot(req.user.client_id);
    if (!bot) return res.status(404).json({ error: 'No AI agent found for your account' });

    const { visitorId } = req.params;
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });

    await db.collection('human_messages').add({
      bot_token: bot.token, visitor_id: visitorId, sender: 'agent',
      message: message.trim().slice(0, 1000), created_at: nowStamp(), read_by_agent: true,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Client conversation reply error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Uploads a custom chat-icon image (their logo, say) to Cloudinary and
// returns its URL. The client then saves that URL via PATCH /agent below
// (iconDataUrl) same as the agency side does.
router.post('/icon-upload', iconUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = await uploadIconImage(req.file.buffer, req.file.mimetype);
    res.json({ url });
  } catch (err) {
    console.error('Client icon upload error:', err);
    res.status(400).json({ error: err.message || 'Upload failed' });
  }
});

// Client-editable appearance fields only — never knowledge_base, client_id,
// or is_active. Training and activation stay agency-managed regardless of
// who's allowed to touch the paint job.
router.patch('/agent', async (req, res) => {
  try {
    const bot = await getPrimaryBot(req.user.client_id);
    if (!bot) return res.status(404).json({ error: 'No AI agent found for your account yet — contact your WebChat AI team.' });

    const allowed = { name: 'name', greeting: 'greeting', colorGrad: 'color_grad', iconKey: 'icon_key', iconDataUrl: 'icon_data_url', orbGlow: 'orb_glow', glowColor: 'glow_color', humanHandoffEnabled: 'human_handoff_enabled' };
    const updates = {};
    for (const [bodyKey, col] of Object.entries(allowed)) {
      if (req.body[bodyKey] !== undefined) {
        const isBool = col === 'orb_glow' || col === 'human_handoff_enabled';
        if (isBool) updates[col] = !!req.body[bodyKey];
        // icon_data_url is a Cloudinary link (or null to clear it back to a
        // preset glyph) — not free text, so it skips the 300-char text clamp
        // that would otherwise mangle a real URL or turn null into "null".
        else if (col === 'icon_data_url') updates[col] = req.body[bodyKey] ? String(req.body[bodyKey]).slice(0, 500) : null;
        else updates[col] = String(req.body[bodyKey]).slice(0, 300);
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    await db.collection('bots').doc(bot.token).update(updates);
    res.json({ ok: true });
  } catch (err) {
    console.error('Client agent update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Direct client -> agency messaging — a real inbox thread, not a mailto:
// link. The agency side of this same thread lives in routes/clients.js
// (GET/POST /api/agency/clients/:clientId/messages).
router.get('/messages', async (req, res) => {
  try {
    const clientId = req.user.client_id;
    const snap = await db.collection('client_messages').where('client_id', '==', clientId).get();
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

    // Opening the thread is what "read" means here, same as the human
    // handoff inbox — mark every unread agency message as read.
    const unread = snap.docs.filter(d => d.data().sender === 'agency' && !d.data().read_by_client);
    if (unread.length) {
      const batch = db.batch();
      unread.forEach(d => batch.update(d.ref, { read_by_client: true }));
      await batch.commit();
    }

    res.json({ messages });
  } catch (err) {
    console.error('Client messages fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/messages', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });

    const data = {
      client_id: req.user.client_id, sender: 'client', message: message.trim().slice(0, 2000),
      created_at: nowStamp(), read_by_client: true, read_by_agency: false,
    };
    const ref = db.collection('client_messages').doc();
    await ref.set(data);
    res.json({ message: { id: ref.id, ...data } });
  } catch (err) {
    console.error('Client message send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Custom knowledge a client adds themselves (pasted text or an uploaded
// .txt/.pdf's extracted text). Kept in its own field rather than appended
// straight into knowledge_base so the agency's crawled/curated training
// stays separate from whatever the client adds — either side can be
// re-edited without clobbering the other. lib/answerEngine.js concatenates
// both when building the prompt.
router.patch('/knowledge', async (req, res) => {
  try {
    const bot = await getPrimaryBot(req.user.client_id);
    if (!bot) return res.status(404).json({ error: 'No AI agent found for your account yet — contact your WebChat AI team.' });

    const { customNotes } = req.body;
    if (typeof customNotes !== 'string') return res.status(400).json({ error: 'customNotes must be a string' });

    // 200k chars is far beyond any sane knowledge base and well under
    // Firestore's 1 MB per-document ceiling, so a client pasting a whole
    // book can't produce a document that fails to save.
    await db.collection('bots').doc(bot.token).update({ custom_notes: customNotes.slice(0, 200000) });
    res.json({ ok: true });
  } catch (err) {
    console.error('Client knowledge update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
