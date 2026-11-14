import model from '../../public/data/sfi-model.json' with { type: 'json' };
import airportModel from '../../public/data/airport-model.json' with { type: 'json' };
// Sky Friction Index inputs, computed on the server from a snapshot so every
// history row records the scores alongside the raw data. The formulas match
// the ones in public/index.html; keep the two in step.

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const FRESH_MIN = { usHubWx: 90, faaAdvisories: 30, opensky: 25, adsblol: 25, metar: 90, openmeteo: 90, faa: 25 };

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
// Both sources report a worldwide total of a few thousand to ~10,000 aircraft.
export const TRAFFIC_SCALE = { opensky: { base: 5000, span: 6000 }, adsblol: { base: 5000, span: 6000 } };
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
  if (isFresh(feeds.adsblol, 'adsblol', now)) return 'adsblol';
  return null;
}

// ---------------------------------------------------------------- Disruption outlook
// US hub capacity weather for one hour index j: identical to the backtest.
function hubStressAt(hw, j) {
  let total = 0;
  for (const c of hw.hubs) {
    const h = hw.hourly[c], at = k => (h[k] && h[k][j] != null ? Number(h[k][j]) : null);
    const wc = at('weather_code') || 0, vis = at('visibility'), low = at('cloud_cover_low'), gust = at('wind_gusts_10m') || 0;
    let x = 0;
    if (wc >= 95) x += 3; else if (wc >= 61 && wc <= 82) x += 0.7; else if (wc >= 71 && wc <= 77) x += 1.5;
    if (vis != null && vis < 1600) x += 2; else if (vis != null && vis < 4800) x += 1;
    if (low != null && low >= 95) x += 0.6;
    if (gust >= 40) x += 1.5; else if (gust >= 30) x += 0.7;
    total += x;
  }
  return total;
}
export function outlookFeatures(feeds, now = Date.now()) {
  if (!isFresh(feeds.usHubWx, 'usHubWx', now) || !isFresh(feeds.faaAdvisories, 'faaAdvisories', now)) return null;
  const hw = feeds.usHubWx.data;
  const hourStart = Math.floor(now / 3600000) * 3600000;
  const idx = hw.times.findIndex(t => Date.parse(t + ':00Z') === hourStart);
  if (idx < 0) return null;
  let next3 = -Infinity;
  for (let j = idx; j <= idx + 3 && j < hw.times.length; j++) next3 = Math.max(next3, hubStressAt(hw, j));
  const storms = hw.hubs.filter(c => (Number(hw.hourly[c].weather_code?.[idx]) || 0) >= 95);
  // programs started in the current hour and the two before it (as in the backtest)
  const since = hourStart - 2 * 3600000;
  const recent = feeds.faaAdvisories.data.programs.filter(p => Date.parse(p.sent) >= since);
  const d = new Date(now), weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  return { usHubStressNext3: +next3.toFixed(2), usStorms: storms.length, stormHubs: storms, persist: recent.length,
    recentPrograms: recent, todKey: d.getUTCHours() + '-' + (weekend ? 'we' : 'wd') };
}
export function outlook(feeds, now = Date.now()) {
  const f = outlookFeatures(feeds, now);
  if (!f) return null;
  const out = { features: f, model: { fittedAt: model.fittedAt, heldOutAuc: model.heldOut } };
  for (const y of ['y3big', 'y3']) {
    const m = model.models[y], tod = m.todTable[f.todKey] ?? 0;
    const x = { usHubStressNext3: f.usHubStressNext3, usStorms: f.usStorms, persist: f.persist, tod };
    const contrib = Object.fromEntries(m.keys.map((k, i) => [k, m.w[i] * (x[k] - m.mu[i]) / m.sd[i]]));
    const z = m.intercept + Object.values(contrib).reduce((a, b) => a + b, 0);
    const key = y === 'y3big' ? 'p3big' : 'p3';
    out[key] = +(1 / (1 + Math.exp(-z))).toFixed(3);
    if (y === 'y3big') {
      out.contributions = Object.fromEntries(Object.entries(contrib).map(([k, v]) => [k, +v.toFixed(3)]));
      // "typical": same hour and weekday type, with hub weather and recent programs at their averages
      const ti = m.keys.indexOf('tod');
      out.typical = +(1 / (1 + Math.exp(-(m.intercept + m.w[ti] * (tod - m.mu[ti]) / m.sd[ti])))).toFixed(3);
      out.todRate = tod;
    }
  }
  // 'at least one' can never be less likely than 'three or more' (the two models are fitted separately)
  if (out.p3 < out.p3big) out.p3 = out.p3big;
  return out;
}

