import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth } from '../netlify/lib/health.mjs';

const NOW = Date.UTC(2026, 10, 14, 5, 0);
const ago = m => new Date(NOW - m * 60000).toISOString();
const feed = (m, extra = {}) => ({ ok: true, fetchedAt: ago(m), data: {}, ...extra });
function snap(overrides = {}) {
  return { generatedAt: ago(3), scores: { sfi: 21 }, feeds: {
    faa: feed(3), faaAdvisories: feed(3), usHubWx: feed(3), metar: feed(3), sigmet: feed(3), adsblol: feed(3),
    opensky: { ok: false, fetchedAt: ago(3), data: null, error: 'fetch failed' }, kp: feed(3), ...overrides } };
}

test('healthy when the collector ran recently and key feeds are live', () => {
  const h = evaluateHealth({ snapshot: snap(), heartbeat: { t: ago(4) }, now: NOW });
  assert.equal(h.ok, true, h.problems.join('; '));
  assert.equal(h.checks.aircraft.source, 'adsblol');
});
test('a stopped collector fails even if page visits keep the data fresh', () => {
  const h = evaluateHealth({ snapshot: snap(), heartbeat: { t: ago(45) }, now: NOW });
  assert.equal(h.ok, false);
  assert.match(h.problems[0], /collector last ran 45 minutes ago/);
});
test('a dead critical feed fails; an informational one does not', () => {
  assert.equal(evaluateHealth({ snapshot: snap({ faaAdvisories: { ok: false, fetchedAt: ago(3), data: null, error: 'HTTP 503' } }), heartbeat: { t: ago(4) }, now: NOW }).ok, false);
  assert.equal(evaluateHealth({ snapshot: snap({ kp: { ok: false, fetchedAt: ago(3), data: null } }), heartbeat: { t: ago(4) }, now: NOW }).ok, true);
});
test('carried-over data counts by its original age', () => {
  const h = evaluateHealth({ snapshot: snap({ faa: { ok: false, carriedOver: true, fetchedAt: ago(60), data: {} } }), heartbeat: { t: ago(4) }, now: NOW });
  assert.equal(h.ok, false);
  assert.ok(h.problems.some(p => p.startsWith('faa feed')));
});
test('previews skip the collector check', () => {
  assert.equal(evaluateHealth({ snapshot: snap(), heartbeat: null, requireCollector: false, now: NOW }).ok, true);
});
