// routes/auth.js
// Real login for all three roles (owner, worker, client). Replaces the old
// shared ADMIN_SECRET header for anything user-facing — the dashboards now
// authenticate as a specific person, not "whoever has the secret."

const express = require('express');
const { db } = require('../db');
const { verifyPassword, hashPassword, signToken, requireAuth } = require('../lib/auth');
const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    // Trim BOTH — not just email. A trailing space/newline in the password
    // is an easy, invisible way to get "Invalid email or password" with the
    // "right" password: it happens whenever a password is copy-pasted from
    // somewhere that appends one (a notes app, a terminal echo, a password
    // manager field), and the person has no way to see it's there. The
    // owner-bootstrap password (db/index.js) and every account-creation
    // path (routes/workers.js, routes/clients.js) trim the same way, so a
    // stray trailing space never causes a real mismatch anywhere in the app.
    const id = String(email).trim().toLowerCase();
    const cleanPassword = String(password).trim();

    const doc = await db.collection('users').doc(id).get();
    if (!doc.exists) {
      console.warn(`Login failed: no user doc for "${id}"`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = { id: doc.id, ...doc.data() };
    if (!user.is_active) {
      console.warn(`Login failed: user "${id}" exists but is_active=false`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await verifyPassword(cleanPassword, user.password_hash);
    if (!ok) {
      console.warn(`Login failed: password mismatch for "${id}"`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    let client = null;
    if (user.role === 'client' && user.client_id) {
      const cDoc = await db.collection('clients').doc(user.client_id).get();
      if (cDoc.exists) client = { id: cDoc.id, name: cDoc.data().name, status: cDoc.data().status };
    }

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, client_id: user.client_id || null },
      client,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  let client = null;
  if (req.user.role === 'client' && req.user.client_id) {
    const cDoc = await db.collection('clients').doc(req.user.client_id).get();
    if (cDoc.exists) client = { id: cDoc.id, name: cDoc.data().name, status: cDoc.data().status, website_url: cDoc.data().website_url };
  }
  res.json({ user: req.user, client });
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.trim().length < 8) {
      return res.status(400).json({ error: 'currentPassword and a newPassword (8+ chars) are required' });
    }
    const doc = await db.collection('users').doc(req.user.id).get();
    if (!doc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const ok = await verifyPassword(String(currentPassword).trim(), doc.data().password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await hashPassword(String(newPassword).trim());
    await doc.ref.update({ password_hash: newHash });
    res.json({ ok: true });
  } catch (err) {
    console.error('Change-password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
