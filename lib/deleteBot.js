// lib/deleteBot.js
// Deletes a bot and every document across Firestore that references its
// token. Centralized here so admin.js (direct bot delete) and clients.js
// (deleting a whole client cascades to their bots) can't drift out of sync.
const { db } = require('../db');

async function deleteWhere(collectionName, field, value) {
  const snap = await db.collection(collectionName).where(field, '==', value).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

async function deleteBotFully(token) {
  await deleteWhere('questions', 'bot_token', token);
  await deleteWhere('usage_daily', 'bot_token', token);
  await deleteWhere('human_messages', 'bot_token', token);
  await deleteWhere('page_assistant_events', 'bot_token', token);
  await deleteWhere('page_assistant_cache', 'bot_token', token);
  await db.collection('page_assistant_settings').doc(token).delete().catch(() => {});
  await deleteWhere('quality_tests', 'bot_token', token);

  // client_tasks reference a bot for context but shouldn't disappear when
  // the bot does — null out the reference instead of deleting the task.
  const tasksSnap = await db.collection('client_tasks').where('bot_token', '==', token).get();
  if (!tasksSnap.empty) {
    const batch = db.batch();
    tasksSnap.docs.forEach(d => batch.update(d.ref, { bot_token: null }));
    await batch.commit();
  }

  const botDoc = await db.collection('bots').doc(token).get();
  if (!botDoc.exists) return false;
  await botDoc.ref.delete();
  return true;
}

module.exports = { deleteBotFully };
