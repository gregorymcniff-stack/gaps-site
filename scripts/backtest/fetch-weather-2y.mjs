// Download two years of hourly historical forecasts (Open-Meteo historical-forecast
// API) for the 15 US hubs and a 24-point grid over the busiest US airspace.
// Usage: node fetch-weather-2y.mjs 2024-11-15 2026-11-18 out.json
import fs from 'node:fs';
const [start, end, out] = process.argv.slice(2);
const HUBS = {
  JFK: [40.64, -73.78], LGA: [40.78, -73.87], EWR: [40.69, -74.17], BOS: [42.36, -71.01], ORD: [41.98, -87.90], ATL: [33.64, -84.43],
  DFW: [32.90, -97.04], DEN: [39.86, -104.67], LAX: [33.94, -118.41], SFO: [37.62, -122.38], SEA: [47.45, -122.31], MIA: [25.79, -80.29],
  IAH: [29.98, -95.34], PHL: [39.87, -75.24], CLT: [35.21, -80.94],
};
const GRID = {};
for (const la of [32, 36, 40, 44]) for (const lo of [-98, -93, -88, -83, -78, -74]) GRID[`G${la}_${-lo}`] = [la, lo];
const HUB_VARS = 'weather_code,wind_speed_10m,wind_gusts_10m,precipitation,snowfall,visibility,cloud_cover_low,temperature_2m,dew_point_2m,cape';
const GRID_VARS = 'weather_code,precipitation,cape';
// split into ~2-month chunks to keep each request small
const chunks = []; for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z');) { const e = new Date(Math.min(d.getTime() + 60 * 86400000, Date.parse(end + 'T00:00:00Z'))); chunks.push([d.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]); d = new Date(e.getTime() + 86400000); }
async function pull(points, vars, a, b) {
  const codes = Object.keys(points);
  const url = 'https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=' + codes.map(c => points[c][0]).join(',') + '&longitude=' + codes.map(c => points[c][1]).join(',') +
    `&start_date=${a}&end_date=${b}&hourly=${vars}&wind_speed_unit=mph&timezone=UTC`;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(240000) });
      if (r.ok) { const arr = await r.json(); return { times: arr[0].hourly.time, data: Object.fromEntries(codes.map((c, i) => [c, arr[i].hourly])) }; }
      console.error('HTTP', r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.error('network', e.cause?.code || e.name || e.message); }
    await new Promise(x => setTimeout(x, 30000));
  }
  throw new Error('failed ' + a);
}
const res = { times: [], data: {} };
for (const [a, b] of chunks) {
  const h = await pull(HUBS, HUB_VARS, a, b), g = await pull(GRID, GRID_VARS, a, b);
  res.times.push(...h.times);
  for (const src of [h.data, g.data]) for (const [c, v] of Object.entries(src)) { res.data[c] ||= {}; for (const [k, arr] of Object.entries(v)) if (k !== 'time') (res.data[c][k] ||= []).push(...arr); }
  console.log(a, b, h.times.length);
  await new Promise(x => setTimeout(x, 3000));
}
res.points = Object.keys(res.data); res.hubs = Object.keys(HUBS); res.grid = Object.keys(GRID);
fs.writeFileSync(out, JSON.stringify(res));
console.log('hours', res.times.length, 'points', res.points.length);
