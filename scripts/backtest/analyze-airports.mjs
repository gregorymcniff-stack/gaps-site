// Per-airport backtest: will the FAA start a ground stop or ground delay
// program at THIS airport in the next 3 hours?
//
// Usage: node analyze-airports.mjs faa-adv.json wx.json ../../public/data
// Writes airport-model.json (used live) and airport-backtest.json (results).
//
// Same honest-test rules as analyze.mjs: fit on the first 2/3 of the period,
// score on the last 1/3. One pooled model for all 15 hubs (more data per
// weight), with each airport's own time-of-day rate as an input.
import fs from 'node:fs';

const [faaPath, wxPath, outDir] = process.argv.slice(2);
const faa = JSON.parse(fs.readFileSync(faaPath, 'utf8'));
const wx = JSON.parse(fs.readFileSync(wxPath, 'utf8'));
const HUBS = ['JFK', 'LGA', 'EWR', 'BOS', 'PHL', 'ATL', 'CLT', 'MIA', 'ORD', 'DFW', 'IAH', 'DEN', 'SFO', 'SEA', 'LAX'];
const t0 = Date.parse(wx.times[0] + ':00Z'), H = wx.times.length;

// ---- events by airport and hour (new US ground stops / ground delay programs)
const NEW_PROGRAM = /GROUND STOP|GROUND DELAY PROGRAM/, NOT_NEW = /CNX|CANCEL|PROPOSED|REVIS|EXTEN|COMPRESS|UPDATE|AMEND|MODIF/;
const isUS = fac => { const ap = fac.split('/')[0].trim(); return /^[A-Z0-9]{3}$/.test(ap) || /^K[A-Z]{3}$/.test(ap); };
const ev = Object.fromEntries(HUBS.map(a => [a, new Array(H).fill(0)]));
const allUS = new Array(H).fill(0);
for (const rows of Object.values(faa)) for (const r of rows) {
  const title = r.title.toUpperCase();
  if (!NEW_PROGRAM.test(title) || NOT_NEW.test(title) || !isUS(r.facility)) continue;
  const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(r.sent); if (!m) continue;
  const h = Math.floor((Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5]) - t0) / 3600000);
  if (h < 0 || h >= H) continue;
  allUS[h]++;
  const ap = r.facility.split('/')[0].trim();
  if (ev[ap]) ev[ap][h]++;
}
const sum = (arr, a, b) => { let s = 0; for (let k = Math.max(0, a); k <= b && k < H; k++) s += arr[k]; return s; };

// ---- hub weather points (same scoring as the live site)
const v = (c, k, h) => { const x = wx.data[c]?.[k]?.[h]; return x == null ? null : Number(x); };
function points(c, h) {
  const wc = v(c, 'weather_code', h) || 0, vis = v(c, 'visibility', h), low = v(c, 'cloud_cover_low', h), gust = v(c, 'wind_gusts_10m', h) || 0;
  let x = 0;
  if (wc >= 95) x += 3; else if (wc >= 61 && wc <= 82) x += 0.7; else if (wc >= 71 && wc <= 77) x += 1.5;
  if (vis != null && vis < 1600) x += 2; else if (vis != null && vis < 4800) x += 1;
  if (low != null && low >= 95) x += 0.6;
  if (gust >= 40) x += 1.5; else if (gust >= 30) x += 0.7;
  return x;
}

// ---- one row per airport-hour
const rows = [];
for (let h = 24; h < H - 3; h++) {
  const t = new Date(t0 + h * 3600000), hour = t.getUTCHours(), we = t.getUTCDay() === 0 || t.getUTCDay() === 6;
  const national = sum(allUS, h - 2, h);
  for (const a of HUBS) {
    let wxNext3 = 0; for (let j = h; j <= h + 3 && j < H; j++) wxNext3 = Math.max(wxNext3, points(a, j));
    const own3 = sum(ev[a], h - 2, h);
    rows.push({ h, a, hour, we, t: t.toISOString(),
      y: sum(ev[a], h + 1, h + 3) > 0 ? 1 : 0,
      wxNext3, own3, own24: sum(ev[a], h - 23, h), others3: national - own3 });
  }
}
const cut = Math.floor((H - 27) * 2 / 3) + 24;
const train = rows.filter(r => r.h < cut), test = rows.filter(r => r.h >= cut);

