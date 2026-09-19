// scripts/backup.js
// Dumps every Firestore collection's full contents to a single JSON file.
// Run manually anytime, or on a schedule via .github/workflows/backup.yml.
// The restore script (scripts/restore.js) reads this same file to rebuild
// a fresh Firestore database with IDENTICAL bot tokens and doc IDs — so
// every embed <script> tag your clients already pasted keeps working, and
// every login (user doc ID = email) keeps working, after a restore.
//
// Note: Firestore's free tier doesn't expire the way Render's free Postgres
// did, so this isn't a race against a deadline anymore — it's just good
// practice (protects against accidental deletion, not provider expiry).

const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const COLLECTIONS = [
  'users', 'clients', 'bots', 'questions', 'usage_daily', 'human_messages',
  'page_assistant_settings', 'page_assistant_cache', 'page_assistant_events',
  'quality_tests', 'client_tasks',
];

async function main() {
  const backup = { backedUpAt: new Date().toISOString(), collections: {} };

  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).get();
    backup.collections[name] = snap.docs.map(d => ({ id: d.id, data: d.data() }));
  }

  const outDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));

  const summary = COLLECTIONS.map(name => `${backup.collections[name].length} ${name}`).join(', ');
  console.log(`Backed up: ${summary} → ${outPath}`);
}

main().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
