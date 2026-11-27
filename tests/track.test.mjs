import test from 'node:test';
import assert from 'node:assert/strict';
import { programsFromRows, hourlyPredictions, auc, buildTrackRecord } from '../netlify/lib/track.mjs';

const H = 3600e3, T0 = Date.parse('2026-11-20T00:00:00Z');
const row = (ms, p, extra = {}) => ({ t: new Date(ms).toISOString(), scores: { outlook: { p3big: p, typical: 0.2 }, scale: { score: Math.round(p * 10) || 1 } }, ...extra });

test('programsFromRows keeps only new US ground stops and delay programs', () => {
  const rows = [
    { facility: 'EWR/ZNY', title: 'GROUND STOP', sent: '11/20/26 14:05' },
    { facility: 'EWR/ZNY', title: 'CNX GROUND STOP', sent: '11/20/26 15:00' },
    { facility: 'SFO', title: 'PROPOSED GROUND DELAY PROGRAM', sent: '11/20/26 15:10' },
    { facility: 'SFO', title: 'GROUND DELAY PROGRAM', sent: '11/20/26 15:30' },
    { facility: 'CYYZ', title: 'GROUND STOP', sent: '11/20/26 16:00' },
  ];
  assert.deepEqual(programsFromRows(rows), [
    { airport: 'EWR', type: 'GS', t: '2026-11-20T14:05:00.000Z' },
    { airport: 'SFO', type: 'GDP', t: '2026-11-20T15:30:00.000Z' },
  ]);
});

test('hourlyPredictions takes the first tested reading of each hour', () => {
  const p = hourlyPredictions([{ t: new Date(T0).toISOString(), scores: { legacySfi: 50 } }, row(T0 + 5 * 60e3, 0.3), row(T0 + 15 * 60e3, 0.9), row(T0 + H, 0.4)]);
  assert.equal(p.length, 2);
  assert.equal(p[0].p, 0.3);
  assert.equal(p[1].p, 0.4);
});

test('auc: perfect ranking is 1, reversed is 0, ties are half', () => {
  assert.equal(auc([{ p: 0.1, rough: false }, { p: 0.9, rough: true }], 'p'), 1);
  assert.equal(auc([{ p: 0.9, rough: false }, { p: 0.1, rough: true }], 'p'), 0);
  assert.equal(auc([{ p: 0.5, rough: false }, { p: 0.5, rough: true }], 'p'), 0.5);
  assert.equal(auc([{ p: 0.5, rough: true }], 'p'), null);
});

test('buildTrackRecord scores the 3 hours after each reading, like the backtest', () => {
  // Reading at 10:00 says 80%; 3 programs at 11:xx-13:xx => rough.
  // Reading at 20:00 says 5%; 3 programs but at 20:30 (same hour) => not rough.
  const history = [row(T0 + 10 * H, 0.8), row(T0 + 20 * H, 0.05), row(T0 + 22 * H, 0.5)];
  const progs = ['11:10', '12:00', '13:59', '20:30', '20:40', '20:50'].map(x => ({ airport: 'EWR', type: 'GS', t: `2026-11-20T${x}:00.000Z` }));
  const r = buildTrackRecord({ historyRows: history, days: { '2026-11-20': progs }, now: T0 + 30 * H });
  // the 22:00 reading needs 2026-11-21, which was not read: left out
  assert.equal(r.hours, 2);
  assert.equal(r.roughHours, 1);
  assert.equal(r.auc, 1);
  assert.deepEqual(r.warnings, { said50: 1, followed: 1, roughCaught: 1 });
  const top = r.calibration.find(b => b.from === 0.75);
  assert.deepEqual([top.hours, top.observed], [1, 1]);
});

test('buildTrackRecord skips readings whose 3 hours are not over yet', () => {
  const r = buildTrackRecord({ historyRows: [row(T0 + 10 * H, 0.8)], days: { '2026-11-20': [] }, now: T0 + 13 * H });
  assert.equal(r.hours, 0);
});
