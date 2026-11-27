// Backtest: do the SFI inputs (and simple alternatives) give warning of real US
// disruptions, i.e. new FAA ground stops or ground delay programs in the next
// 3 and 6 hours?
//
// Usage: node analyze.mjs faa-adv.json wx.json results.json
// SPLIT=weeks: hold out every third calendar week (tests cover all seasons;
// the 24 h before each test week are left out of training). Default: the
// first 2/3 of the period trains, the last 1/3 tests.
//
// Honest-test rules:
//  - Every predictor uses only information available at hour h.
//  - The first 2/3 of the period is used to fit anything that needs fitting
//    (time-of-day baseline, logistic model, thresholds). Scores are reported
//    on the last 1/3, which the fitting never saw.
//  - Traffic cannot be backtested: no free historical aircraft counts exist.
import fs from 'node:fs';

const [faaPath, wxPath, outPath] = process.argv.slice(2);
const faa = JSON.parse(fs.readFileSync(faaPath, 'utf8'));
const wx = JSON.parse(fs.readFileSync(wxPath, 'utf8'));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

// ---------------------------------------------------------------- events
const NEW_PROGRAM = /GROUND STOP|GROUND DELAY PROGRAM/;
const NOT_NEW = /CNX|CANCEL|PROPOSED|REVIS|EXTEN|COMPRESS|UPDATE|AMEND|MODIF/;
const isUS = fac => { const ap = fac.split('/')[0].trim(); return /^[A-Z0-9]{3}$/.test(ap) || /^K[A-Z]{3}$/.test(ap); };
const t0 = Date.parse(wx.times[0] + ':00Z');
const H = wx.times.length;
// Days the FAA archive returns empty are archive gaps, not calm days: hours that
// touch them are left out.
const haveDay = new Set(Object.keys(faa).filter(d => faa[d].length));
const SPLIT = process.env.SPLIT || 'chrono';
const hasWorld = ['LHR', 'SIN', 'DXB', 'SCL', 'NRT'].every(c => wx.data[c]);
const hourIndex = ts => Math.floor((ts - t0) / 3600000);
const events = new Array(H).fill(0), gsEvents = new Array(H).fill(0);
const eventList = [];
for (const rows of Object.values(faa)) {
  for (const r of rows) {
    const title = r.title.toUpperCase();
    if (!NEW_PROGRAM.test(title) || NOT_NEW.test(title) || !isUS(r.facility)) continue;
    const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(r.sent); if (!m) continue;
    const ts = Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5]);
    const h = hourIndex(ts); if (h < 0 || h >= H) continue;
    events[h]++; if (/GROUND STOP/.test(title)) gsEvents[h]++;
    eventList.push({ t: new Date(ts).toISOString(), airport: r.facility.split('/')[0], type: /GROUND STOP/.test(title) ? 'GS' : 'GDP' });
  }
}
const ahead = (h, n) => { let s = 0; for (let k = h + 1; k <= h + n && k < H; k++) s += events[k]; return s; };

