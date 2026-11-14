import model from '../../public/data/sfi-model.json' with { type: 'json' };
// GAPS live-data collector.
// Fetches every public feed on the server (not in the visitor's browser), so
// browser cross-site blocks and per-visitor rate limits no longer apply.
// Every feed reports { ok, fetchedAt, sourceTime, error, data }. Nothing here
// invents a value: a failed feed returns ok:false and no data.

const UA = 'GAPS-dashboard/2.0 (+https://dashboardrunway.live)';
const TIMEOUT_MS = 7000;

// Reference list of monitored airports (static coordinates, not live data).
export const AIRPORTS = [
  { iata: 'JFK', icao: 'KJFK', name: "New York JFK", lat: 40.64, lon: -73.78, region: 'US' },
  { iata: 'LGA', icao: 'KLGA', name: "New York LaGuardia", lat: 40.78, lon: -73.87, region: 'US' },
  { iata: 'EWR', icao: 'KEWR', name: "Newark", lat: 40.69, lon: -74.17, region: 'US' },
  { iata: 'BOS', icao: 'KBOS', name: "Boston Logan", lat: 42.36, lon: -71.01, region: 'US' },
  { iata: 'ORD', icao: 'KORD', name: "Chicago O'Hare", lat: 41.98, lon: -87.90, region: 'US' },
  { iata: 'ATL', icao: 'KATL', name: "Atlanta", lat: 33.64, lon: -84.43, region: 'US' },
  { iata: 'DFW', icao: 'KDFW', name: "Dallas/Fort Worth", lat: 32.90, lon: -97.04, region: 'US' },
  { iata: 'DEN', icao: 'KDEN', name: "Denver", lat: 39.86, lon: -104.67, region: 'US' },
  { iata: 'LAX', icao: 'KLAX', name: "Los Angeles", lat: 33.94, lon: -118.41, region: 'US' },
  { iata: 'SFO', icao: 'KSFO', name: "San Francisco", lat: 37.62, lon: -122.38, region: 'US' },
  { iata: 'SEA', icao: 'KSEA', name: "Seattle-Tacoma", lat: 47.45, lon: -122.31, region: 'US' },
  { iata: 'MIA', icao: 'KMIA', name: "Miami", lat: 25.79, lon: -80.29, region: 'US' },
  { iata: 'PHL', icao: 'KPHL', name: "Philadelphia", lat: 39.87, lon: -75.24, region: 'US' },
  { iata: 'CLT', icao: 'KCLT', name: "Charlotte", lat: 35.21, lon: -80.94, region: 'US' },
  { iata: 'IAH', icao: 'KIAH', name: "Houston Intercontinental", lat: 29.98, lon: -95.34, region: 'US' },
  { iata: 'LHR', icao: 'EGLL', name: "London Heathrow", lat: 51.47, lon: -0.45, region: 'EU' },
  { iata: 'CDG', icao: 'LFPG', name: "Paris Charles de Gaulle", lat: 49.01, lon: 2.55, region: 'EU' },
  { iata: 'FRA', icao: 'EDDF', name: "Frankfurt", lat: 50.03, lon: 8.57, region: 'EU' },
  { iata: 'AMS', icao: 'EHAM', name: "Amsterdam Schiphol", lat: 52.31, lon: 4.76, region: 'EU' },
  { iata: 'DXB', icao: 'OMDB', name: "Dubai", lat: 25.25, lon: 55.36, region: 'ME' },
  { iata: 'SIN', icao: 'WSSS', name: "Singapore Changi", lat: 1.36, lon: 103.99, region: 'AS' },
  { iata: 'HKG', icao: 'VHHH', name: "Hong Kong", lat: 22.31, lon: 113.91, region: 'AS' },
  { iata: 'NRT', icao: 'RJAA', name: "Tokyo Narita", lat: 35.77, lon: 140.39, region: 'AS' },
  { iata: 'SYD', icao: 'YSSY', name: "Sydney", lat: -33.95, lon: 151.18, region: 'OC' },
  { iata: 'GRU', icao: 'SBGR', name: "São Paulo Guarulhos", lat: -23.43, lon: -46.47, region: 'SA' },
  { iata: 'SCL', icao: 'SCEL', name: "Santiago", lat: -33.39, lon: -70.79, region: 'SA' },
];

