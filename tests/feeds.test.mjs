import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFaaXml, durationToMinutes, mergeWithPrevious, summarizeStates, historyRow } from '../netlify/lib/feeds.mjs';

const xml = fs.readFileSync(new URL('./fixtures/faa-sample.xml', import.meta.url), 'utf8');

test('durations are read in minutes, including hours', () => {
  assert.equal(durationToMinutes('34 minutes'), 34);
  assert.equal(durationToMinutes('2 hours and 18 minutes'), 138);
  assert.equal(durationToMinutes('1 hour and 5 minutes'), 65);
  assert.equal(durationToMinutes('11 hours and 30 minutes'), 690);
  assert.equal(durationToMinutes(null), null);
});

test('FAA: every airport in a list is captured, not just the first', () => {
  const d = parseFaaXml(xml);
  assert.deepEqual(d.groundDelays.map(g => g.airport), ['SAN', 'SFO', 'LGA', 'BOS']);
  assert.equal(d.groundDelays.find(g => g.airport === 'SFO').avgMin, 138);
  assert.equal(d.groundDelays.find(g => g.airport === 'SFO').reason, 'wind');
});

test('FAA: ground stops, airspace flows and arrival/departure delays are separated', () => {
  const d = parseFaaXml(xml);
  assert.deepEqual(d.groundStops, [{ airport: 'EWR', reason: 'thunderstorms', endTime: '9:45 pm EST' }]);
  assert.equal(d.airspaceFlows[0].element, 'FCAA08');
  assert.equal(d.airspaceFlows[0].avgMin, 65);
  assert.equal(d.arrDepDelays[0].airport, 'IAH');
  assert.equal(d.arrDepDelays[0].legs[0].minMin, 150);
});

test('FAA: routine closures (GA restrictions, airshows) are not counted as disruptions', () => {
  const d = parseFaaXml(xml);
  assert.ok(d.closures.length >= 5);
  assert.ok(d.closures.every(c => c.full === false));
  assert.ok(!d.affectedAirports.includes('LAS'));
  assert.ok(!d.affectedAirports.includes('SUA'));
  assert.ok(d.affectedAirports.includes('EWR') && d.affectedAirports.includes('SFO'));
});

test('FAA: unrecognised response is an error, not "no programs"', () => {
  assert.throws(() => parseFaaXml('<html>maintenance</html>'));
});

test('OpenSky summary ignores aircraft on the ground and finds emergency squawks', () => {
  const st = (lon, lat, ground, sq) => ['abc', 'TEST1 ', 'X', 0, 0, lon, lat, 10000, ground, 230, 0, 0, null, 10000, sq, false, 0];
  const s = summarizeStates([st(-73, 40, false, '1200'), st(-73, 40, true, '1200'), st(2, 48, false, '7700')]);
  assert.equal(s.airborne, 2);
  assert.equal(s.squawks.length, 1);
  assert.equal(s.squawks[0].code, '7700');
});

test('a failed feed keeps its last good data with its ORIGINAL time', () => {
  const prev = { feeds: { faa: { ok: true, fetchedAt: '2026-01-01T00:00:00Z', data: { x: 1 } } } };
  const next = { feeds: { faa: { ok: false, fetchedAt: '2026-01-01T01:00:00Z', error: 'timed out', data: null } } };
  const m = mergeWithPrevious(next, prev);
  assert.equal(m.feeds.faa.fetchedAt, '2026-01-01T00:00:00Z');
  assert.equal(m.feeds.faa.ok, false);
  assert.equal(m.feeds.faa.carriedOver, true);
});

test('history rows never record carried-over data as a new reading', () => {
  const snap = { generatedAt: 'T', feeds: {
    opensky: { ok: false, carriedOver: true, data: { airborne: 5000, cruise: 1 } },
    faa: { ok: true, data: parseFaaXml(xml) }, metar: { ok: false, data: null }, sigmet: { ok: false, data: null },
    kp: { ok: true, data: { kp: 2 } }, openmeteo: { ok: false, data: null },
  } };
  const row = historyRow(snap);
  assert.equal(row.aircraft, null);
  assert.equal(row.faa.gdp, 4);
  assert.equal(row.kp, 2);
});