// ---------------------------------------------------------------- predictors
const GAPS8 = ['JFK', 'LHR', 'ORD', 'LAX', 'SIN', 'DXB', 'SCL', 'NRT'];
const US12 = ['JFK', 'LGA', 'EWR', 'BOS', 'ORD', 'ATL', 'DFW', 'DEN', 'SFO', 'SEA', 'MIA', 'IAH', 'PHL', 'CLT', 'LAX'];
const v = (code, key, h) => { const x = wx.data[code]?.[key]?.[h]; return x == null ? null : Number(x); };
// GAPS weather formula (Open-Meteo part), exactly as on the site
function pointScore(code, h) {
  const wcode = v(code, 'weather_code', h) || 0;
  const convective = [95, 96, 99].includes(wcode) ? 35 : (wcode >= 61 && wcode <= 82 ? 18 : 0);
  return clamp(25 + (v(code, 'wind_speed_10m', h) || 0) * 0.55 + (v(code, 'wind_gusts_10m', h) || 0) * 0.75 + (v(code, 'precipitation', h) || 0) * 12 + convective, 15, 95);
}
function blend(codes, h) { const s = codes.map(c => pointScore(c, h)); return Math.round(Math.max(...s) * 0.6 + (s.reduce((a, b) => a + b, 0) / s.length) * 0.4); }
function jet(h) {
  const w = GAPS8.map(c => v(c, 'wind_speed_250hPa', h)).filter(Number.isFinite);
  if (!w.length) return null;
  return Math.round(clamp(28 + Math.max(...w) * 0.42 + (w.reduce((a, b) => a + b, 0) / w.length) * 0.16, 25, 92));
}
// US airport capacity weather: storms, low visibility/cloud, strong wind at the hubs
function usHubStress(h) {
  let total = 0;
  for (const c of US12) {
    const wc = v(c, 'weather_code', h) || 0, vis = v(c, 'visibility', h), low = v(c, 'cloud_cover_low', h), gust = v(c, 'wind_gusts_10m', h) || 0;
    let s = 0;
    if (wc >= 95) s += 3; else if (wc >= 61 && wc <= 82) s += 0.7; else if (wc >= 71 && wc <= 77) s += 1.5;
    if (vis != null && vis < 1600) s += 2; else if (vis != null && vis < 4800) s += 1;
    if (low != null && low >= 95) s += 0.6; // overcast low cloud (a rough stand-in for low ceilings)
    if (gust >= 40) s += 1.5; else if (gust >= 30) s += 0.7;
    total += s;
  }
  return total;
}
const usStorms = h => US12.filter(c => (v(c, 'weather_code', h) || 0) >= 95).length;
// Storm energy (CAPE): how ready the air is to build thunderstorms, summed over
// the 15 hubs in thousands of J/kg (each hub capped at 3000). Tested in
// test-weather-v2.mjs: it adds warning on top of the season.
const hasCape = US12.every(c => wx.data[c]?.cape);
const stormEnergy = h => US12.reduce((a, c) => a + Math.min(3000, v(c, 'cape', h) || 0) / 1000, 0);
// max over the next k hours of a forecastable quantity (weather forecasts exist; GAPS could use them)
const nextMax = (f, h, k) => { let m = -Infinity; for (let j = h; j <= h + k && j < H; j++) m = Math.max(m, f(j)); return m; };

const rows = [];
for (let h = 3; h < H - 6; h++) {
  const t = new Date(t0 + h * 3600000);
  if (![-3, 0, 6].every(o => haveDay.has(new Date(t0 + (h + o) * 3600000).toISOString().slice(0, 10)))) continue;
  const weather = blend(GAPS8, h), j = jet(h);
  rows.push({
    h, t: t.toISOString(), hour: t.getUTCHours(), dow: t.getUTCDay(), month: t.getUTCMonth(),
    y3: ahead(h, 3) > 0 ? 1 : 0, y6: ahead(h, 6) > 0 ? 1 : 0, y3big: ahead(h, 3) >= 3 ? 1 : 0,
    weather, jet: j,
    sfi2: j == null ? null : Math.round((weather * 0.36 + j * 0.22) / 0.58),
    usWeatherNow: blend(US12, h),
    usHubStress: usHubStress(h),
    usHubStressNext3: nextMax(usHubStress, h, 3),
    usStorms: usStorms(h),
    capeNext6: hasCape ? +nextMax(stormEnergy, h, 6).toFixed(3) : 0,
    persist: events[h] + events[h - 1] + events[h - 2],
  });
}

// ---------------------------------------------------------------- evaluation
const weekOf = h => Math.floor((h / 24 + 4) / 7);
let train, test;
if (SPLIT === 'weeks') {
  const isTestH = h => weekOf(h) % 3 === 2;
  test = rows.filter(r => isTestH(r.h));
  train = rows.filter(r => !isTestH(r.h) && !isTestH(r.h + 24));
} else { const split = Math.floor(rows.length * 2 / 3); train = rows.slice(0, split); test = rows.slice(split); }

