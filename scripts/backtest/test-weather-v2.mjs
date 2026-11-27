// Experiment (Nov 2026): can richer weather make the score more than "time of
// day"? Tests new weather inputs on top of the live model (time of day +
// recent programs + hub weather next 3 h), on the same two years and the same
// held-out weeks (every third calendar week) as analyze.mjs (SPLIT=weeks).
//
// Usage: node test-weather-v2.mjs faa-2y.json wx-2y.json out.json
// wx-2y.json comes from fetch-weather-2y.mjs (15 hubs + 24-point grid over the
// busiest US airspace, with CAPE = storm energy).
import fs from 'node:fs';

const [faaPath, wxPath, outPath] = process.argv.slice(2);
const faa = JSON.parse(fs.readFileSync(faaPath, 'utf8'));
const wx = JSON.parse(fs.readFileSync(wxPath, 'utf8'));

const NEW_PROGRAM = /GROUND STOP|GROUND DELAY PROGRAM/;
const NOT_NEW = /CNX|CANCEL|PROPOSED|REVIS|EXTEN|COMPRESS|UPDATE|AMEND|MODIF/;
const isUS = fac => { const ap = fac.split('/')[0].trim(); return /^[A-Z0-9]{3}$/.test(ap) || /^K[A-Z]{3}$/.test(ap); };
const t0 = Date.parse(wx.times[0] + ':00Z'), H = wx.times.length;
const hourIndex = ts => Math.floor((ts - t0) / 3600000);
const haveDay = new Set(Object.keys(faa).filter(d => faa[d].length));
const events = new Array(H).fill(0), hubEvents = {};
for (const rows of Object.values(faa)) for (const r of rows) {
  const title = r.title.toUpperCase();
  if (!NEW_PROGRAM.test(title) || NOT_NEW.test(title) || !isUS(r.facility)) continue;
  const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(r.sent); if (!m) continue;
  const h = hourIndex(Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5])); if (h < 0 || h >= H) continue;
  events[h]++; const ap = r.facility.split('/')[0].trim(); hubEvents[ap] = (hubEvents[ap] || 0) + 1;
}
const ahead = (h, n) => { let s = 0; for (let k = h + 1; k <= h + n && k < H; k++) s += events[k]; return s; };
const HUBS = ['JFK', 'LGA', 'EWR', 'BOS', 'ORD', 'ATL', 'DFW', 'DEN', 'SFO', 'SEA', 'MIA', 'IAH', 'PHL', 'CLT', 'LAX'];
const GRID = wx.grid || Object.keys(wx.data).filter(k => k.startsWith('G'));
const v = (c, k, h) => { const x = wx.data[c]?.[k]?.[h]; return x == null ? null : Number(x); };
const nextMax = (f, h, k) => { let m = -Infinity; for (let j = h; j <= h + k && j < H; j++) m = Math.max(m, f(j)); return m; };
const nextSum = (f, h, k) => { let m = 0; for (let j = h; j <= h + k && j < H; j++) m += f(j); return m; };

// the live hub-weather points (identical to netlify/lib/scores.mjs hubStressAt)
function hubPts(c, h) {
  const wc = v(c, 'weather_code', h) || 0, vis = v(c, 'visibility', h), low = v(c, 'cloud_cover_low', h), gust = v(c, 'wind_gusts_10m', h) || 0;
  let x = 0;
  if (wc >= 95) x += 3; else if (wc >= 61 && wc <= 82) x += 0.7; else if (wc >= 71 && wc <= 77) x += 1.5;
  if (vis != null && vis < 1600) x += 2; else if (vis != null && vis < 4800) x += 1;
  if (low != null && low >= 95) x += 0.6;
  if (gust >= 40) x += 1.5; else if (gust >= 30) x += 0.7;
  return x;
}
const hubStress = h => HUBS.reduce((a, c) => a + hubPts(c, h), 0);
// how often each hub gets programs; used to weight hubs by how much they matter
const totalHub = HUBS.reduce((a, c) => a + (hubEvents[c] || 0), 0);
const hubW = Object.fromEntries(HUBS.map(c => [c, 15 * (hubEvents[c] || 0) / totalHub]));
const weightedStress = h => HUBS.reduce((a, c) => a + hubW[c] * hubPts(c, h), 0);
const NY = ['JFK', 'LGA', 'EWR'];
const nyStress = h => NY.reduce((a, c) => a + hubPts(c, h), 0);
const capeHubs = h => HUBS.reduce((a, c) => a + Math.min(3000, v(c, 'cape', h) || 0) / 1000, 0);
const gridStorm = h => GRID.filter(g => (v(g, 'weather_code', h) || 0) >= 95).length;
const gridRain = h => GRID.reduce((a, g) => a + Math.min(5, v(g, 'precipitation', h) || 0), 0);
const gridCape = h => GRID.filter(g => (v(g, 'cape', h) || 0) >= 1000).length;
const snow = h => HUBS.reduce((a, c) => a + Math.min(3, v(c, 'snowfall', h) || 0), 0);

