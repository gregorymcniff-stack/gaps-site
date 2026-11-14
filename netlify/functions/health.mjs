// GET /api/health — for an uptime monitor. Answers HTTP 200 with "GAPS-OK"
// when the collector is running and key feeds are live; otherwise HTTP 503
// with a plain list of what is wrong. Never refreshes data itself, so a
// stopped collector shows up here.
import { readLatest, readHeartbeat, useContext } from '../lib/store.mjs';
import { evaluateHealth } from '../lib/health.mjs';

export default async (req, context) => {
  const deployContext = context?.deploy?.context;
  useContext(deployContext);
  const [snapshot, heartbeat] = await Promise.all([readLatest(), readHeartbeat()]);
  // Schedules only run on the published site, so previews skip the collector check.
  const h = evaluateHealth({ snapshot, heartbeat, requireCollector: !deployContext || deployContext === 'production' });
  const text = (h.ok ? 'GAPS-OK' : 'GAPS-PROBLEM: ' + h.problems.join('; ')) + '\n\n' +
    JSON.stringify({ checkedAt: new Date().toISOString(), snapshotAt: snapshot?.generatedAt || null, collectorLastRun: heartbeat?.t || null, checks: h.checks }, null, 1);
  return new Response(text, { status: h.ok ? 200 : 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/health' };
