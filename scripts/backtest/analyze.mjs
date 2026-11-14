// Backtest: do the SFI inputs (and simple alternatives) give warning of real US
// disruptions, i.e. new FAA ground stops or ground delay programs in the next
// 3 and 6 hours?
//
// Usage: node analyze.mjs faa-adv.json wx.json results.json
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
// max over the next k hours of a forecastable quantity (weather forecasts exist; GAPS could use them)
const nextMax = (f, h, k) => { let m = -Infinity; for (let j = h; j <= h + k && j < H; j++) m = Math.max(m, f(j)); return m; };

const rows = [];
for (let h = 3; h < H - 6; h++) {
  const t = new Date(t0 + h * 3600000);
  const weather = blend(GAPS8, h), j = jet(h);
  rows.push({
    h, t: t.toISOString(), hour: t.getUTCHours(), dow: t.getUTCDay(),
    y3: ahead(h, 3) > 0 ? 1 : 0, y6: ahead(h, 6) > 0 ? 1 : 0, y3big: ahead(h, 3) >= 3 ? 1 : 0,
    weather, jet: j,
    sfi2: j == null ? null : Math.round((weather * 0.36 + j * 0.22) / 0.58),
    usWeatherNow: blend(US12, h),
    usHubStress: usHubStress(h),
    usHubStressNext3: nextMax(usHubStress, h, 3),
    usStorms: usStorms(h),
    persist: events[h] + events[h - 1] + events[h - 2],
  });
}

// ---------------------------------------------------------------- evaluation
const split = Math.floor(rows.length * 2 / 3);
const train = rows.slice(0, split), test = rows.slice(split);

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

const results = { generatedAt: new Date().toISOString(), period: { start: wx.times[0], end: wx.times[H - 1] }, trainEnd: train[train.length - 1].t, testStart: test[0].t,
  events: { total: eventList.length, groundStops: eventList.filter(e => e.type === 'GS').length, gdps: eventList.filter(e => e.type === 'GDP').length,
    topAirports: Object.entries(eventList.reduce((o, e) => ((o[e.airport] = (o[e.airport] || 0) + 1), o), {})).sort((a, b) => b[1] - a[1]).slice(0, 10) },
  baseRate: Object.fromEntries(['y3', 'y6', 'y3big'].map(y => [y, +(test.reduce((a, r) => a + r[y], 0) / test.length).toFixed(3)])),
  predictors: {} };

const LABELS = {
  weather: 'GAPS Weather input (8 world points)', jet: 'GAPS Upper-Air input (250 hPa wind)', sfi2: 'GAPS index (weather + upper-air)',
  usWeatherNow: 'Same weather formula at 15 US hubs', usHubStress: 'US hub capacity weather now (storms, visibility, low cloud, gusts)',
  usHubStressNext3: 'US hub capacity weather, worst of next 3 h (forecast)', usStorms: 'US hubs with thunderstorms now',
  persist: 'Programs started in the last 3 h (persistence)', tod: 'Time of day and weekday only',
};
for (const y of ['y3', 'y6', 'y3big']) {
  const tod = fitTod(y);
  for (const r of rows) r['tod_' + y] = tod(r);
  const model = fitLogit(['usHubStressNext3', 'usStorms', 'persist', 'tod_' + y], y);
  for (const r of rows) r['model_' + y] = model.predict(r);
  for (const key of [...Object.keys(LABELS).filter(k => k !== 'tod'), 'tod_' + y, 'model_' + y]) {
    const name = key.startsWith('tod_') ? 'tod' : key.startsWith('model_') ? 'model' : key;
    results.predictors[name] ||= { label: name === 'model' ? 'Combined model (US hub weather forecast + storms + persistence + time of day)' : LABELS[name] };
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
// Production model: same features, refitted on the whole period (the scores above
// come from the version that never saw the test weeks).
const production = {};
for (const y of ['y3big', 'y3']) {
  const todAll = fitTod(y, rows);
  for (const r of rows) r['todall_' + y] = todAll(r);
  const m = fitLogit(['usHubStressNext3', 'usStorms', 'persist', 'todall_' + y], y, rows);
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
    keys: ['usHubStressNext3', 'usStorms', 'persist', 'tod'], todTable: todAll.table };
}
const usHubs = US12;
fs.writeFileSync(outPath.replace(/backtest-results\.json$/, 'sfi-model.json'), JSON.stringify({
  version: 1, fittedAt: results.generatedAt, period: results.period, usHubs,
  target: { y3big: '3 or more new US ground stops / ground delay programs in the next 3 hours', y3: 'at least one new US ground stop or ground delay program in the next 3 hours' },
  models: production,
  heldOut: { y3big: { auc: results.predictors.model.y3big.aucTest, baseRate: results.baseRate.y3big }, y3: { auc: results.predictors.model.y3.aucTest, baseRate: results.baseRate.y3 } },
}, null, 1));
fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
console.log(JSON.stringify({ events: results.events, baseRate: results.baseRate, testStart: results.testStart }, null, 1));
console.log('predictor'.padEnd(20), 'AUC 3h', 'AUC 6h', 'AUC 3+in3h', ' hit/false (3+in3h)');
for (const [k, p] of Object.entries(results.predictors)) console.log(k.padEnd(20), String(p.y3.aucTest).padEnd(6), String(p.y6.aucTest).padEnd(6), String(p.y3big.aucTest).padEnd(10), p.y3big.hitRate, '/', p.y3big.falseAlarmRate);
console.log('model weights 3h', results.predictors.model.y3.weights, '3+in3h', results.predictors.model.y3big.weights);
