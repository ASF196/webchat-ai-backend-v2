// lib/auth.js
// Real account auth (replaces the old single shared ADMIN_SECRET header).
// Three roles:
//   owner  — full access to everything
//   worker — access only to clients assigned to them (clients.assigned_worker_id)
//   client — access only to their own client_id's data (their AI agent(s))
//
// A JWT is issued on login and sent as `Authorization: Bearer <token>`.
// It's stateless (no session collection) — revoking access means
// deactivating the user doc (is_active) or, for a full sweep, rotating
// JWT_SECRET.
//
// User doc IDs are the lowercased email itself (not an auto-generated ID) —
// that makes "does this email already exist" and "look up user by email" both
// O(1) doc reads instead of a query, and gives us a natural unique constraint
// Firestore doesn't otherwise enforce.

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set in .env — auth tokens cannot be safely issued or verified until you add one.');
}
const TOKEN_TTL = '7d';

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, client_id: user.client_id || null },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Verifies the bearer token, loads the fresh user doc (so a deactivated or
// deleted account is rejected even with a still-valid, unexpired token),
// and attaches it to req.user.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const payload = jwt.verify(token, JWT_SECRET);
    const doc = await db.collection('users').doc(payload.id).get();
    if (!doc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const u = doc.data();
    if (!u.is_active) return res.status(401).json({ error: 'Unauthorized' });

    req.user = { id: doc.id, email: u.email, name: u.name, role: u.role, client_id: u.client_id || null };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Usage: requireRole('owner'), requireRole('owner', 'worker')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// True if req.user is allowed to act on the given client id.
async function canAccessClient(user, clientId) {
  if (!clientId) return false;
  if (user.role === 'owner') return true;
  if (user.role === 'client') return user.client_id === clientId;
  if (user.role === 'worker') {
    const doc = await db.collection('clients').doc(clientId).get();
    return doc.exists && doc.data().assigned_worker_id === user.id;
  }
  return false;
}

// Middleware factory: looks up the client id from req.params[paramName]
// (defaults to 'clientId') and 403s if the caller can't access it.
function requireClientAccess(paramName = 'clientId') {
  return async (req, res, next) => {
    const clientId = req.params[paramName];
    const ok = await canAccessClient(req.user, clientId);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// Middleware factory for routes keyed by bot token instead of client id
// (chat/knowledge/embed/quality-testing endpoints) — resolves the bot's
// owning client, then applies the same access rule. Attaches the full bot
// doc (with .token merged in as its id) to req.bot for the handler to reuse.
function requireBotAccess(paramName = 'token') {
  return async (req, res, next) => {
    const token = req.params[paramName] || req.body[paramName];
    const doc = await db.collection('bots').doc(token).get();
    if (!doc.exists) return res.status(404).json({ error: 'Bot not found' });
    const bot = { token: doc.id, ...doc.data() };
    const ok = await canAccessClient(req.user, bot.client_id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    req.bot = bot;
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  requireRole,
  canAccessClient,
  requireClientAccess,
  requireBotAccess,
};
