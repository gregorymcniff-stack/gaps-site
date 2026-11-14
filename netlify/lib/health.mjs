// Health rules for /api/health. A monitoring service checks that address every
// few minutes and emails the owner when it stops answering "GAPS-OK".

// Feeds the dashboard cannot do without (minutes before they count as stale).
export const CRITICAL = { faa: 25, faaAdvisories: 30, usHubWx: 90, metar: 90, sigmet: 60 };
// Shown in the report but never fail the check.
export const INFO = { kp: 240, emergencies: 30, openmeteo: 90, hubTraffic: 30 };
export const COLLECTOR_MAX_MIN = 25; // scheduled every 10 minutes: allow two misses

const ageMin = (iso, now) => (iso ? (now - Date.parse(iso)) / 60000 : Infinity);

export function evaluateHealth({ snapshot, heartbeat, requireCollector = true, now = Date.now() }) {
  const problems = [], checks = {};
  const hb = ageMin(heartbeat?.t, now);
  checks.collector = { ok: hb <= COLLECTOR_MAX_MIN, ageMin: Number.isFinite(hb) ? Math.round(hb) : null };
  if (requireCollector && !checks.collector.ok) problems.push(heartbeat ? `the 10-minute collector last ran ${Math.round(hb)} minutes ago` : 'the 10-minute collector has never run');
  const snapAge = ageMin(snapshot?.generatedAt, now);
  checks.snapshot = { ok: snapAge <= COLLECTOR_MAX_MIN, ageMin: Number.isFinite(snapAge) ? Math.round(snapAge) : null };
  if (!checks.snapshot.ok) problems.push(snapshot ? `latest data is ${Math.round(snapAge)} minutes old` : 'no data has been stored');
  const feeds = snapshot?.feeds || {};
  const fresh = (k, max) => !!(feeds[k]?.data && ageMin(feeds[k].fetchedAt, now) <= max);
  for (const [k, max] of Object.entries(CRITICAL)) {
    checks[k] = { ok: fresh(k, max), error: feeds[k]?.error || null };
    if (snapshot && !checks[k].ok) problems.push(`${k} feed is down${feeds[k]?.error ? ' (' + feeds[k].error + ')' : ''}`);
  }
  // aircraft: either source is fine
  checks.aircraft = { ok: fresh('opensky', 25) || fresh('adsblol', 25), source: fresh('opensky', 25) ? 'opensky' : fresh('adsblol', 25) ? 'adsblol' : null };
  if (snapshot && !checks.aircraft.ok) problems.push('aircraft feeds are down (OpenSky and adsb.lol)');
  checks.outlook = { ok: Number.isFinite(snapshot?.scores?.sfi) };
  if (snapshot && !checks.outlook.ok) problems.push('the Sky Friction Index could not be calculated');
  for (const [k, max] of Object.entries(INFO)) checks[k] = { ok: fresh(k, max), info: true };
  return { ok: problems.length === 0, problems, checks };
}
