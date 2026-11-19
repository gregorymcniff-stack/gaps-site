// Two-year test: FAA advisories + observed airport weather (METAR, from the
// Iowa Environmental Mesonet) at 15 US hubs.
// Usage: node test-2y.mjs faa-2y.json metar-dir out.json
// Honest-test rules: every input uses only information available at hour h;
// fitting uses training weeks only; scores are on held-out weeks.
// Split: every third calendar week is held out (so tests cover all seasons),
// with the 24 h before each test week dropped from training to avoid leakage.
import fs from 'node:fs';
const [faaPath, metarDir, outPath] = process.argv.slice(2);
const faa = JSON.parse(fs.readFileSync(faaPath, 'utf8'));
const HUBS = ['JFK', 'LGA', 'EWR', 'BOS', 'ORD', 'ATL', 'DFW', 'DEN', 'LAX', 'SFO', 'SEA', 'MIA', 'IAH', 'PHL', 'CLT'];
const NEW_PROGRAM = /GROUND STOP|GROUND DELAY PROGRAM/, NOT_NEW = /CNX|CANCEL|PROPOSED|REVIS|EXTEN|COMPRESS|UPDATE|AMEND|MODIF/;
const isUS = fac => { const ap = fac.split('/')[0].trim(); return /^[A-Z0-9]{3}$/.test(ap) || /^K[A-Z]{3}$/.test(ap); };
const days = Object.keys(faa).sort();
const t0 = Date.parse(days[0] + 'T00:00:00Z'), H = Math.round((Date.parse(days[days.length - 1] + 'T00:00:00Z') - t0) / 3600000) + 24;
const haveDay = new Set(days);
const hourIndex = ts => Math.floor((ts - t0) / 3600000);
const events = new Array(H).fill(0), evAp = {};
for (const rows of Object.values(faa)) for (const r of rows) {
  const title = r.title.toUpperCase(); if (!NEW_PROGRAM.test(title) || NOT_NEW.test(title) || !isUS(r.facility)) continue;
  const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(r.sent); if (!m) continue;
  const h = hourIndex(Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5])); if (h < 0 || h >= H) continue;
  events[h]++; const ap = r.facility.split('/')[0].trim(); (evAp[ap] ||= new Array(H).fill(0))[h]++;
}
const ahead = (h, n) => { let s = 0; for (let k = h + 1; k <= h + n && k < H; k++) s += events[k]; return s; };
// ---- METAR: latest observation in each hour, per hub
const obs = {};
for (const c of HUBS) {
  const f = `${metarDir}/${c}.csv`; if (!fs.existsSync(f)) continue;
  const a = obs[c] = new Array(H).fill(null);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n'); const hd = lines[0].split(',');
  const ix = k => hd.indexOf(k);
  for (const ln of lines.slice(1)) {
    const x = ln.split(','); const h = hourIndex(Date.parse(x[ix('valid')].replace(' ', 'T') + ':00Z')); if (h < 0 || h >= H) continue;
    let ceil = Infinity; for (const n of [1, 2, 3]) { const cov = x[ix('skyc' + n)], base = parseFloat(x[ix('skyl' + n)]); if ((cov === 'BKN' || cov === 'OVC' || cov === 'VV ' || cov === 'VV') && Number.isFinite(base)) ceil = Math.min(ceil, base); }
    const vis = parseFloat(x[ix('vsby')]), wx = x[ix('wxcodes')] || '', gust = parseFloat(x[ix('gust')]) || 0, wind = parseFloat(x[ix('sknt')]) || 0;
    a[h] = { ceil, vis: Number.isFinite(vis) ? vis : 10, ts: /TS/.test(wx), snow: /SN|FZ|PL|GS/.test(wx), gust: Math.max(gust, wind) };
  }
  for (let h = 1; h < H; h++) if (!a[h] && a[h - 1]) a[h] = a[h - 1]; // carry forward one missing hour at most once per gap
}
const hubWx = (c, h) => obs[c] && obs[c][h];
function metarFeatures(h) {
  let ifr = 0, lowCeil = 0, ts = 0, snow = 0, wind = 0, pts = 0;
  for (const c of HUBS) { const o = hubWx(c, h); if (!o) continue;
    if (o.ceil < 1000 || o.vis < 3) ifr++;
    if (o.ceil < 2500 || o.vis < 5) lowCeil++;
    if (o.ts) ts++; if (o.snow) snow++; if (o.gust >= 30) wind++;
    pts += (o.ts ? 3 : 0) + (o.snow ? 2 : 0) + (o.ceil < 500 || o.vis < 1 ? 2 : o.ceil < 1000 || o.vis < 3 ? 1.2 : o.ceil < 2500 ? 0.5 : 0) + (o.gust >= 35 ? 1.5 : o.gust >= 28 ? 0.7 : 0);
  }
  return { ifr, lowCeil, ts, snow, wind, metarPts: pts };
}
const rows = [];
for (let h = 3; h < H - 4; h++) {
  const t = new Date(t0 + h * 3600000);
  // skip hours whose window touches a day not downloaded (would look like zero programs)
  if (![-3, 0, 4].every(o => haveDay.has(new Date(t0 + (h + o) * 3600000).toISOString().slice(0, 10)))) continue;
  const week = Math.floor((h / 24 + 4) / 7); // calendar-ish week index
  rows.push({ h, t: t.toISOString(), hour: t.getUTCHours(), dow: t.getUTCDay(), month: t.getUTCMonth(), week,
    y3big: ahead(h, 3) >= 3 ? 1 : 0, y3: ahead(h, 3) > 0 ? 1 : 0,
    persist: events[h] + events[h - 1] + events[h - 2],
    today: (() => { let s = 0; for (let k = h; k > h - 24 && k >= 0; k--) s += events[k]; return s; })(),
    ...metarFeatures(h) });
}
const isTest = r => r.week % 3 === 2;
const test = rows.filter(isTest);
const train = rows.filter(r => !isTest(r) && !isTest({ week: Math.floor(((r.h + 24) / 24 + 4) / 7) }));
// ---- shared helpers (same as analyze.mjs)
function auc(data, key, y) {
  const d = data.filter(r => Number.isFinite(r[key])); const pos = d.filter(r => r[y]).length, neg = d.length - pos; if (!pos || !neg) return null;
  const all = d.map(r => ({ s: r[key], y: r[y] })).sort((a, b) => a.s - b.s); let rs = 0;
  for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j].s === all[i].s) j++; const ar = (i + 1 + j) / 2; for (let k = i; k < j; k++) if (all[k].y) rs += ar; i = j; }
  return +((rs - pos * (pos + 1) / 2) / (pos * neg)).toFixed(3);
}
function fitTod(y, data) { const n = {}, k = {}; const key = r => r.hour + '-' + (r.dow === 0 || r.dow === 6 ? 'we' : 'wd');
  for (const r of data) { n[key(r)] = (n[key(r)] || 0) + 1; k[key(r)] = (k[key(r)] || 0) + r[y]; } return r => (k[key(r)] || 0) / (n[key(r)] || 1); }
