// Sky Friction Index inputs, computed on the server from a snapshot so every
// history row records the scores alongside the raw data. The formulas match
// the ones in public/index.html; keep the two in step.

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const FRESH_MIN = { opensky: 25, airliners: 25, metar: 90, openmeteo: 90, faa: 25 };

export function isFresh(feed, key, now = Date.now()) {
  return !!(feed && feed.data && feed.fetchedAt && (now - Date.parse(feed.fetchedAt)) / 60000 <= (FRESH_MIN[key] || 30));
}

export function metarPressure(reports) {
  if (!Array.isArray(reports) || !reports.length) return null;
  let max = 0, sum = 0;
  for (const r of reports) {
    const combined = (String(r.raw || '') + ' ' + String(r.wx || '')).toUpperCase();
    const wind = Number(r.windKt ?? 0), gust = Number(r.gustKt ?? 0), vis = Number(r.visSm ?? 10);
    let p = 28;
    if (/TS|\+TS|VCTS|TSRA|TSGR/.test(combined)) p += 32;
    if (/\+RA|HVY|GR|SQ|FC/.test(combined)) p += 24;
    if (/RA|SHRA|SN|FZRA|PL|GS/.test(combined)) p += 14;
    if (/FG|BR|HZ|FU|DU|SA/.test(combined) || (Number.isFinite(vis) && vis < 3)) p += 18;
    p += clamp(wind * 0.45 + gust * 0.85, 0, 24);
    p = clamp(p, 15, 95);
    max = Math.max(max, p); sum += p;
  }
  return Math.round(max * 0.6 + (sum / reports.length) * 0.4);
}

export function weatherScore(openmeteoRaw, metarReports) {
  let om = null;
  if (Array.isArray(openmeteoRaw) && openmeteoRaw.length) {
    let max = 0, sum = 0;
    for (const point of openmeteoRaw) {
      const c = point.current || {};
      const code = Number(c.weather_code || 0);
      const convective = [95, 96, 99].includes(code) ? 35 : (code >= 61 && code <= 82 ? 18 : 0);
      const s = clamp(25 + Number(c.wind_speed_10m || 0) * 0.55 + Number(c.wind_gusts_10m || 0) * 0.75 + Number(c.precipitation || 0) * 12 + convective, 15, 95);
      max = Math.max(max, s); sum += s;
    }
    om = Math.round(max * 0.6 + (sum / openmeteoRaw.length) * 0.4);
  }
  const ms = metarPressure(metarReports);
  if (om !== null && Number.isFinite(ms)) return Math.round(om * 0.65 + ms * 0.35);
  if (om !== null) return om;
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

export function jetScore(openmeteoRaw, now = Date.now()) {
  if (!Array.isArray(openmeteoRaw)) return null;
  let maxWind = 0, sum = 0, count = 0;
  for (const point of openmeteoRaw) {
    const h = point.hourly || {}, arr = h.wind_speed_250hPa || [], times = h.time || [];
    if (!arr.length) continue;
    let idx = 0, best = Infinity;
    times.forEach((t, i) => { const d = Math.abs(Date.parse(String(t) + 'Z') - now); if (Number.isFinite(d) && d < best) { best = d; idx = i; } });
    const v = Number(arr[Math.min(idx, arr.length - 1)]);
    if (Number.isFinite(v)) { maxWind = Math.max(maxWind, v); sum += v; count++; }
  }
  if (!count) return null;
  return Math.round(clamp(28 + maxWind * 0.42 + (sum / count) * 0.16, 25, 92));
}

// Provisional scaling per source, until stored history allows calibration.
export const TRAFFIC_SCALE = { opensky: { base: 5000, span: 6000 }, airliners: { base: 2500, span: 2500 } };
export function trafficScore(count, source, now = new Date()) {
  if (!Number.isFinite(count) || !TRAFFIC_SCALE[source]) return null;
  const hour = now.getUTCHours();
  const tod = 1 + 0.18 * Math.sin(Math.PI * (hour - 4) / 14);
  const adjusted = count / Math.max(0.82, tod);
  const { base, span } = TRAFFIC_SCALE[source];
  return Math.round(clamp(42 + ((adjusted - base) / span) * 45, 20, 92));
}

export function sfi(traffic, weather, jet) {
  const W = { traffic: 0.42, weather: 0.36, jet: 0.22 };
  const avail = Object.entries({ traffic, weather, jet }).filter(([, v]) => Number.isFinite(v));
  if (avail.length < 2) return null;
  const wsum = avail.reduce((s, [k]) => s + W[k], 0);
  return Math.round(clamp(avail.reduce((s, [k, v]) => s + v * W[k], 0) / wsum, 0, 100));
}

export function trafficSource(feeds, now = Date.now()) {
  if (isFresh(feeds.opensky, 'opensky', now)) return 'opensky';
  if (isFresh(feeds.airliners, 'airliners', now)) return 'airliners';
  return null;
}

export function scoreSnapshot(snap, now = Date.now()) {
  const f = snap.feeds;
  const src = trafficSource(f, now);
  const count = src ? f[src].data.airborne : null;
  const om = isFresh(f.openmeteo, 'openmeteo', now) ? f.openmeteo.data.raw : null;
  const metar = isFresh(f.metar, 'metar', now) ? f.metar.data.reports : null;
  const t = trafficScore(count, src, new Date(now));
  const w = weatherScore(om, metar);
  const j = jetScore(om, now);
  return {
    trafficSource: src, aircraft: count,
    traffic: t, weather: w, jet: j, sfi: sfi(t, w, j),
    faaLoad: isFresh(f.faa, 'faa', now) ? f.faa.data.programLoad : null,
  };
}
