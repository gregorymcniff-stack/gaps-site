import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, toCSV, COLUMNS } from '../netlify/lib/opendata.mjs';

const row = { t: '2026-11-14T05:00:00Z', kp: 1.3, metarCats: { VFR: 20, IFR: 2 }, sigmets: { TS: 60, TURB: 20, MTW: 2 },
  faa: { gs: 1, gdp: 2, afp: 0, ad: 1, load: 40, airports: ['SFO', 'EWR'] },
  scores: { sfi: 21, trafficSource: 'adsblol', aircraft: 4500, airports: { JFK: 0.05, LAX: 0.09 },
    outlook: { p3big: 0.21, p3: 0.3, typical: 0.03, features: { usHubStressNext3: 3.2, persist: 14 } } } };

test('a reading flattens into documented columns', () => {
  const f = flatten(row);
  assert.equal(f.sfi_pct, 21);
  assert.equal(f.p_rough_3h, 0.21);
  assert.equal(f.faa_affected_airports, 'SFO;EWR');
  assert.equal(f.metar_ifr, 2);
  assert.equal(f.metar_lifr, 0);
  assert.equal(f.sigmet_other, 2);
  assert.equal(f.p_program_3h_LAX, 0.09);
  assert.equal(f.p_program_3h_ORD, null);
  assert.deepEqual(Object.keys(f), COLUMNS);
});
test('rows from before the tested model leave the index blank instead of guessing', () => {
  const f = flatten({ t: 'x', scores: { sfi: 52, legacySfi: 52 } });
  assert.equal(f.sfi_pct, null);
});
test('CSV has a header and quotes values that need it', () => {
  const csv = toCSV([flatten(row)]);
  const [head, line] = csv.trim().split('\n');
  assert.equal(head.split(',').length, COLUMNS.length);
  assert.ok(line.includes('SFO;EWR'));
});
