import { getStore } from '@netlify/blobs';
import { buildSnapshot, mergeWithPrevious, historyRow } from './feeds.mjs';
import { scoreSnapshot } from './scores.mjs';
import { updateProgramLog, backupAdvisoryFeed } from './backup.mjs';

// Production uses the 'gaps' store. Deploy previews and branch deploys get their
// own store, so testing a change can never overwrite the live site's data.
let storeName = 'gaps';
export function useContext(deployContext) {
  storeName = !deployContext || deployContext === 'production' ? 'gaps' : 'gaps-preview';
}
const store = () => getStore({ name: storeName, consistency: 'strong' });

export async function readLatest() {
  try { return await store().get('latest', { type: 'json' }); } catch { return null; }
}

// Fetch every feed, merge with the previous snapshot, save as "latest".
export async function refreshSnapshot({ appendHistory = false, openskyTimeout } = {}) {
  const prev = await readLatest();
  const snap = mergeWithPrevious(await buildSnapshot({ openskyTimeout }), prev);
  const s = store();
  // Backup for the FAA advisory feed (see backup.mjs)
  const faa = snap.feeds.faa;
  if (faa && faa.ok && !faa.carriedOver) {
    const log = updateProgramLog(await s.get('nas-program-log', { type: 'json' }).catch(() => null), faa.data, snap.generatedAt);
    await s.setJSON('nas-program-log', log);
    const adv = snap.feeds.faaAdvisories;
    if (!adv || !adv.ok || adv.carriedOver) snap.feeds.faaAdvisories = backupAdvisoryFeed(adv, log, snap.generatedAt);
  }
  snap.scores = scoreSnapshot(snap);
  await s.setJSON('latest', snap);
  if (appendHistory) {
    const key = 'history/' + snap.generatedAt.slice(0, 10); // one file per UTC day
    const rows = (await s.get(key, { type: 'json' }).catch(() => null)) || [];
    rows.push(historyRow(snap));
    await s.setJSON(key, rows);
    // Heartbeat: written only by the scheduled collector, so the health check can
    // tell a stopped collector apart from page visits refreshing the data.
    await s.setJSON('heartbeat', { t: new Date().toISOString(), snapshot: snap.generatedAt });
  }
  return snap;
}

export async function readHeartbeat() {
  try { return await store().get('heartbeat', { type: 'json' }); } catch { return null; }
}

// History rows for the last `days` UTC days (oldest first).
export async function readHistory(days) {
  const s = store(), out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = 'history/' + new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const rows = await s.get(key, { type: 'json' }).catch(() => null);
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

// Every stored history row, oldest first (one blob per UTC day).
export async function readHistoryAll() {
  const s = store();
  const { blobs } = await s.list({ prefix: 'history/' });
  const keys = blobs.map(b => b.key).sort();
  const out = [];
  for (const key of keys) {
    const rows = await s.get(key, { type: 'json' }).catch(() => null);
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}
