// Backup for the FAA advisory feed. Every collector run compares the ground
// stops and ground delay programs in FAA NAS Status with the previous run and
// records any that newly appear. If the advisory database page cannot be read,
// the outlooks use this record instead (it can miss ground stops that start
// and end within one 10-minute interval).

export function updateProgramLog(log, faaData, nowIso) {
  const current = [
    ...(faaData.groundStops || []).map(p => 'GS:' + p.airport),
    ...(faaData.groundDelays || []).map(p => 'GDP:' + p.airport),
  ].filter(k => /:[A-Z0-9]{3}$/.test(k));
  const next = { active: [...new Set(current)], programs: [...((log && log.programs) || [])], since: (log && log.since) || nowIso };
  if (log && Array.isArray(log.active)) {   // on the very first run, programs already in effect are not "new"
    const before = new Set(log.active);
    for (const k of next.active) if (!before.has(k)) { const [type, airport] = k.split(':'); next.programs.unshift({ airport, type, sent: nowIso, source: 'nas' }); }
  }
  const cutoff = Date.parse(nowIso) - 48 * 3600e3;
  next.programs = next.programs.filter(p => Date.parse(p.sent) >= cutoff).slice(0, 250);
  return next;
}

export function backupAdvisoryFeed(original, log, nowIso) {
  return {
    ok: true, fetchedAt: nowIso, sourceTime: null, source: 'nas-status-backup',
    error: original && original.error ? original.error : null,
    note: 'FAA advisory database unavailable; recent programs derived from changes in FAA NAS Status (may miss very short ground stops).',
    data: { programs: log.programs.map(({ airport, type, sent }) => ({ airport, type, sent })) },
  };
}
