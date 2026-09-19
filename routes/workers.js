// routes/workers.js
// OWNER-ONLY — hiring/managing agency worker accounts. A worker only ever
// sees clients assigned to them (enforced in routes/clients.js), so this
// is how the owner scales past personally training every client's AI.

const express = require('express');
const { db, nowStamp } = require('../db');
const { requireAuth, requireRole, hashPassword } = require('../lib/auth');
const router = express.Router();

// List workers with how many clients each currently has assigned
router.get('/workers', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const snap = await db.collection('users').where('role', '==', 'worker').get();
    const workers = await Promise.all(snap.docs.map(async (doc) => {
      const w = doc.data();
      const clientSnap = await db.collection('clients').where('assigned_worker_id', '==', doc.id).get();
      return { id: doc.id, email: w.email, name: w.name, is_active: w.is_active, created_at: w.created_at, client_count: clientSnap.size };
    }));
    workers.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json({ workers });
  } catch (err) {
    console.error('List workers error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/workers', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || password.trim().length < 8) {
      return res.status(400).json({ error: 'email and password (8+ chars) are required' });
    }
    const id = String(email).trim().toLowerCase();
    const existing = await db.collection('users').doc(id).get();
    if (existing.exists) return res.status(409).json({ error: 'A user with that email already exists' });

    const hash = await hashPassword(password.trim());
    const data = { email: id, password_hash: hash, name: name || null, role: 'worker', client_id: null, is_active: true, created_at: nowStamp() };
    await db.collection('users').doc(id).set(data);
    res.json({ worker: { id, email: id, name: data.name, role: 'worker', is_active: true, created_at: data.created_at } });
  } catch (err) {
    console.error('Create worker error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/workers/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const id = req.params.id; // Express already URL-decodes path params
    const { name, isActive } = req.body;
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists || doc.data().role !== 'worker') return res.status(404).json({ error: 'Worker not found' });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (isActive !== undefined) updates.is_active = !!isActive;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    await doc.ref.update(updates);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update worker error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deactivate rather than hard-delete, so their past quality-test / task
// history (attributed via tested_by / created_by) stays intact.
router.delete('/workers/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const id = req.params.id; // Express already URL-decodes path params
    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists || doc.data().role !== 'worker') return res.status(404).json({ error: 'Worker not found' });

    const assignedSnap = await db.collection('clients').where('assigned_worker_id', '==', id).get();
    const batch = db.batch();
    assignedSnap.docs.forEach(d => batch.update(d.ref, { assigned_worker_id: null }));
    batch.update(doc.ref, { is_active: false });
    await batch.commit();

    res.json({ ok: true });
  } catch (err) {
    console.error('Deactivate worker error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