const rows = [];
for (let h = 24; h < H - 13; h++) {
  const t = new Date(t0 + h * 3600000);
  if (![-24, 0, 6].every(o => haveDay.has(new Date(t0 + (h + o) * 3600000).toISOString().slice(0, 10)))) continue;
  let today = 0; for (let k = 0; k < 24; k++) today += events[h - k];
  rows.push({
    h, t: t.toISOString(), hour: t.getUTCHours(), dow: t.getUTCDay(), month: t.getUTCMonth(), week: Math.floor((h / 24 + 4) / 7),
    y: ahead(h, 3) >= 3 ? 1 : 0,
    persist: events[h] + events[h - 1] + events[h - 2], today,
    hubNext3: nextMax(hubStress, h, 3),
    hubNext6: nextMax(hubStress, h, 6),
    hubNext12: nextMax(hubStress, h, 12),
    weightedNext3: nextMax(weightedStress, h, 3),
    nyNext3: nextMax(nyStress, h, 3),
    capeHubsNext6: nextMax(capeHubs, h, 6),
    gridStormNext3: nextMax(gridStorm, h, 3),
    gridStormNext6: nextSum(gridStorm, h, 6),
    gridRainNext3: nextMax(gridRain, h, 3),
    gridCapeNext6: nextMax(gridCape, h, 6),
    snowNext3: nextMax(snow, h, 3),
  });
}
const isTest = r => r.week % 3 === 2;
const test = rows.filter(isTest);
const testWeeks = new Set(test.map(r => r.week));
const train = rows.filter(r => !isTest(r) && !testWeeks.has(Math.floor(((r.h + 24) / 24 + 4) / 7)));

function auc(d0, key) {
  const d = d0.filter(r => Number.isFinite(r[key])), pos = d.filter(r => r.y).length, neg = d.length - pos;
  if (!pos || !neg) return null;
  const all = d.map(r => ({ s: r[key], y: r.y })).sort((a, b) => a.s - b.s);
  let rs = 0; for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j].s === all[i].s) j++; for (let k = i; k < j; k++) if (all[k].y) rs += (i + 1 + j) / 2; i = j; }
  return +((rs - pos * (pos + 1) / 2) / (pos * neg)).toFixed(4);
}
const logloss = (d, key) => +(d.reduce((a, r) => a - (r.y ? Math.log(Math.max(1e-6, r[key])) : Math.log(Math.max(1e-6, 1 - r[key]))), 0) / d.length).toFixed(4);
function fitTod(data) { const n = {}, k = {}, key = r => r.hour + '-' + (r.dow === 0 || r.dow === 6 ? 'we' : 'wd');
  for (const r of data) { n[key(r)] = (n[key(r)] || 0) + 1; k[key(r)] = (k[key(r)] || 0) + r.y; } return r => (k[key(r)] || 0) / (n[key(r)] || 1); }
function fitLogit(keys, data) {
  const mu = {}, sd = {}; for (const k of keys) { const xs = data.map(r => r[k]); mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length; sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1; }
  const X = data.map(r => [1, ...keys.map(k => (r[k] - mu[k]) / sd[k])]), Y = data.map(r => r.y);
  let w = new Array(keys.length + 1).fill(0);
  for (let it = 0; it < 1500; it++) { const g = new Array(w.length).fill(0);
    for (let i = 0; i < X.length; i++) { let z = 0; for (let j = 0; j < w.length; j++) z += X[i][j] * w[j]; const p = 1 / (1 + Math.exp(-z)); for (let j = 0; j < w.length; j++) g[j] += (p - Y[i]) * X[i][j]; }
    w = w.map((wi, i) => wi - 0.5 * g[i] / X.length - (i ? 0.001 * wi : 0)); }
  return { predict: r => 1 / (1 + Math.exp(-[1, ...keys.map(k => (r[k] - mu[k]) / sd[k])].reduce((s, xi, i) => s + xi * w[i], 0))), weights: Object.fromEntries(keys.map((k, i) => [k, +w[i + 1].toFixed(3)])) };
}
const tod = fitTod(train); for (const r of rows) r.tod = tod(r);
// season check: is storm energy just a stand-in for "it's summer"? A month x
// hour rate (fitted on training hours) gives the model the season directly.
{ const n = {}, k = {}, key = r => r.month + '-' + r.hour; for (const r of train) { n[key(r)] = (n[key(r)] || 0) + 1; k[key(r)] = (k[key(r)] || 0) + r.y; }
  for (const r of rows) r.monthHour = (k[key(r)] || 0) / (n[key(r)] || 1); }

