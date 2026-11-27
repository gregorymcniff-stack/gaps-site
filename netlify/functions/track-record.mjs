// GET /api/track-record — the live track record (see netlify/lib/track.mjs).
// Built once an hour by the scheduled track-update function. On deploy
// previews (no schedules) it is built on request.
import { readTrackRecord, updateTrackRecord, useContext } from '../lib/store.mjs';

export default async (req, context) => {
  const deployContext = context?.deploy?.context;
  useContext(deployContext);
  let r = await readTrackRecord();
  const stale = !r || Date.now() - Date.parse(r.generatedAt) > 3 * 3600e3;
  if (stale && deployContext && deployContext !== 'production') r = await updateTrackRecord({ maxFetches: 3 }).catch(() => r);
  if (!r) return Response.json({ error: 'The track record has not been built yet. It updates once an hour.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return new Response(JSON.stringify(r), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' },
  });
};

export const config = { path: '/api/track-record' };
