import { getStore } from '@netlify/blobs';
import { buildSnapshot, mergeWithPrevious, historyRow } from './feeds.mjs';

const store = () => getStore({ name: 'gaps', consistency: 'strong' });

export async function readLatest() {
  try { return await store().get('latest', { type: 'json' }); } catch { return null; }
}

// Fetch every feed, merge with the previous snapshot, save as "latest".
export async function refreshSnapshot({ appendHistory = false } = {}) {
  const prev = await readLatest();
  const snap = mergeWithPrevious(await buildSnapshot(), prev);
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