// The eight points used for the Open-Meteo weather and 250 hPa wind sample.
export const WEATHER_POINTS = ['JFK', 'LHR', 'ORD', 'LAX', 'SIN', 'DXB', 'SCL', 'NRT'];
// Airports sampled for nearby-aircraft counts from community ADS-B receivers.
const HUB_TRAFFIC = ['JFK', 'ORD', 'ATL', 'LAX', 'LHR', 'FRA', 'DXB', 'SIN'];

const byIata = Object.fromEntries(AIRPORTS.map(a => [a.iata, a]));

async function get(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function feed(name, fn) {
  const fetchedAt = new Date().toISOString();
  try {
    const { data, sourceTime = null, note = null } = await fn();
    return { ok: true, fetchedAt, sourceTime, note, error: null, data };
  } catch (e) {
    const msg = e?.name === 'TimeoutError' ? 'timed out' : (e?.message || String(e));
    return { ok: false, fetchedAt, sourceTime: null, note: null, error: msg, data: null };
  }
}

// ---------------------------------------------------------------- OpenSky
let openskyToken = null;
async function openskyAuthHeader() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (openskyToken && openskyToken.exp > Date.now() + 60000) return `Bearer ${openskyToken.value}`;
  const res = await get('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  const j = await res.json();
  openskyToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 1800) * 1000 };
  return `Bearer ${openskyToken.value}`;
}

function regionName(lon, lat) {
  if (lon >= -80 && lon <= 10 && lat >= 35 && lat <= 70) return 'North Atlantic / Europe';
  if ((lon >= 150 || lon <= -120) && lat >= 20 && lat <= 65) return 'North Pacific';
  if (lon >= -130 && lon <= -60 && lat >= 20 && lat <= 55) return 'North America';
  if (lon >= 80 && lon <= 150 && lat >= -10 && lat <= 50) return 'Asia';
  if (lon >= 30 && lon <= 80 && lat >= 0 && lat <= 45) return 'Middle East';
  if (lon >= -85 && lon <= -30 && lat < 15) return 'South America';
  if (lon >= 110 && lat < -10) return 'Oceania';
  if (lon >= -20 && lon <= 55 && lat < 35) return 'Africa';
  return 'Other';
}

export function summarizeStates(states) {
  const CELL = 3; // degrees per density cell
  const cells = new Map();
  const regions = {};
  let airborne = 0, cruise = 0, vrN = 0, absVr = 0;
  const squawks = [];
  for (const s of states) {
    const lon = s[5], lat = s[6], alt = s[7] ?? s[13], onGround = s[8], vel = s[9], vr = s[11];
    const sq = String(s[14] || '');
    if (onGround || lon == null || lat == null) continue;
    airborne++;
    if (alt != null && alt >= 8500 && vel != null && vel > 150) cruise++;
    if (typeof vr === 'number' && Number.isFinite(vr)) { vrN++; absVr += Math.abs(vr); }
    const key = `${Math.floor((lon + 180) / CELL)},${Math.floor((lat + 90) / CELL)}`;
    cells.set(key, (cells.get(key) || 0) + 1);
    const r = regionName(lon, lat);
    regions[r] = (regions[r] || 0) + 1;
    if (sq === '7700' || sq === '7600' || sq === '7500') {
      squawks.push({ code: sq, callsign: String(s[1] || '').trim() || s[0], lat: +lat.toFixed(2), lon: +lon.toFixed(2), region: r });
    }
  }
  const density = [...cells.entries()].map(([k, n]) => { const [i, j] = k.split(',').map(Number); return [i, j, n]; });
  return {
    total: states.length, airborne, cruise, regions,
    avgAbsVerticalRate: vrN ? +(absVr / vrN).toFixed(2) : null,
    squawks, densityCellDeg: CELL, density,
  };
}

