import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdvisoryList, NEW_PROGRAM, NOT_NEW, isUSFacility } from '../netlify/lib/feeds.mjs';
import { outlook } from '../netlify/lib/scores.mjs';

test('advisory list rows are parsed', () => {
  const html = '<table><tr><td>092</td><td>ORD/ZAU</td><td>10/15/26</td><td>CDM GROUND STOP</td><td>10/15/26 23:11</td></tr>' +
    '<tr><td>037</td><td>CYVR/CZV</td><td>10/15/26</td><td>CYVR GROUND STOP CANCELED</td><td>10/15/26 13:56</td></tr></table>';
  const rows = parseAdvisoryList(html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { n: '092', facility: 'ORD/ZAU', title: 'CDM GROUND STOP', sent: '10/15/26 23:11' });
});

test('only new US ground stops / delay programs count', () => {
  const counts = t => NEW_PROGRAM.test(t) && !NOT_NEW.test(t);
  assert.ok(counts('CDM GROUND STOP'));
  assert.ok(counts('CDM GROUND DELAY PROGRAM'));
  assert.ok(!counts('CDM GS CNX'));
  assert.ok(!counts('CDM PROPOSED GROUND DELAY PROGRAM'));
  assert.ok(!counts('CDM GROUND DELAY PROGRAM CNX'));
  assert.ok(isUSFacility('ORD/ZAU'));
  assert.ok(!isUSFacility('CYVR/CZV'));
});

function feeds({ programs = 0, storms = false, now }) {
  const hourStart = Math.floor(now / 3600000) * 3600000;
  const times = [-1, 0, 1, 2, 3].map(k => new Date(hourStart + k * 3600000).toISOString().slice(0, 16));
  const hubs = ['JFK', 'LGA', 'EWR', 'BOS', 'ORD', 'ATL', 'DFW', 'DEN', 'SFO', 'SEA', 'MIA', 'IAH', 'PHL', 'CLT', 'LAX'];
  const hourly = Object.fromEntries(hubs.map((c, i) => [c, {
    weather_code: times.map(() => (storms && i < 3 ? 95 : 0)), wind_gusts_10m: times.map(() => 10), visibility: times.map(() => 20000), cloud_cover_low: times.map(() => 10),
  }]));
  const fetchedAt = new Date(now).toISOString();
  return {
    usHubWx: { fetchedAt, data: { hubs, times, hourly } },
    faaAdvisories: { fetchedAt, data: { programs: Array.from({ length: programs }, (_, i) => ({ airport: 'X' + i, type: 'GS', sent: new Date(now - 20 * 60000).toISOString() })) } },
  };
}
const NOW = Date.UTC(2026, 10, 12, 21, 30); // a weekday evening UTC

test('outlook is null without fresh inputs', () => {
  assert.equal(outlook({}, NOW), null);
  const f = feeds({ now: NOW }); f.faaAdvisories.fetchedAt = new Date(NOW - 3 * 3600000).toISOString();
  assert.equal(outlook(f, NOW), null);
});

test('more recent programs and storms raise the chance; probabilities stay consistent', () => {
  const calm = outlook(feeds({ now: NOW }), NOW);
  const busy = outlook(feeds({ programs: 8, now: NOW }), NOW);
  const stormy = outlook(feeds({ programs: 8, storms: true, now: NOW }), NOW);
  assert.ok(calm.p3big > 0 && calm.p3big < 1);
  assert.ok(busy.p3big > calm.p3big);
  assert.ok(stormy.p3big > busy.p3big);
  for (const o of [calm, busy, stormy]) assert.ok(o.p3 >= o.p3big);
  assert.equal(stormy.features.usStorms, 3);
});

import { airportOutlooks } from '../netlify/lib/scores.mjs';
test('per-airport outlooks: programs and weather at an airport raise its own chance', () => {
  const f = feeds({ now: NOW });
  const calm = airportOutlooks(f, NOW);
  assert.equal(Object.keys(calm).length, 15);
  const busy = feeds({ now: NOW });
  busy.faaAdvisories.data.programs = [0, 1, 2].map(i => ({ airport: 'EWR', type: 'GS', sent: new Date(NOW - (20 + i) * 60000).toISOString() }));
  const b = airportOutlooks(busy, NOW);
  assert.ok(b.EWR.p > calm.EWR.p);
  assert.equal(b.EWR.features.own3, 3);
  assert.equal(b.JFK.features.others3, 3);
  const stormy = feeds({ storms: true, now: NOW }); // storms at the first three hubs (JFK, LGA, EWR)
  assert.ok(airportOutlooks(stormy, NOW).JFK.p > calm.JFK.p);
  for (const v of Object.values(b)) assert.ok(v.p > 0 && v.p < 1);
});

import { scores1to10, to10 } from '../netlify/lib/scores.mjs';
test('1-10 scores: average inputs score about 5, busy conditions score higher', () => {
  const q = Array.from({ length: 201 }, (_, i) => i); // 0..200, median 100
  assert.equal(to10(q, 100), 5);
  assert.equal(to10(q, 0), 1);
  assert.equal(to10(q, 200), 10);
  const calm = scores1to10({ features: { persist: 0, usHubStressNext3: 0, todKey: '8-wd' } });
  const busy = scores1to10({ features: { persist: 12, usHubStressNext3: 9, todKey: '22-wd' } });
  assert.ok(calm.score >= 1 && calm.score <= 4, 'calm ' + calm.score);
  assert.ok(busy.score >= 7, 'busy ' + busy.score);
  assert.ok(busy.inputs.persist.score > calm.inputs.persist.score);
});
