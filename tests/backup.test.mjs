import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateProgramLog, backupAdvisoryFeed } from '../netlify/lib/backup.mjs';
import { evaluateHealth } from '../netlify/lib/health.mjs';

const faa = (gs, gdp) => ({ groundStops: gs.map(airport => ({ airport })), groundDelays: gdp.map(airport => ({ airport })) });

test('first run records what is in effect but does not call it new', () => {
  const log = updateProgramLog(null, faa(['EWR'], ['SFO']), '2026-11-14T10:00:00Z');
  assert.deepEqual(log.active.sort(), ['GDP:SFO', 'GS:EWR']);
  assert.equal(log.programs.length, 0);
});
test('a program that appears later is recorded as new, once', () => {
  let log = updateProgramLog(null, faa([], ['SFO']), '2026-11-14T10:00:00Z');
  log = updateProgramLog(log, faa(['EWR'], ['SFO']), '2026-11-14T10:10:00Z');
  log = updateProgramLog(log, faa(['EWR'], ['SFO']), '2026-11-14T10:20:00Z');
  assert.deepEqual(log.programs, [{ airport: 'EWR', type: 'GS', sent: '2026-11-14T10:10:00Z', source: 'nas' }]);
  log = updateProgramLog(log, faa([], ['SFO']), '2026-11-14T10:30:00Z');         // ends
  log = updateProgramLog(log, faa(['EWR'], ['SFO']), '2026-11-14T10:40:00Z');    // a second ground stop
  assert.equal(log.programs.filter(p => p.airport === 'EWR').length, 2);
});
test('entries older than 48 hours are dropped', () => {
  let log = updateProgramLog(null, faa([], []), '2026-11-12T00:00:00Z');
  log = updateProgramLog(log, faa(['ORD'], []), '2026-11-12T00:10:00Z');
  log = updateProgramLog(log, faa(['ORD'], []), '2026-11-14T12:00:00Z');
  assert.equal(log.programs.length, 0);
});
test('the backup feed is usable by the outlooks and flagged by the health check', () => {
  let log = updateProgramLog(null, faa([], []), '2026-11-14T10:00:00Z');
  log = updateProgramLog(log, faa(['EWR'], []), '2026-11-14T10:10:00Z');
  const feed = backupAdvisoryFeed({ error: 'HTTP 503' }, log, '2026-11-14T10:10:00Z');
  assert.equal(feed.ok, true);
  assert.equal(feed.data.programs[0].airport, 'EWR');
  const now = Date.parse('2026-11-14T10:12:00Z'), f = (m = 2) => ({ ok: true, fetchedAt: new Date(now - m * 60000).toISOString(), data: {} });
  const snapshot = { generatedAt: new Date(now - 120000).toISOString(), scores: { sfi: 10 }, feeds: { faa: f(), usHubWx: f(), metar: f(), sigmet: f(), adsblol: f(), faaAdvisories: feed } };
  const h = evaluateHealth({ snapshot, heartbeat: { t: new Date(now - 120000).toISOString() }, now });
  assert.equal(h.ok, false);
  assert.match(h.problems.join(), /backup/);
});
