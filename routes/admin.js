// routes/admin.js
// AI Agent (bot) CRUD — used by the Agency Dashboard's "AI Configuration"
// screen. Every agent now belongs to a client, and access is scoped:
// owner -> any agent, worker -> only agents of clients assigned to them.

const express = require('express');
const { nanoid } = require('nanoid');
const { db, nowStamp, queryInChunks } = require('../db');
const { requireAuth, requireRole, requireBotAccess, canAccessClient } = require('../lib/auth');
const { deleteBotFully } = require('../lib/deleteBot');
const router = express.Router();

// Create a new trained agent for a client -> returns the token to embed
router.post('/bots', requireAuth, requireRole('owner', 'worker'), async (req, res) => {
  try {
    const { clientId, name, siteUrl, siteName, colorGrad, iconKey, iconDataUrl, greeting, knowledgeBase } = req.body;
    if (!knowledgeBase) return res.status(400).json({ error: 'knowledgeBase is required' });
    if (!clientId) return res.status(400).json({ error: 'clientId is required -- every agent belongs to a client' });
    if (!(await canAccessClient(req.user, clientId))) return res.status(403).json({ error: 'Forbidden' });

    const token = 'sp_' + nanoid(24);
    const data = {
      client_id: clientId, name: name || 'WebChat AI', site_url: siteUrl || null, site_name: siteName || null,
      color_grad: colorGrad || null, icon_key: iconKey || 'bot', icon_data_url: iconDataUrl || null,
      greeting: greeting || "Hi! Ask me anything about this site.", knowledge_base: knowledgeBase,
      is_active: true, created_at: nowStamp(),
    };
    await db.collection('bots').doc(token).set(data);
    res.json({ token });
  } catch (err) {
    console.error('Create bot error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update an existing agent's config (re-train, change name/color/etc)
router.patch('/bots/:token', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const fieldMap = {
      name: 'name', siteUrl: 'site_url', siteName: 'site_name', colorGrad: 'color_grad',
      iconKey: 'icon_key', iconDataUrl: 'icon_data_url', greeting: 'greeting',
      knowledgeBase: 'knowledge_base', isActive: 'is_active', orbGlow: 'orb_glow',
      humanHandoffEnabled: 'human_handoff_enabled', glowColor: 'glow_color',
      customNotes: 'custom_notes',
    };
    const updates = {};
    for (const [bodyKey, val] of Object.entries(req.body)) {
      const col = fieldMap[bodyKey];
      if (col) updates[col] = val;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    await db.collection('bots').doc(req.params.token).update(updates);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update bot error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function attachClientNames(bots) {
  const cache = {};
  for (const b of bots) {
    if (b.client_id && !(b.client_id in cache)) {
      const cDoc = await db.collection('clients').doc(b.client_id).get();
      cache[b.client_id] = cDoc.exists ? cDoc.data().name : null;
    }
  }
  return bots
    .map(b => ({ token: b.token, name: b.name, site_name: b.site_name, client_id: b.client_id, client_name: cache[b.client_id] || null, created_at: b.created_at, is_active: b.is_active }))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// List agents -- owner sees all, worker sees only agents of their clients
router.get('/bots', requireAuth, requireRole('owner', 'worker'), async (req, res) => {
  try {
    if (req.user.role === 'owner') {
      const snap = await db.collection('bots').get();
      const bots = snap.docs.map(d => ({ token: d.id, ...d.data() }));
      return res.json({ bots: await attachClientNames(bots) });
    }
    const cSnap = await db.collection('clients').where('assigned_worker_id', '==', req.user.id).get();
    const clientIds = cSnap.docs.map(d => d.id);
    if (!clientIds.length) return res.json({ bots: [] });
    const bots = await queryInChunks(db.collection('bots'), 'client_id', clientIds);
    res.json({ bots: await attachClientNames(bots.map(b => ({ token: b.id, ...b }))) });
  } catch (err) {
    console.error('List bots error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete an agent and everything tied to its token
router.delete('/bots/:token', requireAuth, requireRole('owner', 'worker'), requireBotAccess('token'), async (req, res) => {
  try {
    const ok = await deleteBotFully(req.params.token);
    if (!ok) return res.status(404).json({ error: 'Bot not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete bot error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

module.exports = router;
