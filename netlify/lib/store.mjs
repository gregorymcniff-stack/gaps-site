import { getStore } from '@netlify/blobs';
import { buildSnapshot, mergeWithPrevious, historyRow, fetchAdvisoryDay } from './feeds.mjs';
import { programsFromRows, hourlyPredictions, buildTrackRecord } from './track.mjs';
import model from '../../public/data/sfi-model.json' with { type: 'json' };
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

// ---------------------------------------------------------------- live track record
// FAA advisory lists, one blob per UTC day ("faa-day/YYYY-MM-DD"), holding the
// new programs of that day. A day is fetched again until it is complete (read
// at least 3 hours after it ended); after that it is never fetched again.

const DAY = 864e5;
export async function updateTrackRecord({ now = Date.now(), maxFetches = 8 } = {}) {
  const s = store();
  // Hourly predictions, one small blob per finished day ("pred-day/..."), so
  // only today's full history has to be read each hour.
  const { blobs } = await s.list({ prefix: 'history/' });
  const historyDays = blobs.map(b => b.key.slice(8)).sort();
  const predictions = [];
  let firstDay = null;
  for (const day of historyDays) {
    let preds = await s.get('pred-day/' + day, { type: 'json' }).catch(() => null);
    if (!Array.isArray(preds)) {
      preds = hourlyPredictions(await s.get('history/' + day, { type: 'json' }).catch(() => null));
      if (Date.parse(day + 'T00:00:00Z') + DAY <= now - 3600e3) await s.setJSON('pred-day/' + day, preds);
    }
    if (preds.length && !firstDay) firstDay = day;
    predictions.push(...preds);
  }
  if (!firstDay) return null;
  const days = {}, missing = [];
  let fetches = 0;
  for (let d = Date.parse(firstDay + 'T00:00:00Z'); d <= now; d += DAY) {
    const day = new Date(d).toISOString().slice(0, 10);
    const saved = await s.get('faa-day/' + day, { type: 'json' }).catch(() => null);
    if (saved && saved.complete) { days[day] = saved.programs; continue; }
    if (fetches >= maxFetches) { if (saved) days[day] = saved.programs; else missing.push(day); continue; }
    fetches++;
    try {
      const rows = await fetchAdvisoryDay(day, 10000);
      // The FAA site sometimes answers a busy moment with an empty list; an
      // empty day counts as unknown rather than "no programs".
      if (!rows.length) { if (saved) days[day] = saved.programs; else missing.push(day); continue; }
      const entry = { day, fetchedAt: new Date(now).toISOString(), complete: now >= d + DAY + 3 * 3600e3, programs: programsFromRows(rows) };
      await s.setJSON('faa-day/' + day, entry);
      days[day] = entry.programs;
    } catch {
      if (saved) days[day] = saved.programs; else missing.push(day);
    }
  }
  const record = buildTrackRecord({ predictions, days, now, backtestAuc: model.heldOut?.y3big?.auc ?? null });
  record.faaDaysMissing = missing;
  await s.setJSON('track-record', record);
  return record;
}
export async function readTrackRecord() {
  try { return await store().get('track-record', { type: 'json' }); } catch { return null; }
}
