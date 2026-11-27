// Live track record: what the outlook said each hour, compared with what the
// FAA actually did afterwards. Same target as the backtest
// (scripts/backtest/analyze.mjs): for the reading at hour h, a "rough stretch"
// means 3 or more new US ground stops / ground delay programs sent in hours
// h+1, h+2 and h+3.
import { NEW_PROGRAM, NOT_NEW, isUSFacility } from './feeds.mjs';

const HOUR = 3600e3;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

// FAA advisory-list rows (parseAdvisoryList) -> new programs with times.
export function programsFromRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const title = String(r.title || '').toUpperCase();
    if (!NEW_PROGRAM.test(title) || NOT_NEW.test(title) || !isUSFacility(r.facility)) continue;
    const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(r.sent); if (!m) continue;
    out.push({ airport: String(r.facility).split('/')[0].trim(), type: /GROUND STOP/.test(title) ? 'GS' : 'GDP', t: new Date(Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5])).toISOString() });
  }
  return out;
}

// One prediction per UTC hour: the first stored reading of that hour, which
// is the one closest to the hour the backtest used. Only readings made by the
// tested outlook model (rows with scores.outlook).
export function hourlyPredictions(historyRows) {
  const byHour = new Map();
  for (const r of historyRows || []) {
    const o = r?.scores?.outlook;
    if (!o || !Number.isFinite(o.p3big)) continue;
    const h = Math.floor(Date.parse(r.t) / HOUR) * HOUR;
    if (!Number.isFinite(h) || byHour.has(h)) continue;
    byHour.set(h, { h, t: r.t, p: o.p3big, typical: Number.isFinite(o.typical) ? o.typical : null, score: r.scores.scale?.score ?? null });
  }
  return [...byHour.values()].sort((a, b) => a.h - b.h);
}

// Area under the ROC curve (0.5 = coin flip, 1 = perfect ranking).
export function auc(items, key) {
  const xs = items.filter(i => Number.isFinite(i[key]));
  const pos = xs.filter(i => i.rough).length, neg = xs.length - pos;
  if (!pos || !neg) return null;
  const sorted = [...xs].sort((a, b) => a[key] - b[key]);
  let rankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i; while (j < sorted.length && sorted[j][key] === sorted[i][key]) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (sorted[k].rough) rankSum += avgRank;
    i = j;
  }
  return +((rankSum - pos * (pos + 1) / 2) / (pos * neg)).toFixed(3);
}
const brier = (items, key) => { const xs = items.filter(i => Number.isFinite(i[key])); return xs.length ? +(xs.reduce((s, i) => s + (i[key] - (i.rough ? 1 : 0)) ** 2, 0) / xs.length).toFixed(4) : null; };

export const BUCKETS = [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.0001]];

// days: { 'YYYY-MM-DD': [{airport,type,t}] } for every day the FAA archive was
// read; a day missing from it means "unknown", and any hour whose 3-hour
// window touches an unknown day is left out.
// predictions: from hourlyPredictions (or pass historyRows to compute them).
export function buildTrackRecord({ predictions, historyRows, days, now = Date.now(), backtestAuc = null }) {
  const counts = new Map();
  for (const progs of Object.values(days || {})) for (const p of progs) {
    const h = Math.floor(Date.parse(p.t) / HOUR) * HOUR;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  const scored = [];
  for (const pr of predictions || hourlyPredictions(historyRows)) {
    const end = pr.h + 4 * HOUR;               // window = hours h+1..h+3
    if (end > now) continue;                   // not over yet
    if (![pr.h + HOUR, pr.h + 3 * HOUR].every(ms => days && days[dayOf(ms)])) continue;
    let n = 0; for (let k = 1; k <= 3; k++) n += counts.get(pr.h + k * HOUR) || 0;
    scored.push({ ...pr, programs: n, rough: n >= 3 });
  }
  const rough = scored.filter(s => s.rough).length;
  const calibration = BUCKETS.map(([lo, hi]) => {
    const xs = scored.filter(s => s.p >= lo && s.p < hi);
    return { from: lo, to: Math.min(hi, 1), hours: xs.length,
      predicted: xs.length ? +(xs.reduce((a, s) => a + s.p, 0) / xs.length).toFixed(3) : null,
      observed: xs.length ? +(xs.filter(s => s.rough).length / xs.length).toFixed(3) : null };
  });
  const byScore = [];
  for (let k = 1; k <= 10; k++) {
    const xs = scored.filter(s => s.score === k);
    if (xs.length) byScore.push({ score: k, hours: xs.length, rough: xs.filter(s => s.rough).length });
  }
  const warned = scored.filter(s => s.p >= 0.5), roughHours = scored.filter(s => s.rough);
  const daily = new Map();
  for (const s of scored) {
    const d = dayOf(s.h), x = daily.get(d) || { day: d, hours: 0, rough: 0, predicted: 0 };
    x.hours++; x.rough += s.rough ? 1 : 0; x.predicted += s.p; daily.set(d, x);
  }
  return {
    generatedAt: new Date(now).toISOString(),
    target: '3 or more new US ground stops / ground delay programs in the 3 hours after the reading',
    first: scored[0]?.t || null, last: scored.at(-1)?.t || null,
    hours: scored.length, roughHours: rough,
    auc: auc(scored, 'p'), aucTimeOfDayOnly: auc(scored, 'typical'), backtestAuc,
    brier: brier(scored, 'p'), brierTimeOfDayOnly: brier(scored, 'typical'),
    warnings: { said50: warned.length, followed: warned.filter(s => s.rough).length, roughCaught: roughHours.filter(s => s.p >= 0.5).length },
    calibration, byScore,
    daily: [...daily.values()].map(x => ({ ...x, predicted: +(x.predicted / x.hours).toFixed(3) })).slice(-14),
    faaDaysMissing: null,
  };
}