const WX = ['hubNext3', 'hubNext6', 'hubNext12', 'weightedNext3', 'nyNext3', 'capeHubsNext6', 'gridStormNext3', 'gridStormNext6', 'gridRainNext3', 'gridCapeNext6', 'snowNext3'];
const BASE = ['tod', 'persist', 'hubNext3'];   // the live model
const sets = {
  live: BASE,
  noWeather: ['tod', 'persist'],
  ...Object.fromEntries(WX.filter(k => k !== 'hubNext3').map(k => ['plus_' + k, [...BASE, k]])),
  plusToday: [...BASE, 'today'],
  season: [...BASE, 'monthHour'],
  season_cape: [...BASE, 'monthHour', 'capeHubsNext6'],
  season_gridCape: [...BASE, 'monthHour', 'gridCapeNext6'],
  season_bothCape: [...BASE, 'monthHour', 'capeHubsNext6', 'gridCapeNext6'],
  bothCape: [...BASE, 'capeHubsNext6', 'gridCapeNext6'],
  allWeather: ['tod', 'persist', ...WX],
  allWeatherToday: ['tod', 'persist', 'today', ...WX],
};
// "Busy hours" (16-02 UTC, roughly noon to 10 pm Eastern) is where the score
// matters most: within them time of day explains much less, so weather has to
// do the work.
const busy = r => r.hour >= 16 || r.hour <= 2;
const res = { generatedAt: new Date().toISOString(), period: { start: rows[0].t, end: rows.at(-1).t }, hours: { train: train.length, test: test.length },
  baseRate: +(test.reduce((a, r) => a + r.y, 0) / test.length).toFixed(3), hubWeights: hubW,
  alone: Object.fromEntries(['tod', 'persist', 'today', ...WX].map(k => [k, { all: auc(test, k), busyHours: auc(test.filter(busy), k) }])), models: {} };
for (const [name, keys] of Object.entries(sets)) {
  const m = fitLogit(keys, train); for (const r of rows) r['m_' + name] = m.predict(r);
  res.models[name] = { aucTest: auc(test, 'm_' + name), aucBusyHours: auc(test.filter(busy), 'm_' + name), logLoss: logloss(test, 'm_' + name), aucTrain: auc(train, 'm_' + name), weights: m.weights };
  console.log(name.padEnd(22), res.models[name].aucTest, res.models[name].aucBusyHours, res.models[name].logLoss);
}
// bootstrap by test week: gain over the live model, all hours and busy hours
const byWeek = {}; for (const r of test) (byWeek[r.week] ||= []).push(r); const wk = Object.keys(byWeek);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const draws = []; for (let b = 0; b < 300; b++) { const s = []; for (let i = 0; i < wk.length; i++) s.push(...byWeek[wk[Math.floor(rnd() * wk.length)]]); draws.push(s); }
for (const name of Object.keys(sets).filter(n => n !== 'live')) for (const [label, f] of [['gain', () => true], ['gainBusy', busy]]) {
  const d = draws.map(s => { const x = s.filter(f); return auc(x, 'm_' + name) - auc(x, 'm_live'); }).sort((a, b) => a - b);
  res.models[name][label] = { median: +d[150].toFixed(4), lo95: +d[7].toFixed(4), hi95: +d[292].toFixed(4) };
}
for (const name of ['season_cape', 'season_gridCape', 'season_bothCape']) for (const [label, f] of [['gainVsSeason', () => true], ['gainVsSeasonBusy', busy]]) {
  const d = draws.map(s => { const x = s.filter(f); return auc(x, 'm_' + name) - auc(x, 'm_season'); }).sort((a, b) => a - b);
  res.models[name][label] = { median: +d[150].toFixed(4), lo95: +d[7].toFixed(4), hi95: +d[292].toFixed(4) };
  console.log(name, label, JSON.stringify(res.models[name][label]));
}
// by season, test hours
const season = r => [11, 0, 1].includes(r.month) ? 'winter' : [2, 3, 4].includes(r.month) ? 'spring' : [5, 6, 7].includes(r.month) ? 'summer' : 'autumn';
res.bySeason = {};
for (const s of ['winter', 'spring', 'summer', 'autumn']) { const d = test.filter(r => season(r) === s); res.bySeason[s] = { hours: d.length, ...Object.fromEntries(['live', 'noWeather', 'season', 'plus_capeHubsNext6', 'season_cape', 'bothCape'].map(n => [n, auc(d, 'm_' + n)])) }; }
fs.writeFileSync(outPath, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ bySeason: res.bySeason, gains: Object.fromEntries(Object.entries(res.models).map(([k, m]) => [k, [m.gain?.median, m.gain?.lo95, m.gain?.hi95, m.gainBusy?.median, m.gainBusy?.lo95, m.gainBusy?.hi95]])) }, null, 1));
