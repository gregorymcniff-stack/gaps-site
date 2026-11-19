import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingProposals } from '../netlify/lib/feeds.mjs';

const now = Date.parse('2026-11-19T18:30:00Z');
const row = (facility, title, hhmm) => ({ n: '001', facility, title, sent: '11/19/26 ' + hhmm });

test('a recent proposal with no real program yet is a heads-up', () => {
  assert.deepEqual(pendingProposals([row('EWR/ZNY', 'CDM PROPOSED GROUND DELAY PROGRAM', '18:15')], now), [{ airport: 'EWR', sent: '2026-11-19T18:15:00.000Z' }]);
});
test('dropped once the real program is issued', () => {
  assert.deepEqual(pendingProposals([row('EWR/ZNY', 'CDM PROPOSED GROUND DELAY PROGRAM', '18:15'), row('EWR/ZNY', 'CDM GROUND DELAY PROGRAM', '18:27')], now), []);
});
test('dropped when disregarded, too old, or outside the US', () => {
  assert.deepEqual(pendingProposals([row('SFO/ZOA', 'CDM PROPOSED GROUND DELAY PROGRAM', '18:10'), row('SFO/ZOA', 'DISREGARD PROPOSED GROUND DELAY PROGRAM', '18:20')], now), []);
  assert.deepEqual(pendingProposals([row('BOS/ZBW', 'CDM PROPOSED GROUND DELAY PROGRAM', '17:00')], now), []);
  assert.deepEqual(pendingProposals([row('CYYZ', 'CDM PROPOSED GROUND DELAY PROGRAM', '18:15')], now), []);
});
test('a real program at a different airport does not cancel it', () => {
  assert.equal(pendingProposals([row('LGA/ZNY', 'CDM PROPOSED GROUND DELAY PROGRAM', '18:15'), row('JFK/ZNY', 'CDM GROUND DELAY PROGRAM', '18:20')], now).length, 1);
});
