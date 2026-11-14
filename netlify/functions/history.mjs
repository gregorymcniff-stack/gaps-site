// GET /api/history?range=24h|7d — stored readings for trend lines.
// Each row is one 10-minute reading saved by the scheduled collector.
import { readHistory, useContext } from '../lib/store.mjs';

export default async (req, context) => {
  useContext(context?.deploy?.context);
  const range = new URL(req.url).searchParams.get('range') === '7d' ? '7d' : '24h';
  const hours = range === '7d' ? 168 : 24;
  const since = Date.now() - hours * 3600000;
  const rows = (await readHistory(range === '7d' ? 8 : 2))
    .filter(r => Date.parse(r.t) >= since)
    .map(r => ({
      t: r.t,
      // only rows from the tested outlook model (v2); earlier rows used the old formula
      sfi: r.scores?.outlook ? (r.scores.sfi ?? null) : null, p3: r.scores?.outlook?.p3 ?? null, persist: r.scores?.outlook?.features?.persist ?? null, hubWx: r.scores?.outlook?.features?.usHubStressNext3 ?? null, traffic: r.scores?.traffic ?? null, weather: r.scores?.weather ?? null, jet: r.scores?.jet ?? null,
      faaLoad: r.faa?.load ?? null, gs: r.faa?.gs ?? null, gdp: r.faa?.gdp ?? null,
      score10: r.scores?.scale?.score ?? null, final10: r.scores?.scale?.final ?? null,
      sig: r.sigmets ? Object.values(r.sigmets).reduce((a, b) => a + b, 0) : null,
      ifr: r.metarCats ? (r.metarCats.IFR || 0) + (r.metarCats.LIFR || 0) : null,
      kp: r.kp ?? null,
      aircraft: r.scores?.aircraft ?? r.aircraft ?? null, src: r.scores?.trafficSource ?? (r.aircraft != null ? 'opensky' : null),
    }));
  return new Response(JSON.stringify({ range, generatedAt: new Date().toISOString(), count: rows.length, first: rows[0]?.t || null, rows }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
  });
};

export const config = { path: '/api/history' };
