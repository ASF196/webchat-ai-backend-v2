// routes/clients.js
// The core of the Agency Dashboard: Owner sees every client, a Worker sees
// only clients assigned to them. This is the "Clients / Add Client" screen
// and each client's workspace root.

const express = require('express');
const { db, nowStamp, queryInChunks } = require('../db');
const { requireAuth, requireRole, requireClientAccess, hashPassword } = require('../lib/auth');
const { deleteBotFully } = require('../lib/deleteBot');
const router = express.Router();

// Firestore has no JOIN — fetch the assigned worker's name/email and the
// bot count for a client doc as two extra small reads per client. Fine at
// agency scale (dozens/hundreds of clients, not millions).
async function attachWorkerAndCount(clientDoc) {
  const c = { id: clientDoc.id, ...clientDoc.data() };
  if (c.assigned_worker_id) {
    const wDoc = await db.collection('users').doc(c.assigned_worker_id).get();
    if (wDoc.exists) { c.worker_name = wDoc.data().name; c.worker_email = wDoc.data().email; }
  }
  const botsSnap = await db.collection('bots').where('client_id', '==', c.id).get();
  c.agent_count = botsSnap.size;
  const unreadSnap = await db.collection('client_messages')
    .where('client_id', '==', c.id).where('sender', '==', 'client').where('read_by_agency', '==', false).get();
  c.unread_messages = unreadSnap.size;
  return c;
}