function auc(data, key, y) {
  const d = data.filter(r => Number.isFinite(r[key]));
  const pos = d.filter(r => r[y]), neg = d.filter(r => !r[y]);
  if (!pos.length || !neg.length) return null;
  // rank-based AUC with tie handling
  const all = d.map(r => ({ s: r[key], y: r[y] })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i; while (j < all.length && all[j].s === all[i].s) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k].y) rankSum += avgRank;
    i = j;
  }
  return +((rankSum - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length)).toFixed(3);
}
// time-of-day x weekday baseline, fitted on the training period
function fitTod(y, data = train) {
  const n = {}, k = {};
  for (const r of data) { const key = r.hour + '-' + (r.dow === 0 || r.dow === 6 ? 'we' : 'wd'); n[key] = (n[key] || 0) + 1; k[key] = (k[key] || 0) + r[y]; }
  const f = r => { const key = r.hour + '-' + (r.dow === 0 || r.dow === 6 ? 'we' : 'wd'); return (k[key] || 0) / (n[key] || 1); };
  f.table = Object.fromEntries(Object.keys(n).map(key => [key, +((k[key] || 0) / n[key]).toFixed(4)]));
  return f;
}
// season: how often a bad stretch followed this hour in this calendar month
function fitSeason(y, data = train) {
  const n = {}, k = {}, key = r => r.month + '-' + r.hour;
  for (const r of data) { n[key(r)] = (n[key(r)] || 0) + 1; k[key(r)] = (k[key(r)] || 0) + r[y]; }
  const f = r => (k[key(r)] || 0) / (n[key(r)] || 1);
  f.table = Object.fromEntries(Object.keys(n).map(key2 => [key2, +((k[key2] || 0) / n[key2]).toFixed(4)]));
  return f;
}
const MODEL_KEYS = hasCape ? ['usHubStressNext3', 'capeNext6', 'persist', 'tod', 'season'] : ['usHubStressNext3', 'persist', 'tod'];
// each 1-10 input is one part of the model's own sum (its contribution)
const contrib = (p, r, keys) => keys.reduce((a, k) => { const i = p.keys.indexOf(k); return i < 0 ? a : a + p.w[i] * (r[k] - p.mu[i]) / p.sd[i]; }, 0);
const PARTS = { time: ['tod', 'season'], weather: ['usHubStressNext3', 'capeNext6'] };
// small logistic regression (standardised inputs, gradient descent)
function fitLogit(keys, y, data = train) {
  const train = data;
  const mu = {}, sd = {};
  for (const k of keys) { const xs = train.map(r => r[k]); mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length; sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1; }
  let w = new Array(keys.length + 1).fill(0);
  for (let it = 0; it < 3000; it++) {
    const g = new Array(w.length).fill(0);
    for (const r of train) {
      const x = [1, ...keys.map(k => (r[k] - mu[k]) / sd[k])];
      const p = 1 / (1 + Math.exp(-x.reduce((s, xi, i) => s + xi * w[i], 0)));
      x.forEach((xi, i) => { g[i] += (p - r[y]) * xi; });
    }
    w = w.map((wi, i) => wi - 0.5 * g[i] / train.length - (i ? 0.001 * wi : 0));
  }
  const predict = r => 1 / (1 + Math.exp(-[1, ...keys.map(k => (r[k] - mu[k]) / sd[k])].reduce((s, xi, i) => s + xi * w[i], 0)));
  return { predict, weights: Object.fromEntries(keys.map((k, i) => [k, +w[i + 1].toFixed(3)])), params: { keys, intercept: w[0], w: w.slice(1), mu: keys.map(k => mu[k]), sd: keys.map(k => sd[k]) } };
}
// hit rate / false alarm rate at the threshold that flags the top 25% of training hours
function hitFalse(key, y) {
  const s = train.map(r => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
  const thr = s[Math.floor(s.length * 0.75)];
  // if the threshold equals the smallest value (a predictor that is zero most of the time), flag only values above it
  const flag = x => thr === s[0] ? x > thr : x >= thr;
  const d = test.filter(r => Number.isFinite(r[key]));
  const pos = d.filter(r => r[y]), neg = d.filter(r => !r[y]);
  return { threshold: +(+thr).toFixed(3), hitRate: +(pos.filter(r => flag(r[key])).length / pos.length).toFixed(3), falseAlarmRate: +(neg.filter(r => flag(r[key])).length / neg.length).toFixed(3) };
}

const results = { generatedAt: new Date().toISOString(), period: { start: wx.times[0], end: wx.times[H - 1] }, split: SPLIT === 'weeks' ? 'every third week held out' : 'last third held out', hours: { train: train.length, test: test.length }, trainEnd: train[train.length - 1].t, testStart: test[0].t,
  events: { total: eventList.length, groundStops: eventList.filter(e => e.type === 'GS').length, gdps: eventList.filter(e => e.type === 'GDP').length,
    topAirports: Object.entries(eventList.reduce((o, e) => ((o[e.airport] = (o[e.airport] || 0) + 1), o), {})).sort((a, b) => b[1] - a[1]).slice(0, 10) },
  baseRate: Object.fromEntries(['y3', 'y6', 'y3big'].map(y => [y, +(test.reduce((a, r) => a + r[y], 0) / test.length).toFixed(3)])),
  predictors: {} };

const LABELS = {
  weather: 'GAPS Weather input (8 world points)', jet: 'GAPS Upper-Air input (250 hPa wind)', sfi2: 'GAPS index (weather + upper-air)',
  usWeatherNow: 'Same weather formula at 15 US hubs', usHubStress: 'US hub capacity weather now (storms, visibility, low cloud, gusts)',
  usHubStressNext3: 'US hub capacity weather, worst of next 3 h (forecast)', usStorms: 'US hubs with thunderstorms now',
  persist: 'Programs started in the last 3 h (persistence)', tod: 'Time of day and weekday only',
  capeNext6: 'Storm energy (CAPE) at 15 US hubs, peak of next 6 h (forecast)', season: 'Time of day and month (season) only',
};
const fitted = {};
for (const y of ['y3', 'y6', 'y3big']) {
  const tod = fitTod(y), season = fitSeason(y);
  for (const r of rows) { r['tod_' + y] = tod(r); r['season_' + y] = season(r); r.tod = r['tod_' + y]; r.season = r['season_' + y]; }
  // usStorms is not a model input: storms at a hub were in the forecast for only a
  // handful of training hours, so its weight could not be estimated reliably (one
  // storm would push the chance to ~100%). Storms still count inside usHubStress.
  const model = fitLogit(MODEL_KEYS, y);
  fitted[y] = model.params;
  for (const r of rows) r['model_' + y] = model.predict(r);
  if (y === 'y3big') for (const r of rows) { r.part_time = contrib(model.params, r, PARTS.time); r.part_weather = contrib(model.params, r, PARTS.weather); }
  for (const key of [...Object.keys(LABELS).filter(k => !['tod', 'season'].includes(k) && (hasWorld || !['weather', 'jet', 'sfi2'].includes(k)) && (hasCape || k !== 'capeNext6')), 'tod_' + y, 'season_' + y, 'model_' + y]) {
    const name = key.startsWith('tod_') ? 'tod' : key.startsWith('season_') ? 'season' : key.startsWith('model_') ? 'model' : key;
    results.predictors[name] ||= { label: name === 'model' ? 'Combined model (time of day, season, recent programs, US hub weather and storm energy)' : LABELS[name] };
    results.predictors[name][y] = { aucTest: auc(test, key, y), aucTrain: auc(train, key, y), ...hitFalse(key, y) };
  }
  results.predictors.model[y].weights = model.weights;
}
// daily series for the chart: events per day vs daily mean of index and US hub stress
const days = {};
for (const r of rows) {
  const d = r.t.slice(0, 10); days[d] ||= { d, sfi2: [], usHubStress: [], events: 0 };
  if (Number.isFinite(r.sfi2)) days[d].sfi2.push(r.sfi2); days[d].usHubStress.push(r.usHubStress);
}
for (const e of eventList) { const d = e.t.slice(0, 10); if (days[d]) days[d].events++; }
const mean = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null;
results.daily = Object.values(days).map(x => ({ d: x.d, events: x.events, sfi2: mean(x.sfi2), usHubStress: mean(x.usHubStress) }));
// Calibration on the held-out period: does "30%" really mean 30%?
for (const y of ['y3big', 'y3']) {
  const buckets = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 1.01]];
  results.predictors.model[y].calibration = buckets.map(([a, b]) => {
    const d = test.filter(r => r['model_' + y] >= a && r['model_' + y] < b);
    return { from: a, to: Math.min(b, 1), hours: d.length, predicted: d.length ? +(d.reduce((s2, r) => s2 + r['model_' + y], 0) / d.length).toFixed(3) : null, observed: d.length ? +(d.reduce((s2, r) => s2 + r[y], 0) / d.length).toFixed(3) : null };
  });
}
// ---- The 1-10 score shown on the site: each input becomes a score where 5 is
// average (its percentile among past hours x 10), and the final score is the
// weighted average of the three. Tested on the same held-out weeks.
// The 'time' input is the model's time-of-day + season part, the 'weather'
// input its hub-weather + storm-energy part.
const SCALE_KEYS = { usHubStressNext3: 'part_weather', persist: 'persist', tod: 'part_time' };
const SCALE_W = { tod: 0.50, persist: 0.35, usHubStressNext3: 0.15 };
const quantiles = (data, key) => { const v = data.map(r => r[key]).filter(Number.isFinite).sort((a2, b2) => a2 - b2); return Array.from({ length: 201 }, (_, i) => +v[Math.min(v.length - 1, Math.round(i / 200 * (v.length - 1)))].toFixed(4)); };
const pctOf = (q, x) => { let lo = 0, eq = 0; for (const v of q) { if (v < x) lo++; else if (v === x) eq++; } return (lo + eq / 2) / q.length; };
const to10 = (q, x) => Math.min(10, Math.max(1, Math.round(pctOf(q, x) * 10)));
const qTrain = Object.fromEntries(Object.entries(SCALE_KEYS).map(([k, col]) => [k, quantiles(train, col)]));
const finalOf = (r, Q, todCol) => SCALE_W.tod * to10(Q.tod, r[todCol]) + SCALE_W.persist * to10(Q.persist, r.persist) + SCALE_W.usHubStressNext3 * to10(Q.usHubStressNext3, r.part_weather);
const meaning = {};
for (const r of test) { const f = Math.min(10, Math.max(1, Math.round(finalOf(r, qTrain, 'part_time')))); meaning[f] = meaning[f] || { hours: 0, rough: 0 }; meaning[f].hours++; meaning[f].rough += r.y3big; }
results.score1to10 = {
  aucTest: auc(test.map(r => ({ ...r, s10: finalOf(r, qTrain, 'part_time') })), 's10', 'y3big'),
  meaning: Object.entries(meaning).map(([score, m]) => ({ score: +score, hours: m.hours, roughRate: +(m.rough / m.hours).toFixed(3) })).sort((a2, b2) => a2.score - b2.score),
  weights: SCALE_W,
};
console.log('1-10 score AUC (test):', results.score1to10.aucTest, JSON.stringify(results.score1to10.meaning));
// Production model: same features, refitted on the whole period (the scores above
// come from the version that never saw the test weeks).
const production = {};
for (const y of ['y3big', 'y3']) {
  const todAll = fitTod(y, rows), seasonAll = fitSeason(y, rows);
  for (const r of rows) { r.tod = todAll(r); r.season = seasonAll(r); }
  const m = fitLogit(MODEL_KEYS, y, rows);
  // Re-centre on the most recent 30 days so the percentages match the current
  // season (the summer storm season inflates them otherwise). Shift the
  // intercept until the average prediction equals the observed rate.
  const recent = rows.slice(-30 * 24);
  const observed = recent.reduce((a, r) => a + r[y], 0) / recent.length;
  const p = m.params, z = r => p.intercept + p.keys.map((k, i) => p.w[i] * (r[k] - p.mu[i]) / p.sd[i]).reduce((a, b) => a + b, 0);
  let lo = -5, hi = 5;
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; const mean = recent.reduce((a, r) => a + 1 / (1 + Math.exp(-(z(r) + mid))), 0) / recent.length; if (mean > observed) hi = mid; else lo = mid; }
  const shift = (lo + hi) / 2;
  production[y] = { ...p, intercept: p.intercept + shift, recentring: { days: 30, observedRate: +observed.toFixed(3), interceptShift: +shift.toFixed(3) },
    keys: MODEL_KEYS, todTable: todAll.table, ...(MODEL_KEYS.includes('season') ? { seasonTable: seasonAll.table } : {}) };
  if (y === 'y3big') for (const r of rows) { r.prod_time = contrib(production[y], r, PARTS.time); r.prod_weather = contrib(production[y], r, PARTS.weather); }
}
const usHubs = US12;
// Typical values of the inputs over the whole period, so the dashboard can say
// whether a reading is normal (median), above normal (top 25%) or elevated (top 10%).
const q = (arr, f) => { const v = arr.filter(Number.isFinite).sort((x, y) => x - y); return +v[Math.min(v.length - 1, Math.floor(v.length * f))].toFixed(2); };
const stats = Object.fromEntries(['usHubStressNext3', 'persist', ...(hasCape ? ['capeNext6'] : [])].map(k => { const v = rows.map(r => r[k]); return [k, { mean: +(v.reduce((a2, b2) => a2 + b2, 0) / v.length).toFixed(2), p50: q(v, 0.5), p75: q(v, 0.75), p90: q(v, 0.9) }]; }));
// 1-10 scale: percentiles of each input among all hours. 'tod' and
// 'usHubStressNext3' hold the model's time and weather parts (see SCALE_KEYS);
// 'parts' tells the live site which model inputs make up each one.
const scale = { weights: SCALE_W, parts: PARTS, quantiles: { usHubStressNext3: quantiles(rows, 'prod_weather'), persist: quantiles(rows, 'persist'), tod: quantiles(rows, 'prod_time') } };
fs.writeFileSync(outPath.replace(/backtest-results\.json$/, 'sfi-model.json'), JSON.stringify({
  version: 1, fittedAt: results.generatedAt, period: results.period, usHubs, stats, scale,
  target: { y3big: '3 or more new US ground stops / ground delay programs in the next 3 hours', y3: 'at least one new US ground stop or ground delay program in the next 3 hours' },
  models: production,
  heldOut: { y3big: { auc: results.predictors.model.y3big.aucTest, baseRate: results.baseRate.y3big }, y3: { auc: results.predictors.model.y3.aucTest, baseRate: results.baseRate.y3 } },
}, null, 1));
fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
console.log(JSON.stringify({ events: results.events, baseRate: results.baseRate, testStart: results.testStart }, null, 1));
console.log('predictor'.padEnd(20), 'AUC 3h', 'AUC 6h', 'AUC 3+in3h', ' hit/false (3+in3h)');
for (const [k, p] of Object.entries(results.predictors)) console.log(k.padEnd(20), String(p.y3.aucTest).padEnd(6), String(p.y6.aucTest).padEnd(6), String(p.y3big.aucTest).padEnd(10), p.y3big.hitRate, '/', p.y3big.falseAlarmRate);
console.log('model weights 3h', results.predictors.model.y3.weights, '3+in3h', results.predictors.model.y3big.weights);
