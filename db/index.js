// db/index.js
// Firestore-backed persistent storage (Firebase). Chosen for a permanent
// free tier and native multi-device access — every login and every route
// reads/writes this one shared Firestore database, so switching devices
// just means logging in again, nothing to "sync."
//
// Firestore is a NoSQL document store: no joins, no GROUP BY, no compound
// WHERE+ORDER BY on different fields without a manually-created composite
// index. To keep this running with ZERO manual index setup, every route in
// this project filters on at most one field per query and does any
// sorting/aggregation in JS after fetching — slightly more app code, zero
// Firebase Console visits required.

const admin = require('firebase-admin');

function loadCredential() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not set. Paste your Firebase service account JSON into this env var (raw JSON or base64-encoded JSON both work).');
  }
  try {
    // Accept either raw JSON or base64-encoded JSON — base64 sidesteps
    // hosts that mangle multiline/quoted env var values.
    const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT could not be parsed as JSON (or base64-encoded JSON): ' + err.message);
  }
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(loadCredential()) });
}

const db = admin.firestore();

// Matches the "YYYY-MM-DD HH:MM:SS" format the old Postgres schema used, so
// the frontend's wcaTimeAgo() and every existing date-slicing
// (`.slice(0,10)` for a day, `.slice(11,13)` for an hour) keep working
// completely unchanged.
function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Splits an array into chunks of at most `size` — Firestore's `in`/`array-contains-any`
// operators accept at most 30 values per query.
function chunk(arr, size = 30) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Runs a `where(field, 'in', values)` query across as many 30-value chunks
// as needed and returns the combined, flattened doc array (each with `.id`
// merged in, since Firestore doc data doesn't include its own ID).
async function queryInChunks(collectionRef, field, values) {
  if (!values || !values.length) return [];
  const chunks = chunk(values);
  const results = await Promise.all(
    chunks.map(c => collectionRef.where(field, 'in', c).get())
  );
  return results.flatMap(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

async function init() {
  // Firestore has no schema to create — collections and fields simply
  // appear on first write. The only startup work is the same first-run
  // owner-account bootstrap the Postgres version did.
  const ownerSnap = await db.collection('users').where('role', '==', 'owner').limit(1).get();
  if (!ownerSnap.empty) return;

  if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD) {
    const bcrypt = require('bcryptjs');
    const email = process.env.OWNER_EMAIL.trim().toLowerCase();
    const existing = await db.collection('users').doc(email).get();
    if (!existing.exists) {
      // Trimmed the same way routes/auth.js trims a submitted password —
      // Render's env var input is a web form too, and it's very easy to
      // paste a value with a trailing space/newline into it without
      // noticing. If this weren't trimmed identically on both sides, that
      // invisible whitespace would become a permanent, silent password
      // mismatch with no way to see why from the login screen.
      const hash = await bcrypt.hash(process.env.OWNER_PASSWORD.trim(), 10);
      await db.collection('users').doc(email).set({
        email, password_hash: hash, name: process.env.OWNER_NAME || 'Owner',
        role: 'owner', client_id: null, is_active: true, created_at: nowStamp(),
      });
      console.log(`✅ Owner account bootstrapped for ${email}`);
    }
  } else {
    console.warn('⚠️  No owner account exists yet, and OWNER_EMAIL/OWNER_PASSWORD are not set. Set them in .env and restart to create the first login.');
  }
}

module.exports = { db, admin, init, nowStamp, chunk, queryInChunks };
