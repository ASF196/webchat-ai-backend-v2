// scripts/restore.js
// Restores a backup (from scripts/backup.js) into whatever Firestore project
// FIREBASE_SERVICE_ACCOUNT points at right now. Every doc is written back
// with its ORIGINAL id (bot tokens, user emails, etc.) via a batched write,
// so nothing that was already pasted into a client's site or bookmarked
// breaks after a restore.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT="...new project's service account JSON..." node scripts/restore.js
//   FIREBASE_SERVICE_ACCOUNT="..." node scripts/restore.js backups/some-older-backup.json

const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const backupPath = process.argv[2] || path.join(__dirname, '..', 'backups', 'latest.json');
if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}

// Firestore batched writes cap at 500 operations each.
async function writeAllDocs(collectionName, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const { id, data } of docs.slice(i, i + 400)) {
      batch.set(db.collection(collectionName).doc(id), data);
    }
    await batch.commit();
  }
}

async function main() {
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
  const collections = backup.collections || {};
  console.log(`Restoring backup from ${backup.backedUpAt}`);

  for (const [name, docs] of Object.entries(collections)) {
    await writeAllDocs(name, docs);
    console.log(`  restored ${docs.length} doc(s) into ${name}`);
  }

  console.log('Restore complete. Bot tokens and user emails are unchanged — existing embed <script> tags and logins keep working.');
}

main().catch(err => {
  console.error('Restore failed:', err);
  process.exit(1);
});
