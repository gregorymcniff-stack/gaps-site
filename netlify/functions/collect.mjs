// Scheduled: runs every 10 minutes on the published site, whether or not anyone
// has the page open. (Netlify does not run schedules on deploy previews.)
import { refreshSnapshot } from '../lib/store.mjs';

export default async () => {
  const snap = await refreshSnapshot({ appendHistory: true });
  const status = Object.fromEntries(Object.entries(snap.feeds).map(([k, f]) => [k, f.ok ? 'ok' : f.error]));
  console.log('GAPS snapshot', snap.generatedAt, JSON.stringify(status));
};

export const config = { schedule: '*/10 * * * *' };