function fitLogit(keys, y, data) {
  const mu = {}, sd = {}; for (const k of keys) { const xs = data.map(r => r[k]); mu[k] = xs.reduce((a, b) => a + b, 0) / xs.length; sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / xs.length) || 1; }
  let w = new Array(keys.length + 1).fill(0);
  const X = data.map(r => [1, ...keys.map(k => (r[k] - mu[k]) / sd[k])]), Y = data.map(r => r[y]);
  for (let it = 0; it < 1500; it++) { const g = new Array(w.length).fill(0);
    for (let i = 0; i < X.length; i++) { const p = 1 / (1 + Math.exp(-X[i].reduce((s, xi, j) => s + xi * w[j], 0))); for (let j = 0; j < w.length; j++) g[j] += (p - Y[i]) * X[i][j]; }
    w = w.map((wi, i) => wi - 0.5 * g[i] / X.length - (i ? 0.001 * wi : 0)); }
  return { predict: r => 1 / (1 + Math.exp(-[1, ...keys.map(k => (r[k] - mu[k]) / sd[k])].reduce((s, xi, i) => s + xi * w[i], 0))), weights: Object.fromEntries(keys.map((k, i) => [k, +w[i + 1].toFixed(3)])) };
}
const res = { period: { start: rows[0].t, end: rows[rows.length - 1].t }, hours: { train: train.length, test: test.length }, events: events.reduce((a, b) => a + b, 0), hubsWithMetar: Object.keys(obs) };
const y = 'y3big', T = 'tod';
const tod = fitTod(y, train); for (const r of rows) r[T] = tod(r);
res.baseRate = +(test.reduce((a, r) => a + r[y], 0) / test.length).toFixed(3);
res.alone = Object.fromEntries(['tod', 'persist', 'today', 'metarPts', 'ifr', 'lowCeil', 'ts', 'snow', 'wind'].map(k => [k, auc(test, k, y)]));
const sets = { todPersist: [T, 'persist'], plusMetarPts: [T, 'persist', 'metarPts'], plusMetarParts: [T, 'persist', 'ifr', 'lowCeil', 'ts', 'snow', 'wind'], plusParts_today: [T, 'persist', 'today', 'ifr', 'lowCeil', 'ts', 'snow', 'wind'] };
res.models = {};
for (const [name, keys] of Object.entries(sets)) { const m = fitLogit(keys, y, train); for (const r of rows) r['m_' + name] = m.predict(r); res.models[name] = { aucTest: auc(test, 'm_' + name, y), aucTrain: auc(train, 'm_' + name, y), weights: m.weights }; }
// by season (test hours only)
const season = r => [11, 0, 1].includes(r.month) ? 'winter (Dec-Feb)' : [2, 3, 4].includes(r.month) ? 'spring (Mar-May)' : [5, 6, 7].includes(r.month) ? 'summer (Jun-Aug)' : 'autumn (Sep-Nov)';
res.bySeason = {};
for (const s of ['winter (Dec-Feb)', 'spring (Mar-May)', 'summer (Jun-Aug)', 'autumn (Sep-Nov)']) { const d = test.filter(r => season(r) === s); res.bySeason[s] = { hours: d.length, baseRate: +(d.reduce((a, r) => a + r[y], 0) / d.length).toFixed(3), ...Object.fromEntries(Object.keys(sets).map(n => [n, auc(d, 'm_' + n, y)])) }; }
// bootstrap gain of the best weather set over tod+persist, by test week
const byWeek = {}; for (const r of test) (byWeek[r.week] ||= []).push(r); const wk = Object.keys(byWeek);
let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (const name of ['plusMetarPts', 'plusMetarParts', 'plusParts_today']) { const d = [];
  for (let b = 0; b < 300; b++) { const s2 = []; for (let i = 0; i < wk.length; i++) s2.push(...byWeek[wk[Math.floor(rnd() * wk.length)]]); d.push(auc(s2, 'm_' + name, y) - auc(s2, 'm_todPersist', y)); }
  d.sort((a, b) => a - b); res.models[name].gainVsTodPersist = { median: +d[150].toFixed(3), lo95: +d[7].toFixed(3), hi95: +d[292].toFixed(3) }; }
fs.writeFileSync(outPath, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
