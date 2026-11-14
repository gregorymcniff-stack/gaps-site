// Download hourly historical weather (Open-Meteo historical-forecast API) for
// the 8 GAPS weather points and 12 major US airports.
// Usage: node fetch-weather.mjs 2026-07-16 2026-11-12 out.json
import fs from 'node:fs';
const [start, end, out] = process.argv.slice(2);
const POINTS = {
  // GAPS sample points (index inputs)
  JFK: [40.64, -73.78], LHR: [51.47, -0.45], ORD: [41.98, -87.90], LAX: [33.94, -118.41],
  SIN: [1.36, 103.99], DXB: [25.25, 55.36], SCL: [-33.39, -70.79], NRT: [35.77, 140.39],
  // additional US hubs (where FAA programs happen)
  LGA: [40.78, -73.87], EWR: [40.69, -74.17], BOS: [42.36, -71.01], ATL: [33.64, -84.43], DFW: [32.90, -97.04],
  DEN: [39.86, -104.67], SFO: [37.62, -122.38], SEA: [47.45, -122.31], MIA: [25.79, -80.29], IAH: [29.98, -95.34], PHL: [39.87, -75.24], CLT: [35.21, -80.94],
};
const codes = Object.keys(POINTS);
const url = 'https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=' + codes.map(c => POINTS[c][0]).join(',') +
  '&longitude=' + codes.map(c => POINTS[c][1]).join(',') + `&start_date=${start}&end_date=${end}` +
  '&hourly=weather_code,wind_speed_10m,wind_gusts_10m,precipitation,visibility,cloud_cover_low,wind_speed_250hPa&wind_speed_unit=mph&timezone=UTC';
const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!r.ok) { console.error('HTTP', r.status, await r.text()); process.exit(1); }
const arr = await r.json();
const outObj = { points: codes, times: arr[0].hourly.time, data: Object.fromEntries(codes.map((c, i) => [c, arr[i].hourly])) };
fs.writeFileSync(out, JSON.stringify(outObj));
console.log('hours', outObj.times.length, 'points', codes.length, 'vars', Object.keys(arr[0].hourly));
