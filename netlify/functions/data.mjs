// GET /api/data?range=24h|7d|30d|all&format=csv|json
// Every stored 10-minute reading as open data. Column meanings:
// https://dashboardrunway.live/data.html
import { readHistory, readHistoryAll, useContext } from '../lib/store.mjs';
import { flatten, toCSV, COLUMNS } from '../lib/opendata.mjs';

const RANGES = { '24h': 1, '7d': 7, '30d': 30 };
export default async (req, context) => {
  useContext(context?.deploy?.context);
  const q = new URL(req.url).searchParams;
  const range = RANGES[q.get('range')] || q.get('range') === 'all' ? q.get('range') : '7d';
  const format = q.get('format') === 'json' ? 'json' : 'csv';
  let rows = range === 'all' ? await readHistoryAll() : await readHistory(RANGES[range] + 1);
  if (range !== 'all') { const since = Date.now() - RANGES[range] * 864e5; rows = rows.filter(r => Date.parse(r.t) >= since); }
  const flat = rows.map(flatten);
  const name = `gaps-readings-${range}-${new Date().toISOString().slice(0, 10)}`;
  const headers = { 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': 'public, s-maxage=300', 'Access-Control-Allow-Origin': '*' };
  if (format === 'json') {
    return new Response(JSON.stringify({ source: 'GAPS · dashboardrunway.live', documentation: 'https://dashboardrunway.live/data.html', range, generatedAt: new Date().toISOString(), columns: COLUMNS, count: flat.length, rows: flat }),
      { headers: { ...headers, 'Content-Type': 'application/json', 'Content-Disposition': `inline; filename="${name}.json"` } });
  }
  return new Response(toCSV(flat), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` } });
};

export const config = { path: '/api/data' };
