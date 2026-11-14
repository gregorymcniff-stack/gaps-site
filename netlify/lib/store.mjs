import { getStore } from '@netlify/blobs';
import { buildSnapshot, mergeWithPrevious, historyRow } from './feeds.mjs';
import { scoreSnapshot } from './scores.mjs';

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
  snap.scores = scoreSnapshot(snap);
  const s = store();
  await s.setJSON('latest', snap);
  if (appendHistory) {
    const key = 'history/' + snap.generatedAt.slice(0, 10); // one file per UTC day
    const rows = (await s.get(key, { type: 'json' }).catch(() => null)) || [];
    rows.push(historyRow(snap));
    await s.setJSON(key, rows);
  }
  return snap;
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
