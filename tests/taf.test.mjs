import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tafTimeline, flightCategory } from '../netlify/lib/feeds.mjs';

const H = 3600;
const T0 = Date.UTC(2026, 10, 14, 6, 0) / 1000;
const base = { wdir: 350, wspd: 12, wgst: null, visib: '6+', wxString: null, clouds: [{ cover: 'BKN', base: 5000 }], vertVis: null };

test('flight categories follow the standard ceiling / visibility limits', () => {
  assert.equal(flightCategory(5000, 6), 'VFR');
  assert.equal(flightCategory(2500, 6), 'MVFR');
  assert.equal(flightCategory(800, 6), 'IFR');
  assert.equal(flightCategory(5000, 2), 'IFR');
  assert.equal(flightCategory(300, 6), 'LIFR');
  assert.equal(flightCategory(null, 0.5), 'LIFR');
});

test('FM replaces the forecast; BECMG keeps what it does not change; TEMPO is shown as a possible spell', () => {
  const taf = { fcsts: [
    { ...base, timeFrom: T0, timeTo: T0 + 24 * H, fcstChange: null },
    { timeFrom: T0 + 2 * H, timeTo: T0 + 4 * H, fcstChange: 'TEMPO', visib: 2, wxString: 'TSRA', clouds: [{ cover: 'OVC', base: 800 }] },
    { timeFrom: T0 + 5 * H, timeTo: T0 + 24 * H, fcstChange: 'BECMG', wspd: 20, wgst: 30, clouds: [] },
    { ...base, timeFrom: T0 + 8 * H, timeTo: T0 + 24 * H, fcstChange: 'FM', clouds: [{ cover: 'OVC', base: 400 }], visib: 0.75, wxString: 'FG' },
  ] };
  const h = tafTimeline(taf, T0 * 1000, 10);
  assert.equal(h[0].cat, 'VFR');
  assert.equal(h[2].alt.kind, 'TEMPO');
  assert.equal(h[2].alt.cat, 'IFR');
  assert.equal(h[2].alt.wx, 'TSRA');
  assert.equal(h[4].alt, undefined);
  assert.equal(h[6].windKt, 20);          // BECMG changed the wind
  assert.equal(h[6].ceilFt, 5000);        // ...and kept the cloud it didn't mention
  assert.equal(h[9].cat, 'LIFR');         // FM fog
  assert.equal(h[9].windKt, 12);          // FM replaced everything
});