async function fetchOpenSky(timeout = 5000) {
  const auth = await openskyAuthHeader().catch(() => null);
  const res = await get('https://opensky-network.org/api/states/all', { headers: auth ? { Authorization: auth } : {}, timeout });
  const j = await res.json();
  if (!j || !Array.isArray(j.states)) throw new Error('unexpected response');
  const remaining = res.headers.get('x-rate-limit-remaining');
  return {
    data: { ...summarizeStates(j.states), authenticated: !!auth, creditsRemaining: remaining != null ? Number(remaining) : null },
    sourceTime: new Date(j.time * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------- FAA NAS
export function durationToMinutes(s) {
  if (!s) return null;
  const h = /(\d+)\s*hour/i.exec(s), m = /(\d+)\s*min/i.exec(s);
  if (!h && !m) return null;
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}
const tag = (block, t) => { const r = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(block); return r ? r[1].trim() : null; };

export function parseFaaXml(xml) {
  if (!/<AIRPORT_STATUS_INFORMATION/i.test(xml)) throw new Error('unrecognised FAA response');
  const out = { updateTime: tag(xml, 'Update_Time'), groundStops: [], groundDelays: [], airspaceFlows: [], arrDepDelays: [], closures: [], other: [] };
  for (const m of xml.matchAll(/<Delay_type>([\s\S]*?)<\/Delay_type>/g)) {
    const block = m[1];
    const name = (tag(block, 'Name') || '').toLowerCase();
    if (name.includes('ground stop')) {
      for (const p of block.matchAll(/<Program>([\s\S]*?)<\/Program>/g)) {
        out.groundStops.push({ airport: tag(p[1], 'ARPT'), reason: tag(p[1], 'Reason'), endTime: tag(p[1], 'End_Time') });
      }
    } else if (name.includes('ground delay')) {
      for (const p of block.matchAll(/<Ground_Delay>([\s\S]*?)<\/Ground_Delay>/g)) {
        out.groundDelays.push({ airport: tag(p[1], 'ARPT'), reason: tag(p[1], 'Reason'), avgMin: durationToMinutes(tag(p[1], 'Avg')), maxMin: durationToMinutes(tag(p[1], 'Max')) });
      }
    } else if (name.includes('airspace flow')) {
      for (const p of block.matchAll(/<Airspace_Flow>([\s\S]*?)<\/Airspace_Flow>/g)) {
        out.airspaceFlows.push({ element: tag(p[1], 'CTL_Element'), reason: tag(p[1], 'Reason'), avgMin: durationToMinutes(tag(p[1], 'Avg')) });
      }
    } else if (name.includes('arrival/departure')) {
      for (const p of block.matchAll(/<Delay>([\s\S]*?)<\/Delay>/g)) {
        const legs = [...p[1].matchAll(/<Arrival_Departure Type="(\w+)">([\s\S]*?)<\/Arrival_Departure>/g)].map(l => ({
          type: l[1], minMin: durationToMinutes(tag(l[2], 'Min')), maxMin: durationToMinutes(tag(l[2], 'Max')), trend: tag(l[2], 'Trend'),
        }));
        out.arrDepDelays.push({ airport: tag(p[1], 'ARPT'), reason: tag(p[1], 'Reason'), legs });
      }
    } else if (name.includes('closure')) {
      for (const p of block.matchAll(/<Airport>([\s\S]*?)<\/Airport>/g)) {
        const reason = tag(p[1], 'Reason') || '';
        // Most FAA "closures" are standing restrictions (e.g. closed to transient GA
        // except by permission). Only a closure with no exceptions counts as full.
        const restriction = /\bEXC\b|NON SKED|TRANSIENT|PPR|\bTO\b [A-Z ]*ACFT/.test(reason);
        out.closures.push({ airport: tag(p[1], 'ARPT'), reason, start: tag(p[1], 'Start'), reopen: tag(p[1], 'Reopen'), full: !restriction });
      }
    } else {
      out.other.push(tag(block, 'Name'));
    }
  }
  // Program load: a simple, transparent count-based score of active US traffic
  // management programs (0-100). It measures only what the FAA has declared.
  let load = 0;
  load += out.groundStops.length * 18;
  for (const g of out.groundDelays) load += 8 + Math.min(12, (g.avgMin || 0) / 10);
  load += out.airspaceFlows.length * 6;
  for (const d of out.arrDepDelays) load += 3 + Math.min(6, Math.max(...d.legs.map(l => l.maxMin || 0), 0) / 20);
  load += out.closures.filter(c => c.full).length * 10;
  out.programLoad = Math.min(100, Math.round(load));
  out.affectedAirports = [...new Set([
    ...out.groundStops, ...out.groundDelays, ...out.arrDepDelays, ...out.closures.filter(c => c.full),
  ].map(p => p.airport).filter(Boolean))];
  return out;
}

async function fetchFaa() {
  const res = await get('https://nasstatus.faa.gov/api/airport-status-information', { headers: { Accept: 'application/xml' } });
  const parsed = parseFaaXml(await res.text());
  const t = parsed.updateTime ? Date.parse(parsed.updateTime.replace(/ GMT$/, ' UTC')) : NaN;
  return { data: parsed, sourceTime: Number.isFinite(t) ? new Date(t).toISOString() : null };
}

// ---------------------------------------------------------------- METAR
async function fetchMetar() {
  const ids = AIRPORTS.map(a => a.icao).join(',');
  const res = await get(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('no reports returned');
  const latest = {};
  for (const m of arr) if (!latest[m.icaoId] || m.obsTime > latest[m.icaoId].obsTime) latest[m.icaoId] = m;
  const reports = Object.values(latest).map(m => {
    const ap = AIRPORTS.find(a => a.icao === m.icaoId);
    const vis = typeof m.visib === 'string' ? parseFloat(m.visib) : m.visib;
    return {
      iata: ap?.iata || m.icaoId, icao: m.icaoId, obsTime: new Date(m.obsTime * 1000).toISOString(),
      fltCat: m.fltCat || null, windKt: m.wspd ?? null, gustKt: m.wgst ?? null,
      visSm: Number.isFinite(vis) ? vis : null, wx: m.wxString || '', raw: m.rawOb,
    };
  });
  const newest = reports.reduce((t, r) => (r.obsTime > t ? r.obsTime : t), '');
  return { data: { reports, requested: AIRPORTS.length }, sourceTime: newest || null };
}

// ---------------------------------------------------------------- SIGMETs
function centroid(coords) {
  let pts = coords;
  if (typeof pts === 'string') { try { pts = JSON.parse(pts.replace(/'/g, '"')); } catch { pts = []; } }
  if (!Array.isArray(pts) || !pts.length) return null;
  const valid = pts.filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon));
  if (!valid.length) return null;
  return { lat: +(valid.reduce((s, p) => s + +p.lat, 0) / valid.length).toFixed(2), lon: +(valid.reduce((s, p) => s + +p.lon, 0) / valid.length).toFixed(2) };
}
// Simplified outline (at most 30 points) for drawing the hazard area on the map.
function outline(coords) {
  let pts = coords;
  if (typeof pts === 'string') { try { pts = JSON.parse(pts.replace(/'/g, '"')); } catch { pts = []; } }
  if (!Array.isArray(pts)) return null;
  const v = pts.filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon)).map(p => [+(+p.lon).toFixed(2), +(+p.lat).toFixed(2)]);
  if (v.length < 3) return null;
  const step = Math.max(1, Math.ceil(v.length / 30)), out = v.filter((_, i) => i % step === 0);
  if (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]) out.push(out[0]);
  return out.length >= 4 ? out : null;
}
function normHazard(h) {
  h = String(h || '').toUpperCase();
  if (h === 'CONVECTIVE' || h === 'TS' || h === 'TC') return 'TS';
  if (h.startsWith('TURB')) return 'TURB';
  if (h.startsWith('ICE')) return 'ICE';
  if (h === 'VA') return 'VA';
  return h || 'OTHER';
}
async function fetchSigmets() {
  const [intl, us] = await Promise.all([
    get('https://aviationweather.gov/api/data/isigmet?format=json').then(r => r.json()),
    get('https://aviationweather.gov/api/data/airsigmet?format=json').then(r => r.json()),
  ]);
  const now = Date.now() / 1000;
  const items = [];
  for (const s of Array.isArray(intl) ? intl : []) {
    if (+s.validTimeTo && +s.validTimeTo < now) continue;
    const c = centroid(s.coords); if (!c) continue;
    items.push({ hazard: normHazard(s.hazard), fir: s.firName || s.firId, top: +s.top || null, base: +s.base || null, ...c, poly: outline(s.coords), validTo: new Date(+s.validTimeTo * 1000).toISOString() });
  }
  for (const s of Array.isArray(us) ? us : []) {
    if (s.airSigmetType !== 'SIGMET') continue; // skip AIRMETs (lighter hazards)
    if (+s.validTimeTo && +s.validTimeTo < now) continue;
    const c = centroid(s.coords); if (!c) continue;
    items.push({ hazard: normHazard(s.hazard), fir: 'United States', top: +s.altitudeHi2 || null, base: +s.altitudeLow1 || null, ...c, poly: outline(s.coords), validTo: new Date(+s.validTimeTo * 1000).toISOString() });
  }
  const counts = items.reduce((o, s) => ((o[s.hazard] = (o[s.hazard] || 0) + 1), o), {});
  return { data: { items, counts, total: items.length } };
}

// ---------------------------------------------------------------- Open-Meteo
async function fetchOpenMeteo() {
  const pts = WEATHER_POINTS.map(c => byIata[c]);
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + pts.map(p => p.lat).join(',') +
    '&longitude=' + pts.map(p => p.lon).join(',') +
    '&current=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m' +
    '&hourly=wind_speed_250hPa,wind_direction_250hPa&wind_speed_unit=mph&timezone=UTC&forecast_days=2';
  const res = await get(url);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('unexpected response');
  return { data: { points: WEATHER_POINTS, raw: arr }, sourceTime: arr[0]?.current?.time ? arr[0].current.time + ':00Z' : null };
}

// ---------------------------------------------------------------- NOAA Kp
async function fetchKp() {
  const res = await get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
  const json = await res.json();
  // NOAA has used two formats: an array of objects {time_tag, Kp}, and an
  // array of arrays with a header row. Accept either.
  const rows = (Array.isArray(json) ? json : [])
    .map(r => Array.isArray(r) ? [r[0], Number(r[1])] : [r?.time_tag, Number(r?.Kp ?? r?.kp_index)])
    .filter(([t, k]) => t && Number.isFinite(k));
  const last = rows[rows.length - 1];
  if (!last) throw new Error('no Kp value');
  const time = new Date(String(last[0]).replace(' ', 'T').replace(/Z?$/, 'Z'));
  return { data: { kp: last[1], recent: rows.slice(-8) }, sourceTime: Number.isFinite(+time) ? time.toISOString() : null };
}

// ---------------------------------------------------------------- Community ADS-B (adsb.lol)
async function fetchHubTraffic() {
  const results = await Promise.all(HUB_TRAFFIC.map(async code => {
    const a = byIata[code];
    try {
      const j = await (await get(`https://api.adsb.lol/v2/lat/${a.lat}/lon/${a.lon}/dist/40`, { timeout: 6000 })).json();
      const ac = Array.isArray(j.ac) ? j.ac : [];
      return [code, { airborne: ac.filter(x => x.alt_baro !== 'ground').length, total: ac.length }];
    } catch { return [code, null]; }
  }));
  const hubs = Object.fromEntries(results);
  if (!results.some(([, v]) => v)) throw new Error('no hub responses');
  return { data: { radiusNm: 40, hubs } };
}
// adsb.lol: used when OpenSky is unavailable (OpenSky refuses connections from
// Netlify's servers). The count is adsb.lol's own worldwide total of aircraft
// tracked by its volunteer receivers (one request). Map shading and region
// counts come from the positions of the 8 most common airliner types; if those
// requests are throttled, the count still works and the map simply has no shading.
const SAMPLE_TYPES = ['A320', 'A20N', 'A321', 'A21N', 'B738', 'B38M', 'B77W', 'B789'];
async function fetchAdsbLol() {
  const me = await (await get('https://api.adsb.lol/0/me', { timeout: 5000 })).json();
  const total = Number(me?.global?.aircraft);
  if (!Number.isFinite(total) || total <= 0) throw new Error('no worldwide count in response');
  const lists = await Promise.all(SAMPLE_TYPES.map(t =>
    get(`https://api.adsb.lol/v2/type/${t}`, { timeout: 4000 }).then(r => r.json()).then(j => j.ac || []).catch(() => null)));
  const seen = new Set(), states = [];
  for (const a of lists.flat().filter(Boolean)) {
    if (seen.has(a.hex) || a.lat == null || a.lon == null) continue;
    seen.add(a.hex);
    const altM = typeof a.alt_baro === 'number' ? a.alt_baro * 0.3048 : null;
    // Same layout as OpenSky state vectors, so one summary function serves both.
    states.push([a.hex, a.flight || '', null, 0, 0, a.lon, a.lat, altM, a.alt_baro === 'ground', a.gs != null ? a.gs * 0.5144 : null,
      a.track ?? null, a.baro_rate != null ? a.baro_rate * 0.00508 : null, null, altM, a.squawk || '']);
  }
  const sample = summarizeStates(states);
  const answered = lists.filter(Boolean).length;
  return { data: {
    source: 'adsb.lol', airborne: total, total,
    sampleTypes: SAMPLE_TYPES.length, sampleAnswered: answered, sampleAirborne: sample.airborne, cruise: sample.cruise,
    regions: answered ? sample.regions : null, density: answered ? sample.density : [], densityCellDeg: sample.densityCellDeg, squawks: [],
  } };
}

// ---------------------------------------------------------------- Disruption outlook inputs
// The same 15 US hubs and the same weather variables as the backtest
// (scripts/backtest), so the live outlook uses exactly what was tested.
const US_HUB_COORDS = {
  JFK: [40.64, -73.78], LGA: [40.78, -73.87], EWR: [40.69, -74.17], BOS: [42.36, -71.01], ORD: [41.98, -87.90], ATL: [33.64, -84.43],
  DFW: [32.90, -97.04], DEN: [39.86, -104.67], SFO: [37.62, -122.38], SEA: [47.45, -122.31], MIA: [25.79, -80.29], IAH: [29.98, -95.34],
  PHL: [39.87, -75.24], CLT: [35.21, -80.94], LAX: [33.94, -118.41],
};
async function fetchUsHubWeather() {
  const codes = model.usHubs;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + codes.map(c => US_HUB_COORDS[c][0]).join(',') +
    '&longitude=' + codes.map(c => US_HUB_COORDS[c][1]).join(',') +
    '&hourly=weather_code,wind_speed_10m,wind_gusts_10m,precipitation,visibility,cloud_cover_low&wind_speed_unit=mph&timezone=UTC&past_hours=1&forecast_hours=5';
  const arr = await (await get(url)).json();
  if (!Array.isArray(arr) || arr.length !== codes.length) throw new Error('unexpected response');
  return { data: { hubs: codes, times: arr[0].hourly.time, hourly: Object.fromEntries(codes.map((c, i) => [c, arr[i].hourly])) } };
}
// New US ground stops / ground delay programs from the FAA advisory database.
export const NEW_PROGRAM = /GROUND STOP|GROUND DELAY PROGRAM/;
export const NOT_NEW = /CNX|CANCEL|PROPOSED|REVIS|EXTEN|COMPRESS|UPDATE|AMEND|MODIF/;
export const isUSFacility = fac => { const ap = String(fac).split('/')[0].trim(); return /^[A-Z0-9]{3}$/.test(ap) || /^K[A-Z]{3}$/.test(ap); };
export function parseAdvisoryList(html) {
  const strip = x => x.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
  const rows = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(strip);
    if (cells.length >= 5 && /^\d{3}$/.test(cells[0])) rows.push({ n: cells[0], facility: cells[1], title: cells[3], sent: cells[4] });
  }
  return rows;
}
async function fetchFaaAdvisories() {
  const days = [0, 1].map(k => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10));
  const lists = await Promise.all(days.map(day => get(`https://www.fly.faa.gov/adv/adv_list?whichAdvisories=ATCSCC&advisoryCategory=NotAll&date=${day}&gStop=true&_gStop=on&gDelay=true&_gDelay=on&_airflow=on&_ctop=on&_route=on&_other=on`, { timeout: 8000 }).then(r => r.text())));
  const programs = [];
  for (const html of lists) {
    if (!/adv_list|ATCSCC/i.test(html)) throw new Error('unrecognised advisory page');
    for (const r of parseAdvisoryList(html)) {
      const title = r.title.toUpperCase();
      if (!NEW_PROGRAM.test(title) || NOT_NEW.test(title) || !isUSFacility(r.facility)) continue;
      const m = /(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d):(\d\d)/.exec(r.sent); if (!m) continue;
      programs.push({ airport: r.facility.split('/')[0].trim(), type: /GROUND STOP/.test(title) ? 'GS' : 'GDP', sent: new Date(Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5])).toISOString() });
    }
  }
  programs.sort((a, b) => b.sent.localeCompare(a.sent));
  return { data: { programs: programs.slice(0, 250) } };
}

// ---------------------------------------------------------------- TAF (airport forecasts)
// Turn a TAF into an hour-by-hour timeline: the prevailing forecast plus any
// temporary or probable spells (TEMPO / PROB) covering that hour.
const cloudCeil = (clouds, vv) => {
  const c = (clouds || []).filter(x => (x.cover === 'BKN' || x.cover === 'OVC') && x.base != null).map(x => Number(x.base));
  if (vv != null) c.push(Number(vv));
  return c.length ? Math.min(...c) : null;
};
const visNum = v => v == null ? null : typeof v === 'string' ? parseFloat(v) : Number(v);
export function flightCategory(ceilFt, visSm) {
  if ((ceilFt != null && ceilFt < 500) || (visSm != null && visSm < 1)) return 'LIFR';
  if ((ceilFt != null && ceilFt < 1000) || (visSm != null && visSm < 3)) return 'IFR';
  if ((ceilFt != null && ceilFt <= 3000) || (visSm != null && visSm <= 5)) return 'MVFR';
  return 'VFR';
}
const CAT_RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
export function tafTimeline(taf, fromMs, hours = 12) {
  const periods = (taf.fcsts || []).map(f => ({ ...f, from: f.timeFrom * 1000, to: f.timeTo * 1000 }));
  const state = p => ({ windDir: p.wdir ?? null, windKt: p.wspd ?? null, gustKt: p.wgst ?? null, visSm: visNum(p.visib), ceilFt: cloudCeil(p.clouds, p.vertVis), wx: p.wxString && p.wxString !== 'NSW' ? p.wxString : '' });
  const out = [];
  const start = Math.floor(fromMs / 3600000) * 3600000;
  for (let k = 0; k < hours; k++) {
    const t = start + k * 3600000, mid = t + 1800000;
    let prev = null;
    for (const p of periods) {
      if (p.fcstChange === 'TEMPO' || p.fcstChange === 'PROB' || p.from > mid) continue;
      const st = state(p);
      if (!prev || !p.fcstChange || p.fcstChange === 'FM') prev = st;
      else prev = Object.fromEntries(Object.entries(st).map(([k2, v]) => [k2, v == null || v === '' ? prev[k2] : v])); // BECMG keeps what it doesn't change
    }
    if (!prev) { out.push({ t: new Date(t).toISOString(), cat: null }); continue; }
    const row = { t: new Date(t).toISOString(), ...prev, cat: flightCategory(prev.ceilFt, prev.visSm) };
    let alt = null;
    for (const p of periods) {
      if ((p.fcstChange !== 'TEMPO' && p.fcstChange !== 'PROB') || p.from > mid || p.to <= mid) continue;
      const st = state(p), ceil = st.ceilFt ?? prev.ceilFt, vis = st.visSm ?? prev.visSm, cat = flightCategory(ceil, vis);
      const cand = { kind: p.fcstChange === 'PROB' ? 'PROB' + (p.probability || '') : 'TEMPO', cat, wx: st.wx, gustKt: st.gustKt };
      if (!alt || CAT_RANK[cat] > CAT_RANK[alt.cat] || (/TS/.test(cand.wx) && !/TS/.test(alt.wx || ''))) alt = cand;
    }
    if (alt && (CAT_RANK[alt.cat] > CAT_RANK[row.cat] || /TS/.test(alt.wx || '') || (alt.gustKt || 0) > (row.gustKt || 0) + 10)) row.alt = alt;
    out.push(row);
  }
  return out;
}
async function fetchTaf() {
  const ids = AIRPORTS.map(a => a.icao).join(',');
  const arr = await (await get(`https://aviationweather.gov/api/data/taf?ids=${ids}&format=json`)).json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('no forecasts returned');
  const now = Date.now(), airports = {};
  for (const t of arr) {
    const ap = AIRPORTS.find(a => a.icao === t.icaoId); if (!ap) continue;
    if (airports[ap.iata] && airports[ap.iata].issued > t.issueTime) continue;
    airports[ap.iata] = { issued: t.issueTime, raw: t.rawTAF, hours: tafTimeline(t, now, 12) };
  }
  return { data: { airports } };
}

async function fetchEmergencies() {
  const lists = await Promise.all(['7700', '7600', '7500'].map(sq =>
    get(`https://api.adsb.lol/v2/sqk/${sq}`, { timeout: 6000 }).then(r => r.json()).then(j => (j.ac || []).map(a => ({ ...a, sq })))));
  const items = lists.flat().filter(a => a.lat != null && a.alt_baro !== 'ground').map(a => ({
    code: a.sq, callsign: String(a.flight || a.r || a.hex).trim(), type: a.t || null,
    lat: +(+a.lat).toFixed(2), lon: +(+a.lon).toFixed(2), alt: typeof a.alt_baro === 'number' ? a.alt_baro : null, region: regionName(+a.lon, +a.lat),
  }));
  return { data: { items } };
}

// ---------------------------------------------------------------- Snapshot
// openskyTimeout: short when a visitor is waiting (page request), longer in the
// scheduled job, which can run for up to 30 seconds.
// Bump when the snapshot format changes, so stored snapshots from older code
// are rebuilt instead of served.
export const SNAPSHOT_VERSION = 10;
export async function buildSnapshot({ openskyTimeout = 5000 } = {}) {
  const t0 = Date.now();
  const [opensky, adsblol, faa, metar, sigmet, openmeteo, kp, hubTraffic, emergencies, usHubWx, faaAdvisories, taf] = await Promise.all([
    feed('opensky', () => fetchOpenSky(openskyTimeout)), feed('adsblol', fetchAdsbLol), feed('faa', fetchFaa), feed('metar', fetchMetar), feed('sigmet', fetchSigmets),
    feed('openmeteo', fetchOpenMeteo), feed('kp', fetchKp), feed('hubTraffic', fetchHubTraffic), feed('emergencies', fetchEmergencies), feed('usHubWx', fetchUsHubWeather), feed('faaAdvisories', fetchFaaAdvisories), feed('taf', fetchTaf),
  ]);
  return {
    version: SNAPSHOT_VERSION, generatedAt: new Date().toISOString(), buildMs: Date.now() - t0,
    airports: AIRPORTS,
    feeds: { opensky, adsblol, faa, metar, sigmet, openmeteo, kp, hubTraffic, emergencies, usHubWx, faaAdvisories, taf,
      eurocontrol: { ok: false, fetchedAt: null, sourceTime: null, error: 'not connected', note: 'EUROCONTROL flow data needs an approved B2B account; no free public feed exists.', data: null } },
  };
}

// Keep the last good copy of any feed that failed this time, with its original
// timestamps, so the page can show its true age instead of a blank or a fake.
export function mergeWithPrevious(next, prev) {
  if (!prev?.feeds) return next;
  for (const [k, f] of Object.entries(next.feeds)) {
    const old = prev.feeds[k];
    if (!f.ok && old?.data) next.feeds[k] = { ...old, ok: false, error: f.error, lastAttempt: f.fetchedAt, carriedOver: true };
  }
  return next;
}

// Compact row for the long-term history (raw inputs, so any future SFI formula
// can be recomputed and tested against FAA disruptions).
export function historyRow(s) {
  const f = s.feeds, cats = {};
  for (const r of f.metar.data?.reports || []) cats[r.fltCat || 'NA'] = (cats[r.fltCat || 'NA'] || 0) + 1;
  const fresh = k => f[k].ok && !f[k].carriedOver;
  return {
    t: s.generatedAt,
    scores: s.scores ? { ...s.scores, airports: s.scores.airports ? Object.fromEntries(Object.entries(s.scores.airports).map(([k, v]) => [k, v.p])) : null, outlook: s.scores.outlook ? { p3big: s.scores.outlook.p3big, p3: s.scores.outlook.p3, typical: s.scores.outlook.typical, features: { usHubStressNext3: s.scores.outlook.features.usHubStressNext3, usStorms: s.scores.outlook.features.usStorms, persist: s.scores.outlook.features.persist } } : null } : null,
    adsblol: f.adsblol && fresh('adsblol') ? f.adsblol.data.airborne : null,
    aircraft: fresh('opensky') ? f.opensky.data.airborne : null,
    cruise: fresh('opensky') ? f.opensky.data.cruise : null,
    faa: fresh('faa') ? { gs: f.faa.data.groundStops.length, gdp: f.faa.data.groundDelays.length, afp: f.faa.data.airspaceFlows.length, ad: f.faa.data.arrDepDelays.length, load: f.faa.data.programLoad, airports: f.faa.data.affectedAirports } : null,
    metarCats: fresh('metar') ? cats : null,
    sigmets: fresh('sigmet') ? f.sigmet.data.counts : null,
    kp: fresh('kp') ? f.kp.data.kp : null,
    wx: fresh('openmeteo') ? f.openmeteo.data.raw.map(p => ({ g: p.current?.wind_gusts_10m ?? null, c: p.current?.weather_code ?? null, p: p.current?.precipitation ?? null })) : null,
  };
}
