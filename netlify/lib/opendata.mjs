// Flat, documented columns for the open-data download (/api/data).
// Keep COLUMNS and the data dictionary on public/data.html in step.
export const AIRPORT_COLS = ['JFK', 'LGA', 'EWR', 'BOS', 'PHL', 'ATL', 'CLT', 'MIA', 'ORD', 'DFW', 'IAH', 'DEN', 'SFO', 'SEA', 'LAX'];
const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
export function flatten(r) {
  const s = r.scores || {}, o = s.outlook || null, f = r.faa || null, m = r.metarCats || null, g = r.sigmets || null, A = s.airports || {};
  const row = {
    time_utc: r.t,
    score_1to10: s.scale ? num(s.scale.score) : null,
    score_tod_1to10: s.scale ? num(s.scale.tod) : null,
    score_recent_programs_1to10: s.scale ? num(s.scale.persist) : null,
    score_hub_weather_1to10: s.scale ? num(s.scale.weather) : null,
    sfi_pct: o ? num(s.sfi) : null,
    p_rough_3h: o ? num(o.p3big) : null,
    p_any_program_3h: o ? num(o.p3) : null,
    typical_p_rough_3h: o ? num(o.typical) : null,
    hub_weather_pts_next3h: o && o.features ? num(o.features.usHubStressNext3) : null,
    new_programs_last3h: o && o.features ? num(o.features.persist) : null,
    faa_ground_stops: f ? f.gs : null,
    faa_ground_delay_programs: f ? f.gdp : null,
    faa_airspace_flow_programs: f ? f.afp : null,
    faa_other_delays: f ? f.ad : null,
    faa_program_load: f ? f.load : null,
    faa_affected_airports: f && Array.isArray(f.airports) ? f.airports.join(';') : null,
    aircraft_tracked: num(s.aircraft ?? r.aircraft),
    aircraft_source: s.trafficSource || (r.aircraft != null ? 'opensky' : null),
    metar_vfr: m ? m.VFR || 0 : null, metar_mvfr: m ? m.MVFR || 0 : null, metar_ifr: m ? m.IFR || 0 : null, metar_lifr: m ? m.LIFR || 0 : null,
    sigmet_thunderstorm: g ? g.TS || 0 : null, sigmet_turbulence: g ? g.TURB || 0 : null, sigmet_icing: g ? g.ICE || 0 : null, sigmet_volcanic_ash: g ? g.VA || 0 : null,
    sigmet_other: g ? Object.entries(g).filter(([k]) => !['TS', 'TURB', 'ICE', 'VA'].includes(k)).reduce((a, [, n]) => a + n, 0) : null,
    kp_index: num(r.kp),
  };
  for (const a of AIRPORT_COLS) row['p_program_3h_' + a] = num(A[a]);
  return row;
}
export const COLUMNS = Object.keys(flatten({ t: '' }));
export function toCSV(rows) {
  const cell = v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return [COLUMNS.join(','), ...rows.map(r => COLUMNS.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}