// ---------------------------------------------------------------- per-airport outlooks
// Chance of a new ground stop or ground delay program at each of 15 US hubs in
// the next 3 hours. Same inputs as scripts/backtest/analyze-airports.mjs.
export function airportOutlooks(feeds, now = Date.now()) {
  if (!isFresh(feeds.usHubWx, 'usHubWx', now) || !isFresh(feeds.faaAdvisories, 'faaAdvisories', now)) return null;
  const hw = feeds.usHubWx.data, M = airportModel.model;
  const hourStart = Math.floor(now / 3600000) * 3600000;
  const idx = hw.times.findIndex(t => Date.parse(t + ':00Z') === hourStart);
  if (idx < 0) return null;
  const progs = feeds.faaAdvisories.data.programs.map(p => ({ ...p, ts: Date.parse(p.sent) }));
  const since3 = hourStart - 2 * 3600000, since24 = hourStart - 23 * 3600000;
  const national = progs.filter(p => p.ts >= since3).length;
  const d = new Date(now), we = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  const sig = z => 1 / (1 + Math.exp(-z));
  const out = {};
  for (const a of airportModel.hubs) {
    if (!hw.hourly[a]) continue;
    let wxNext3 = 0; for (let j = idx; j <= idx + 3 && j < hw.times.length; j++) wxNext3 = Math.max(wxNext3, hubStressAt({ hubs: [a], hourly: hw.hourly }, j));
    const own3 = progs.filter(p => p.airport === a && p.ts >= since3).length;
    const own24 = progs.filter(p => p.airport === a && p.ts >= since24).length;
    const x = { wxNext3, own3, own24, others3: national - own3, tod: M.todTable[`${a}-${d.getUTCHours()}-${we ? 'we' : 'wd'}`] ?? 0 };
    const contrib = Object.fromEntries(M.keys.map((k, i) => [k, M.w[i] * (x[k] - M.mu[i]) / M.sd[i]]));
    out[a] = {
      p: +sig(M.intercept + Object.values(contrib).reduce((s2, c) => s2 + c, 0)).toFixed(3),
      typical: +sig(M.intercept + contrib.tod).toFixed(3), // usual for this hour, other inputs at their averages
      features: { ...x, wxNext3: +wxNext3.toFixed(2), tod: +x.tod.toFixed(4) },
      contributions: Object.fromEntries(Object.entries(contrib).map(([k, c]) => [k, +c.toFixed(3)])),
    };
  }
  return out;
}

export function scoreSnapshot(snap, now = Date.now()) {
  const scores = withSfi(scoreSnapshotRaw(snap, now));
  scores.airports = airportOutlooks(snap.feeds, now);
  scores.scale = scores1to10(scores.outlook);
  return scores;
}
function scoreSnapshotRaw(snap, now) {
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
    traffic: t, weather: w, jet: j, legacySfi: sfi(t, w, j),
    outlook: outlook(f, now),
    faaLoad: isFresh(f.faa, 'faa', now) ? f.faa.data.programLoad : null,
  };
}
// ---------------------------------------------------------------- 1-10 scores (5 = average)
// Each input's percentile among past hours x 10, so 5 is average; the final
// score is their weighted average. Tested in scripts/backtest/analyze.mjs.
function pctOf(q, x) { let lo = 0, eq = 0; for (const v of q) { if (v < x) lo++; else if (v === x) eq++; } return (lo + eq / 2) / q.length; }
export const to10 = (q, x) => Math.min(10, Math.max(1, Math.round(pctOf(q, x) * 10)));
export function scores1to10(outlookObj) {
  const S = model.scale;
  if (!outlookObj || !S) return null;
  const f = outlookObj.features, tod = model.models.y3big.todTable[f.todKey] ?? 0;
  const inputs = {
    tod: { value: tod, score: to10(S.quantiles.tod, tod) },
    persist: { value: f.persist, score: to10(S.quantiles.persist, f.persist) },
    weather: { value: f.usHubStressNext3, score: to10(S.quantiles.usHubStressNext3, f.usHubStressNext3) },
    medians: { tod: S.quantiles.tod[100], persist: S.quantiles.persist[100], weather: S.quantiles.usHubStressNext3[100] },
  };
  const final = S.weights.tod * inputs.tod.score + S.weights.persist * inputs.persist.score + S.weights.usHubStressNext3 * inputs.weather.score;
  return { inputs, weights: S.weights, final: +final.toFixed(1), score: Math.min(10, Math.max(1, Math.round(final))) };
}

// The Sky Friction Index (v2): estimated chance, 0-100, of 3+ new US ground
// stops / ground delay programs in the next 3 hours.
export function withSfi(scores) {
  return { ...scores, sfi: scores.outlook ? Math.round(scores.outlook.p3big * 100) : null };
}