// ---- helpers
function fitTod(data) {
  const n = {}, k = {};
  for (const r of data) { const key = `${r.a}-${r.hour}-${r.we ? 'we' : 'wd'}`; n[key] = (n[key] || 0) + 1; k[key] = (k[key] || 0) + r.y; }
  const table = Object.fromEntries(Object.keys(n).map(key => [key, +((k[key] || 0) / n[key]).toFixed(4)]));
  return { table, f: r => table[`${r.a}-${r.hour}-${r.we ? 'we' : 'wd'}`] ?? 0 };
}
function fitLogit(keys, data) {
  const mu = {}, sd = {};
  for (const k of keys) { const xs = data.map(r => r[k]); mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length; sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1; }
  let w = new Array(keys.length + 1).fill(0);
  const X = data.map(r => [1, ...keys.map(k => (r[k] - mu[k]) / sd[k])]), Y = data.map(r => r.y);
  for (let it = 0; it < 1500; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < X.length; i++) { const z = X[i].reduce((s, x, j) => s + x * w[j], 0), p = 1 / (1 + Math.exp(-z)); for (let j = 0; j < w.length; j++) g[j] += (p - Y[i]) * X[i][j]; }
    w = w.map((wj, j) => wj - 0.8 * g[j] / X.length - (j ? 0.001 * wj : 0));
  }
  const predict = r => 1 / (1 + Math.exp(-(w[0] + keys.reduce((s, k, j) => s + w[j + 1] * (r[k] - mu[k]) / sd[k], 0))));
  return { predict, params: { keys, intercept: w[0], w: w.slice(1), mu: keys.map(k => mu[k]), sd: keys.map(k => sd[k]) } };
}
function auc(data, score) {
  const d = data.map(r => ({ s: score(r), y: r.y })).sort((a, b) => a.s - b.s);
  const pos = d.filter(x => x.y).length, neg = d.length - pos; if (!pos || !neg) return null;
  let rank = 0;
  for (let i = 0; i < d.length;) { let j = i; while (j < d.length && d[j].s === d[i].s) j++; const r = (i + 1 + j) / 2; for (let k = i; k < j; k++) if (d[k].y) rank += r; i = j; }
  return +((rank - pos * (pos + 1) / 2) / (pos * neg)).toFixed(3);
}

// ---- fit on train, score on test
const tod = fitTod(train);
for (const r of rows) r.tod = tod.f(r);
const KEYS = ['wxNext3', 'own3', 'own24', 'others3', 'tod'];
const model = fitLogit(KEYS, train);
const predictors = {
  model: { label: 'Per-airport model (all inputs)', f: model.predict },
  tod: { label: "Airport's usual rate at this hour", f: r => r.tod },
  own3: { label: 'Programs at this airport, last 3 h', f: r => r.own3 },
  own24: { label: 'Programs at this airport, last 24 h', f: r => r.own24 },
  wxNext3: { label: "This airport's weather, next 3 h", f: r => r.wxNext3 },
  others3: { label: 'Programs at other airports, last 3 h', f: r => r.others3 },
};
const results = { generatedAt: new Date().toISOString(), period: { start: wx.times[0], end: wx.times[H - 1] }, testStart: test[0].t,
  target: 'new ground stop or ground delay program at the airport in the next 3 hours', hubs: HUBS,
  baseRate: +(test.reduce((a, r) => a + r.y, 0) / test.length).toFixed(3), pooled: {}, byAirport: {} };
for (const [k, p] of Object.entries(predictors)) results.pooled[k] = { label: p.label, aucTest: auc(test, p.f), aucTrain: auc(train, p.f) };
for (const a of HUBS) {
  const d = test.filter(r => r.a === a);
  results.byAirport[a] = { baseRate: +(d.reduce((s, r) => s + r.y, 0) / d.length).toFixed(3), aucModel: auc(d, model.predict), aucTod: auc(d, r => r.tod), eventsTest: d.reduce((s, r) => s + r.y, 0) };
}
const buckets = [[0, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 1.01]];
results.calibration = buckets.map(([lo, hi]) => { const d = test.filter(r => { const p = model.predict(r); return p >= lo && p < hi; });
  return { from: lo, to: Math.min(hi, 1), hours: d.length, predicted: d.length ? +(d.reduce((s, r) => s + model.predict(r), 0) / d.length).toFixed(3) : null, observed: d.length ? +(d.reduce((s, r) => s + r.y, 0) / d.length).toFixed(3) : null }; });
results.weightsTrain = Object.fromEntries(KEYS.map((k, i) => [k, +model.params.w[i].toFixed(3)]));

// ---- production model: refit on the whole period, re-centre on the last 30 days
const todAll = fitTod(rows);
for (const r of rows) r.tod = todAll.f(r);
const prod = fitLogit(KEYS, rows);
const recent = rows.filter(r => r.h >= H - 3 - 30 * 24);
const observed = recent.reduce((a, r) => a + r.y, 0) / recent.length;
const P = prod.params, z = r => P.intercept + P.keys.reduce((s, k, i) => s + P.w[i] * (r[k] - P.mu[i]) / P.sd[i], 0);
let lo = -5, hi = 5;
for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; const mean = recent.reduce((a, r) => a + 1 / (1 + Math.exp(-(z(r) + mid))), 0) / recent.length; if (mean > observed) hi = mid; else lo = mid; }
const shift = (lo + hi) / 2;
fs.writeFileSync(`${outDir}/airport-model.json`, JSON.stringify({ version: 1, fittedAt: results.generatedAt, period: results.period, hubs: HUBS, target: results.target,
  model: { ...P, intercept: P.intercept + shift, todTable: todAll.table, recentring: { days: 30, observedRate: +observed.toFixed(3), interceptShift: +shift.toFixed(3) } },
  heldOut: { auc: results.pooled.model.aucTest, baseRate: results.baseRate } }, null, 1));
fs.writeFileSync(`${outDir}/airport-backtest.json`, JSON.stringify(results, null, 1));

console.log('base rate (test):', results.baseRate, ' test from', results.testStart);
for (const [k, p] of Object.entries(results.pooled)) console.log(k.padEnd(10), 'AUC test', p.aucTest, ' train', p.aucTrain, ' ', p.label);
console.log('weights (train):', results.weightsTrain);
console.log('by airport (test): ' + HUBS.map(a => `${a} ${results.byAirport[a].aucModel} (tod ${results.byAirport[a].aucTod}, rate ${results.byAirport[a].baseRate})`).join(' | '));
console.log('calibration:', JSON.stringify(results.calibration));
