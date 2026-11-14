// GET /api/live — the one endpoint the dashboard reads.
// Serves the latest stored snapshot. If none exists or it is older than
// 12 minutes (e.g. on a deploy preview, where schedules don't run), it fetches
// fresh data first. The CDN caches the answer for 60 seconds so all visitors
// share one copy.
import { readLatest, refreshSnapshot, useContext } from '../lib/store.mjs';

const MAX_AGE_MS = 12 * 60 * 1000;

export default async (req, context) => {
  useContext(context?.deploy?.context);
  let snap = await readLatest();
  const age = snap ? Date.now() - Date.parse(snap.generatedAt) : Infinity;
  if (!snap || age > MAX_AGE_MS) {
    try {
      snap = await refreshSnapshot();
    } catch (e) {
      if (!snap) return Response.json({ error: 'no data available: ' + e.message }, { status: 503 });
    }
  }
  return new Response(JSON.stringify(snap), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
};

export const config = { path: '/api/live' };