// List clients — owner sees all, worker sees only their assigned ones
router.get('/clients', requireAuth, requireRole('owner', 'worker'), async (req, res) => {
  try {
    const snap = req.user.role === 'worker'
      ? await db.collection('clients').where('assigned_worker_id', '==', req.user.id).get()
      : await db.collection('clients').get();

    const clients = await Promise.all(snap.docs.map(attachWorkerAndCount));
    clients.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json({ clients });
  } catch (err) {
    console.error('List clients error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a client. Owner can assign to any worker (or leave unassigned /
// self-assign); a worker creating a client is auto-assigned to themselves.
router.post('/clients', requireAuth, requireRole('owner', 'worker'), async (req, res) => {
  try {
    const { name, websiteUrl, plan, monthlyPriceCents, assignedWorkerId, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    let workerId = req.user.role === 'worker' ? req.user.id : (assignedWorkerId || null);
    if (req.user.role === 'owner' && assignedWorkerId) {
      const wDoc = await db.collection('users').doc(assignedWorkerId).get();
      if (!wDoc.exists || wDoc.data().role !== 'worker') return res.status(400).json({ error: 'assignedWorkerId is not a valid worker' });
      workerId = assignedWorkerId;
    }

    const data = {
      name, website_url: websiteUrl || null, status: 'onboarding',
      plan: plan || 'managed', monthly_price_cents: monthlyPriceCents || 22900,
      assigned_worker_id: workerId, created_by: req.user.id, notes: notes || null,
      created_at: nowStamp(),
    };
    const ref = db.collection('clients').doc(); // auto-generated ID
    await ref.set(data);
    res.json({ client: { id: ref.id, ...data } });
  } catch (err) {
    console.error('Create client error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/clients/:clientId', requireAuth, requireRole('owner', 'worker'), requireClientAccess('clientId'), async (req, res) => {
  try {
    const doc = await db.collection('clients').doc(req.params.clientId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Client not found' });
    const client = await attachWorkerAndCount(doc);

    const botsSnap = await db.collection('bots').where('client_id', '==', req.params.clientId).get();
    const agents = botsSnap.docs
      .map(d => ({ token: d.id, name: d.data().name, site_url: d.data().site_url, site_name: d.data().site_name,
        color_grad: d.data().color_grad, greeting: d.data().greeting, knowledge_base: d.data().knowledge_base,
        icon_key: d.data().icon_key, icon_data_url: d.data().icon_data_url || null, orb_glow: d.data().orb_glow !== false,
        glow_color: d.data().glow_color || '#5b63f5',
        human_handoff_enabled: d.data().human_handoff_enabled !== false,
        custom_notes: d.data().custom_notes || '',
        daily_token_limit: d.data().daily_token_limit || null, overage_action: d.data().overage_action || 'block',
        is_active: d.data().is_active, created_at: d.data().created_at }))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    // The client's existing portal login (if any) — without this, the
    // agency dashboard's Client Portal tab renders blank fields every time
    // and a saved login looks like it never saved. Never returns the
    // password hash; there's no way to show a password back, only replace it.
    const loginSnap = await db.collection('users').where('client_id', '==', req.params.clientId).get();
    const loginDoc = loginSnap.docs.find(d => d.data().role === 'client');
    const portalLogin = loginDoc
      ? { email: loginDoc.data().email, name: loginDoc.data().name || '', is_active: loginDoc.data().is_active !== false }
      : null;

    res.json({ client, agents, portalLogin });
  } catch (err) {
    console.error('Get client error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update status, plan, price, notes. Reassigning the worker is owner-only.
router.patch('/clients/:clientId', requireAuth, requireRole('owner', 'worker'), requireClientAccess('clientId'), async (req, res) => {
  try {
    const { status, plan, monthlyPriceCents, notes, assignedWorkerId, name, websiteUrl } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (websiteUrl !== undefined) updates.website_url = websiteUrl;
    if (status !== undefined) updates.status = status;
    if (plan !== undefined) updates.plan = plan;
    if (monthlyPriceCents !== undefined) updates.monthly_price_cents = monthlyPriceCents;
    if (notes !== undefined) updates.notes = notes;
    if (assignedWorkerId !== undefined) {
      if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can reassign a client to a different worker' });
      updates.assigned_worker_id = assignedWorkerId || null;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    await db.collection('clients').doc(req.params.clientId).update(updates);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update client error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Owner-only: fully remove a client, their portal login, and their bot(s).
router.delete('/clients/:clientId', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const clientDoc = await db.collection('clients').doc(clientId).get();
    if (!clientDoc.exists) return res.status(404).json({ error: 'Client not found' });

    const botsSnap = await db.collection('bots').where('client_id', '==', clientId).get();
    for (const d of botsSnap.docs) await deleteBotFully(d.id);

    const [qtSnap, ctSnap, userSnap] = await Promise.all([
      db.collection('quality_tests').where('client_id', '==', clientId).get(),
      db.collection('client_tasks').where('client_id', '==', clientId).get(),
      db.collection('users').where('client_id', '==', clientId).get(),
    ]);

    const batch = db.batch();
    qtSnap.docs.forEach(d => batch.delete(d.ref));
    ctSnap.docs.forEach(d => batch.delete(d.ref));
    userSnap.docs.forEach(d => { if (d.data().role === 'client') batch.delete(d.ref); });
    batch.delete(clientDoc.ref);
    await batch.commit();

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete client error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create (or reset) the client's own portal login for the Client Dashboard.
router.post('/clients/:clientId/portal-login', requireAuth, requireRole('owner', 'worker'), requireClientAccess('clientId'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { email, password, name } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const id = String(email).trim().toLowerCase();
    const existing = await db.collection('users').doc(id).get();
    const hasPassword = typeof password === 'string' && password.trim().length > 0;

    // Password is required when creating a login, but optional when one
    // already exists — so editing just the contact name doesn't force the
    // agency to invent a new password and silently lock the client out of
    // the one they're already using.
    if (!existing.exists && (!hasPassword || password.trim().length < 8)) {
      return res.status(400).json({ error: 'email and password (8+ chars) are required to create a login' });
    }
    if (hasPassword && password.trim().length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }

    const data = { email: id, name: name || null, role: 'client', client_id: clientId, is_active: true };
    if (hasPassword) data.password_hash = await hashPassword(password.trim());
    if (existing.exists && existing.data().role !== 'client') {
      // This exact bug happened for real: reusing an owner/worker's own
      // email here silently turned their login into a client account,
      // locking them out of the agency dashboard with no visible cause.
      // A client login can only ever be created for an email that is
      // either brand new or already a client (e.g. resetting their
      // password, or moving them to a different client record) — never
      // for an email that's currently an owner or worker.
      return res.status(409).json({ error: `${id} is already an agency ${existing.data().role} account and can't be converted into a client login. Use a different email for this client's portal login.` });
    }
    if (existing.exists) {
      await existing.ref.update(data);
    } else {
      await db.collection('users').doc(id).set({ ...data, created_at: nowStamp() });
    }
    res.json({ user: { id, email: id, name: data.name, role: 'client', client_id: clientId } });
  } catch (err) {
    console.error('Create portal login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Client Reports — the numbers a worker hands the client (or the client
// sees themselves on their own dashboard, via routes/clientPortal.js).
router.get('/clients/:clientId/report', requireAuth, requireRole('owner', 'worker'), requireClientAccess('clientId'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const botsSnap = await db.collection('bots').where('client_id', '==', clientId).get();
    const tokens = botsSnap.docs.map(d => d.id);
    if (!tokens.length) return res.json({ totals: { questions: 0, humanHandoffs: 0 }, tasks: [] });

    const [questions, humanMsgs] = await Promise.all([
      queryInChunks(db.collection('questions'), 'bot_token', tokens),
      queryInChunks(db.collection('human_messages'), 'bot_token', tokens),
    ]);

    const uniqueVisitors = new Set(humanMsgs.map(m => m.visitor_id));

    const tasksSnap = await db.collection('client_tasks').where('client_id', '==', clientId).get();
    const tasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 20);

    res.json({
      totals: { questions: questions.length, humanHandoffs: uniqueVisitors.size },
      tasks,
    });
  } catch (err) {
    console.error('Client report error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Direct client <-> agency messaging thread. See routes/clientPortal.js for
// the client-side half (GET/POST /api/client-portal/messages).
router.get('/clients/:clientId/messages', requireAuth, requireRole('owner', 'worker'), requireClientAccess('clientId'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const snap = await db.collection('client_messages').where('client_id', '==', clientId).get();
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

    const unread = snap.docs.filter(d => d.data().sender === 'client' && !d.data().read_by_agency);
    if (unread.length) {
      const batch = db.batch();
      unread.forEach(d => batch.update(d.ref, { read_by_agency: true }));
      await batch.commit();
    }

    res.json({ messages });
  } catch (err) {
    console.error('Agency messages fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/clients/:clientId/messages', requireAuth, requireRole('owner', 'worker'), requireClientAccess('clientId'), async (req, res) => {
  try {
    const { clientId } = req.params;
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });

    const data = {
      client_id: clientId, sender: 'agency', message: message.trim().slice(0, 2000),
      created_at: nowStamp(), read_by_agency: true, read_by_client: false, sent_by: req.user.id,
    };
    const ref = db.collection('client_messages').doc();
    await ref.set(data);
    res.json({ message: { id: ref.id, ...data } });
  } catch (err) {
    console.error('Agency message send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
