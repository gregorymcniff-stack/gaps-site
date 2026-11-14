// GAPS dashboard. Reads one snapshot from the GAPS server (/api/live), stored
// readings (/api/history) and the published test results. The browser never
// calls the data feeds itself and never fills gaps with made-up values.
'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pct = p => Number.isFinite(p) ? Math.round(p * 100) + '%' : '--';
const utc = t => { const d = new Date(t); return isNaN(d) ? '--' : String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC'; };
const fmtMin = m => !Number.isFinite(m) ? '?' : m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'm';

let SNAP = null, SNAP_ERR = null, HIST = [], TRACK = null, LAND = null, HUBS = [], MODEL = null;
let OPEN_AP = null, LAST_FOCUS = null; // airport detail panel
let GL = null, GL_READY = false;      // zoomable map (MapLibre)

// ---------------------------------------------------------------- typical values and status labels
// Index inputs are compared with 120 days of history (from the backtest);
// everything else with GAPS's own saved readings once there are enough.
function setStatus(el, cls, text) { const st = el.querySelector('.st'); if (st) { st.className = 'pill st ' + cls; st.textContent = text; } }
function setTyp(el, html) { const t = el.querySelector('.typ'); if (t) t.innerHTML = html; }
const band = (v, p75, p90) => v > p90 ? ['high', 'Elevated'] : v > p75 ? ['above', 'Above normal'] : ['normal', 'Normal'];
function histStats(key) {
  const rows = HIST.filter(r => Number.isFinite(r[key]));
  if (rows.length < 12) return null; // about 2 hours of readings
  const v = rows.map(r => r[key]).sort((a, b) => a - b), q = f => v[Math.min(v.length - 1, Math.floor(v.length * f))];
  return { n: v.length, p50: q(0.5), p75: q(0.75), p90: q(0.9), hours: Math.max(1, Math.round((Date.now() - Date.parse(rows[0].t)) / 3600000)) };
}
const collecting = 'Typical value: building from saved readings (needs about 2 hours).';
function compareToHistory(el, key, now, fmt = x => x) {
  const h = histStats(key);
  if (!h || !Number.isFinite(now)) { setStatus(el, 'none', '--'); setTyp(el, collecting); return; }
  const [c, t] = band(now, h.p75, h.p90);
  // a reading equal to the median is normal even when the spread is tiny
  setStatus(el, now <= h.p50 ? 'normal' : c, now <= h.p50 ? 'Normal' : t);
  setTyp(el, `Typical over the last ${h.hours} h: <b>${fmt(h.p50)}</b> · above normal over ${fmt(h.p75)} · elevated over ${fmt(h.p90)}`);
}

// ---------------------------------------------------------------- freshness
const MAX_AGE = { taf: 120, hubTraffic: 30, faaAdvisories: 30, usHubWx: 90, faa: 25, opensky: 25, adsblol: 25, metar: 90, sigmet: 60, openmeteo: 90, kp: 240, emergencies: 30 };
const LABEL = { faaAdvisories: 'FAA advisories', usHubWx: 'Hub forecast', faa: 'FAA status', traffic: 'Aircraft', metar: 'METARs', sigmet: 'SIGMETs', kp: 'Space weather' };
const feed = k => (SNAP && SNAP.feeds && SNAP.feeds[k]) || null;
const ageMin = k => { const f = feed(k); return f && f.data && f.fetchedAt ? (Date.now() - Date.parse(f.fetchedAt)) / 60000 : Infinity; };
const fresh = k => ageMin(k) <= (MAX_AGE[k] || 30);
const trafficKey = () => fresh('opensky') ? 'opensky' : fresh('adsblol') ? 'adsblol' : null;
const asOf = k => { const f = feed(k); if (!f || !f.data) return 'no data'; return (fresh(k) ? 'as of ' : 'out of date · last ') + utc(f.fetchedAt); };

// ---------------------------------------------------------------- header and status line
function renderHeader() {
  const idx = fresh('usHubWx') && fresh('faaAdvisories');
  const core = ['faa', 'metar'].filter(fresh).length + (trafficKey() ? 1 : 0);
  const pill = $('livePill');
  pill.className = 'livepill' + (idx && core === 3 ? '' : idx || core ? ' partial' : ' down');
  $('liveText').textContent = !SNAP ? (SNAP_ERR ? 'DATA SERVER UNREACHABLE' : 'CONNECTING') : idx && core === 3 ? 'LIVE DATA' : idx || core ? 'PARTIAL DATA' : 'NO LIVE DATA';
  const tk = trafficKey();
  $('acCount').textContent = tk ? feed(tk).data.airborne.toLocaleString() : '--';
  $('acLabel').textContent = 'Aircraft tracked' + (tk ? (tk === 'adsblol' ? ' · adsb.lol' : ' · OpenSky') : '');
  const keys = ['faaAdvisories', 'usHubWx', 'faa', 'traffic', 'metar', 'sigmet', 'kp'];
  const html = keys.map(k => {
    const kk = k === 'traffic' ? (trafficKey() || 'adsblol') : k;
    const ok = k === 'traffic' ? !!trafficKey() : fresh(k);
    const f = feed(kk), has = f && f.data;
    const isBackup = k === 'faaAdvisories' && f && f.source === 'nas-status-backup';
    const cls = isBackup ? 'stale' : ok ? 'ok' : has ? 'stale' : 'off';
    const age = has ? Math.round((Date.now() - Date.parse(f.fetchedAt)) / 60000) : null;
    return `<span class="feed ${cls}" title="${esc(LABEL[k])}: ${ok ? 'live' : has ? 'out of date' : 'unavailable'}"><i></i>${esc(LABEL[k])}${isBackup ? ' (backup)' : ''}${age != null ? ' ' + (age < 1 ? 'now' : age + 'm') : ' ·  off'}</span>`;
  }).join('') + '<span class="feed off" title="Needs an approved EUROCONTROL account"><i></i>Europe off</span>' +
    `<span class="updated">${SNAP && SNAP.generatedAt ? 'Server snapshot ' + utc(SNAP.generatedAt) + ' (' + localTime(SNAP.generatedAt) + ' your time)' : ''}${SNAP_ERR ? ' · cannot reach the data server' : ''}</span>`;
  $('feeds').innerHTML = html;
}
const localTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
function tick() {
  const d = new Date();
  $('clock').textContent = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0');
  $('localClock').textContent = 'Your time ' + localTime(d);
}

// ---------------------------------------------------------------- outlook
const LEVELS = [[0.5, 'High', 'high', '#b91c1c'], [0.25, 'Elevated', 'elevated', '#c2410c'], [0.10, 'Moderate', 'moderate', '#b45309'], [0, 'Low', 'low', '#15803d']];
const level = p => LEVELS.find(l => p >= l[0]);
const DRIVER = { persist: 'Recent FAA programs', usHubStressNext3: 'US hub weather', tod: 'Time of day', usStorms: 'Hub thunderstorms' };
function outlookNow() { const O = SNAP && SNAP.scores && SNAP.scores.outlook; return O && fresh('usHubWx') && fresh('faaAdvisories') ? O : null; }

function renderOutlook() {
  const O = outlookNow();
  if (!O) {
    $('sfi').textContent = '--'; $('meter').style.width = '0';
    $('level').className = 'pill none'; $('level').textContent = SNAP ? 'Unavailable' : 'Loading';
    $('typical').textContent = '--'; $('trend').textContent = '';
    $('lede').textContent = SNAP ? 'The outlook is unavailable right now: it needs live FAA advisories and the US hub forecast. The other panels still show live data.' : (SNAP_ERR ? 'Cannot reach the GAPS data server. Retrying every 2 minutes.' : 'Loading live data…');
    $('drivers').innerHTML = ''; $('anyProgram').textContent = '';
    return;
  }
  const p = O.p3big, sfi = Math.round(p * 100), L = level(p), F = O.features;
  $('sfi').textContent = sfi;
  const m = $('meter'); m.style.width = clamp(sfi, 2, 100) + '%'; m.style.background = L[3];
  $('level').className = 'pill ' + L[2]; $('level').textContent = L[1];
  $('typical').textContent = pct(O.typical);
  const hist = HIST.filter(r => Number.isFinite(r.sfi));
  const ago = hist.slice().reverse().find(r => Date.now() - Date.parse(r.t) >= 50 * 60000);
  $('trend').textContent = ago ? (sfi - ago.sfi > 2 ? '↑ ' : sfi - ago.sfi < -2 ? '↓ ' : '→ ') + (sfi - ago.sfi > 0 ? '+' : '') + (sfi - ago.sfi) + ' points vs 1 hour ago' : '';
  const rp = F.recentPrograms || [];
  const airports = [...new Set(rp.map(x => x.airport))].slice(0, 4).join(', ');
  // Compare with the usual chance for this hour in percentage points, so a
  // small change at a quiet hour doesn't sound alarming ("8 times the usual").
  const diff = Math.round((p - O.typical) * 100);
  const vs = diff >= 15 ? `, well above the usual ${pct(O.typical)} for this hour` : diff >= 5 ? `, above the usual ${pct(O.typical)} for this hour`
    : diff <= -5 ? `, below the usual ${pct(O.typical)} for this hour` : `, close to the usual ${pct(O.typical)} for this hour`;
  $('lede').textContent = `${pct(p)} chance of a rough next 3 hours at US airports${vs}. ` +
    (F.persist ? `${F.persist} new FAA program${F.persist > 1 ? 's' : ''} in the last ~3 hours (${airports}).` : 'No new FAA programs in the last ~3 hours.') +
    (F.usStorms ? ` Thunderstorms forecast at ${F.stormHubs.join(', ')}.` : '');
  const C = O.contributions || {};
  $('drivers').innerHTML = ['persist', 'usHubStressNext3', 'tod'].filter(k => k in C).map(k => {
    const c = C[k] || 0, w = clamp(Math.abs(c) / 2.5 * 50, 0, 50);
    const style = c >= 0 ? `left:50%;width:${w}%;background:#b91c1c` : `left:${50 - w}%;width:${w}%;background:#15803d`;
    const shown = Math.abs(c) < 0.05 ? '0.0' : (c > 0 ? '+' : '−') + Math.abs(c).toFixed(1);
    return `<div class="drv"><span>${DRIVER[k]}</span><span class="bar"><span style="${style}"></span></span><span class="val">${shown}</span></div>`;
  }).join('');
  $('anyProgram').textContent = `At least one new program: ${pct(O.p3)}.`;
  spark($('outlookCard'), 'sfi', '#0b2a4a', '%');
}

// ---------------------------------------------------------------- FAA
function renderFaa() {
  const f = feed('faa'), d = f && f.data;
  const now = $('faaNow'), rec = $('faaRecent');
  if (!d) { $('faaSummary').textContent = 'No live FAA status data.'; now.innerHTML = ''; }
  else {
    const items = [];
    d.groundStops.forEach(p => items.push(['high', p.airport, 'Ground stop', [p.reason, p.endTime && 'until ' + p.endTime].filter(Boolean).join(' · ')]));
    d.closures.filter(c => c.full).forEach(p => items.push(['high', p.airport, 'Airport closed', p.reopen ? 'reopens ' + p.reopen : '']));
    d.groundDelays.slice().sort((a, b) => (b.avgMin || 0) - (a.avgMin || 0)).forEach(p => items.push([(p.avgMin || 0) >= 60 ? 'high' : '', p.airport, 'Ground delay program · avg ' + fmtMin(p.avgMin) + (p.maxMin ? ', max ' + fmtMin(p.maxMin) : ''), p.reason]));
    d.airspaceFlows.forEach(p => items.push(['', p.element || 'AFP', 'Airspace flow program' + (p.avgMin ? ' · avg ' + fmtMin(p.avgMin) : ''), p.reason]));
    d.arrDepDelays.forEach(p => { const l = (p.legs || [])[0] || {}; items.push(['', p.airport, (l.type ? l.type + ' delays ' : 'Delays ') + fmtMin(l.minMin) + '–' + fmtMin(l.maxMin), l.trend ? l.trend.toLowerCase() : p.reason]); });
    $('faaSummary').textContent = (items.length ? items.length + ' active US initiative' + (items.length > 1 ? 's' : '') : 'No ground stops or delay programs in effect') + ' · ' + asOf('faa');
    now.innerHTML = items.length ? items.map(([c, ap, what, why]) => `<li class="${c}"><b>${esc(ap)}</b><span><span class="what">${esc(what)}</span>${why ? `<br><span class="why">${esc(why)}</span>` : ''}</span></li>`).join('') : '<li class="empty" style="display:block">None right now.</li>';
  }
  const O = SNAP && SNAP.scores && SNAP.scores.outlook;
  const rp = O && fresh('faaAdvisories') ? (O.features.recentPrograms || []) : null;
  rec.innerHTML = rp == null ? '<li class="empty" style="display:block">No live advisory data.</li>' : rp.length ?
    rp.slice(0, 6).map(p => `<li><b>${esc(p.airport)}</b><span class="what">${p.type === 'GS' ? 'Ground stop' : 'Ground delay program'} <span class="why">· ${utc(p.sent)}</span></span></li>`).join('') + (rp.length > 6 ? `<li class="empty" style="display:block">and ${rp.length - 6} more</li>` : '') :
    '<li class="empty" style="display:block">None.</li>';
  const backup = feed('faaAdvisories') && feed('faaAdvisories').source === 'nas-status-backup';
  $('faaSrc').textContent = 'Sources: FAA NAS Status (' + asOf('faa') + ') · ' + (backup ? 'BACKUP IN USE: the ATCSCC advisory database could not be read, so recent programs are taken from changes in FAA NAS Status (may miss very short ground stops)' : 'ATCSCC advisory database (' + asOf('faaAdvisories') + ')');
}

// ---------------------------------------------------------------- tiles
function spark(el, key, color, unit = '') {
  const box = el.querySelector('.spark'); if (!box) return;
  const pts = HIST.map(r => [Date.parse(r.t), r[key]]).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (pts.length < 3) { box.innerHTML = `<div class="n">24-hour trend: ${pts.length ? pts.length + ' readings saved so far' : 'collecting'}</div>`; return; }
  const W = 200, H = 36, t1 = Date.now(), t0 = t1 - 864e5, vals = pts.map(p => p[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals); if (hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }
  const X = t => ((t - t0) / (t1 - t0) * W).toFixed(1), Y = v => (H - 3 - (v - lo) / (hi - lo) * (H - 6)).toFixed(1);
  let d = '', prev = null; pts.forEach(([t, v]) => { d += (prev && t - prev < 25 * 60e3 ? 'L' : 'M') + X(t) + ' ' + Y(v) + ' '; prev = t; });
  const last = pts[pts.length - 1];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/><circle cx="${X(last[0])}" cy="${Y(last[1])}" r="2.2" fill="${color}"/></svg><div class="n">Last 24 h · range ${Math.min(...vals)}–${Math.max(...vals)}${unit}</div>`;
}
function setTile(id, value, desc, live) {
  const el = $(id); el.classList.toggle('nodata', !live);
  el.querySelector('.v').innerHTML = value; if (desc != null) el.querySelector('.d').textContent = desc;
  return el;
}
function renderTiles() {
  const O = outlookNow(), F = O && O.features;
  const S = MODEL && MODEL.stats;
  const tHub = setTile('tHub', F ? F.usHubStressNext3.toFixed(1) + '<small> pts</small>' : '--',
    F ? `Worst of the next 3 h at 15 hubs${F.usStorms ? ' · storms at ' + F.stormHubs.join(', ') : ''} · ${asOf('usHubWx')}` : 'No live hub forecast', !!F);
  const tRec = setTile('tRecent', F ? F.persist + '<small> new</small>' : '--',
    F ? `Started in the current and previous two hours · ${asOf('faaAdvisories')}` : 'No live FAA advisories', !!F);
  [[tHub, 'usHubStressNext3', F && F.usHubStressNext3, x => x.toFixed(1)], [tRec, 'persist', F && F.persist, x => String(x)]].forEach(([el, k, v, fmt]) => {
    const st = S && S[k];
    if (!st || !F) { setStatus(el, 'none', '--'); setTyp(el, ''); return; }
    const [c, t] = band(v, st.p75, st.p90); setStatus(el, c, t);
    setTyp(el, `Typical (Jul–Nov): <b>${fmt(st.p50)}</b> · above normal over ${fmt(st.p75)} · elevated over ${fmt(st.p90)}`);
  });
  spark(tHub, 'hubWx', '#b45309'); spark(tRec, 'persist', '#b91c1c');
  const d = new Date();
  setTile('tTypical', O ? Math.round(O.typical * 100) + '<small>%</small>' : '--',
    O ? `Chance at ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC on a ${d.getUTCDay() % 6 === 0 ? 'weekend' : 'weekday'} with average weather and activity` : 'Chance at this hour with average conditions', !!O);
  const el = $('tTrack');
  if (TRACK) {
    const P = TRACK.predictors, rows = [['model', 'This index', 'main'], ['tod', 'Time of day only'], ['persist', 'Recent programs only'], ['sfi2', 'Old index']];
    el.querySelector('.v').innerHTML = P.model.y3big.aucTest.toFixed(2) + '<small> / 1.00</small>';
    el.querySelector('.d').innerHTML = `Held-out weeks ${TRACK.testStart.slice(5, 10)} to ${TRACK.period.end.slice(5, 10)} · 0.5 = coin flip · <a href="method.html">method</a>`;
    el.querySelector('.tr').innerHTML = rows.map(([k, l, c]) => { const a = P[k].y3big.aucTest; return `<div class="${c || ''}"><span>${l}</span><span class="b"><i style="width:${clamp((a - 0.4) / 0.6 * 100, 2, 100)}%"></i></span><span class="num">${a.toFixed(2)}</span></div>`; }).join('');
  }
}

// ---------------------------------------------------------------- context
function ctx(id, v, d, list) { const el = $(id); el.querySelector('.v').innerHTML = v; el.querySelector('.d').textContent = d; const l = el.querySelector('.list'); if (l) l.innerHTML = list || ''; }
function renderContext() {
  const tk = trafficKey();
  if (tk) {
    const a = feed(tk).data, regions = Object.entries(a.regions || {}).filter(([k]) => k !== 'Other').sort((x, y) => y[1] - x[1]).slice(0, 3);
    ctx('cAir', a.airborne.toLocaleString(), (tk === 'adsblol' ? 'Tracked worldwide by adsb.lol volunteer receivers' : 'Airborne, seen by OpenSky receivers') + ' · ' + asOf(tk),
      regions.length ? (tk === 'adsblol' ? '<span class="sub">Busiest regions (common airliner types):</span>' : '<span class="sub">Busiest regions:</span>') + regions.map(([k, n]) => `<div>${esc(k)} · ${n.toLocaleString()}</div>`).join('') : '');
  } else ctx('cAir', '--', 'No live aircraft data', '');
  { const el = $('cAir'), h = histStats('aircraft'); setStatus(el, 'none', 'Context');
    setTyp(el, h ? `Range over the last ${h.hours} h: <b>${HIST.map(r => r.aircraft).filter(Number.isFinite).reduce((a, b) => Math.min(a, b)).toLocaleString()}–${HIST.map(r => r.aircraft).filter(Number.isFinite).reduce((a, b) => Math.max(a, b)).toLocaleString()}</b> (follows the time of day)` : collecting); }
  const m = feed('metar');
  if (fresh('metar')) {
    const r = m.data.reports, low = r.filter(x => x.fltCat === 'IFR' || x.fltCat === 'LIFR'), ts = r.filter(x => /TS/.test(x.wx || ''));
    ctx('cWx', low.length + ts.length ? (low.length + ts.length) + '<span class="sub"> of ' + r.length + ' airports</span>' : 'All clear', 'Thunderstorms or instrument conditions in live METARs · ' + asOf('metar'),
      [...ts.map(x => `<div><b class="mono">${esc(x.iata)}</b> thunderstorm</div>`), ...low.map(x => `<div><b class="mono">${esc(x.iata)}</b> ${esc(x.fltCat)} (low cloud or visibility)</div>`)].join('') || '<div>No thunderstorms or instrument conditions at the 23 monitored airports.</div>');
  } else ctx('cWx', '--', 'No live airport weather', '');
  { const r = fresh('metar') ? feed('metar').data.reports : null;
    compareToHistory($('cWx'), 'ifr', r ? r.filter(x => x.fltCat === 'IFR' || x.fltCat === 'LIFR').length : NaN);
    const t = $('cWx').querySelector('.typ'); if (t && histStats('ifr')) t.innerHTML = t.innerHTML.replace('Typical over', 'Airports in IFR or LIFR, typical over'); }
  if (fresh('sigmet')) {
    const c = feed('sigmet').data.counts || {}, names = { TS: 'Thunderstorm', TURB: 'Turbulence', ICE: 'Icing', VA: 'Volcanic ash', MTW: 'Mountain wave', TC: 'Tropical cyclone' };
    ctx('cSig', String(Object.values(c).reduce((a, b) => a + b, 0)), 'Active SIGMETs worldwide · ' + asOf('sigmet'), Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div>${esc(names[k] || k)} · ${n}</div>`).join(''));
  } else ctx('cSig', '--', 'No live SIGMET data', '');
  compareToHistory($('cSig'), 'sig', fresh('sigmet') ? Object.values(feed('sigmet').data.counts || {}).reduce((a, b) => a + b, 0) : NaN);
  if (fresh('emergencies')) {
    const em = feed('emergencies').data.items;
    ctx('cSqk', String(em.length), 'Aircraft broadcasting 7700, 7600 or 7500 · transponder codes, not confirmed incidents · ' + asOf('emergencies'),
      em.slice(0, 5).map(a => `<div><b class="mono">${esc(a.callsign)}</b> ${esc(a.code)} · ${esc(a.region)}</div>`).join(''));
  } else ctx('cSqk', '--', 'No live squawk data', '');
  { const el = $('cSqk'), n = fresh('emergencies') ? feed('emergencies').data.items.length : null;
    if (n == null) setStatus(el, 'none', '--'); else setStatus(el, n ? 'above' : 'normal', n ? 'Active' : 'None');
    setTyp(el, ''); }
  if (fresh('kp')) { const kp = feed('kp').data.kp; ctx('cKp', 'Kp ' + kp.toFixed(1), (kp >= 5 ? 'Geomagnetic storm: HF radio on polar and oceanic routes may degrade' : 'Quiet to unsettled') + ' · NOAA · ' + asOf('kp')); }
  else ctx('cKp', '--', 'No live NOAA data');
  { const el = $('cKp'), kp = fresh('kp') ? feed('kp').data.kp : null;
    if (kp == null) setStatus(el, 'none', '--'); else { const [c, t] = kp >= 5 ? ['high', 'Storm'] : kp >= 4 ? ['above', 'Active'] : ['normal', 'Quiet']; setStatus(el, c, t); }
    setTyp(el, 'Typical: <b>Kp 1–3</b> · active at 4 · storm at 5 or more (NOAA scale)'); }
}

// ---------------------------------------------------------------- map
function hubStatus(a) {
  const f = fresh('faa') && feed('faa').data, mt = fresh('metar') && feed('metar').data;
  const out = { status: f || mt ? 'normal' : 'unknown', label: a.iata, lines: [] };
  if (f) {
    const gs = f.groundStops.find(p => p.airport === a.iata), cl = f.closures.find(p => p.airport === a.iata && p.full);
    const gd = f.groundDelays.find(p => p.airport === a.iata), ad = f.arrDepDelays.find(p => p.airport === a.iata);
    if (gs) { out.status = 'high'; out.label += ' ground stop'; out.lines.push('FAA ground stop' + (gs.reason ? ': ' + gs.reason : '')); }
    else if (cl) { out.status = 'high'; out.label += ' closed'; out.lines.push('Airport closed'); }
    else if (gd) { out.status = (gd.avgMin || 0) >= 60 ? 'high' : 'watch'; out.label += ' delays ' + fmtMin(gd.avgMin); out.lines.push('Ground delay program, avg ' + fmtMin(gd.avgMin) + (gd.reason ? ' (' + gd.reason + ')' : '')); }
    else if (ad) { out.status = 'watch'; out.label += ' delays'; out.lines.push('Arrival/departure delays'); }
  }
  const r = mt && mt.reports.find(x => x.iata === a.iata);
  if (r) {
    out.metar = r;
    if (out.status === 'normal') {
      if (r.fltCat === 'LIFR') { out.status = 'high'; out.label += ' LIFR'; }
      else if (/TS/.test(r.wx || '')) { out.status = 'watch'; out.label += ' storms'; }
      else if (r.fltCat === 'IFR') { out.status = 'watch'; out.label += ' IFR'; }
    }
  }
  return out;
}
const LATN = 80, LATS = -58, SPAN = LATN - LATS;
let MAPGEOM = null;
function drawMap() {
  const c = $('map'), rect = c.getBoundingClientRect(); if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1; c.width = rect.width * dpr; c.height = rect.height * dpr;
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = rect.width, H = rect.height, MW = Math.min(W, H * 360 / SPAN), MH = MW * SPAN / 360, OX = (W - MW) / 2, OY = (H - MH) / 2;
  const x = lon => OX + (lon + 180) / 360 * MW, y = lat => OY + (LATN - lat) / SPAN * MH;
  MAPGEOM = { x, y };
  ctx.fillStyle = '#f4f8fc'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e3ebf3'; ctx.lineWidth = 1;
  for (let lon = -150; lon < 180; lon += 30) { ctx.beginPath(); ctx.moveTo(x(lon), y(LATN)); ctx.lineTo(x(lon), y(LATS)); ctx.stroke(); }
  for (let lat = -30; lat <= 60; lat += 30) { ctx.beginPath(); ctx.moveTo(x(-180), y(lat)); ctx.lineTo(x(180), y(lat)); ctx.stroke(); }
  ctx.save(); ctx.beginPath(); ctx.rect(x(-180), y(LATN), MW, MH); ctx.clip();
  ctx.fillStyle = '#dfe8f1'; ctx.strokeStyle = '#c3d2e1';
  (LAND || []).forEach(poly => { ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))); ctx.closePath(); ctx.fill(); ctx.stroke(); });
  const tk = trafficKey(), dens = tk && feed(tk).data.density;
  if (dens && dens.length) {
    const cell = feed(tk).data.densityCellDeg || 3, cw = MW * cell / 360, ch = MH * cell / SPAN, lmax = Math.log(1 + Math.max(...dens.map(d => d[2])));
    dens.forEach(([i, j, n]) => { ctx.fillStyle = `rgba(29,78,216,${(0.10 + 0.5 * Math.log(1 + n) / lmax).toFixed(3)})`; ctx.fillRect(x(i * cell - 180), y(j * cell - 90 + cell), cw + 0.5, ch + 0.5); });
  }
  const hz = { TS: '234,88,12', TURB: '124,58,237', ICE: '2,132,199', VA: '71,85,105' };
  if (fresh('sigmet')) feed('sigmet').data.items.forEach(s => { const col = hz[s.hazard] || '100,116,139'; ctx.beginPath(); ctx.fillStyle = `rgba(${col},.2)`; ctx.arc(x(s.lon), y(s.lat), 8, 0, 7); ctx.fill(); ctx.beginPath(); ctx.fillStyle = `rgba(${col},.9)`; ctx.arc(x(s.lon), y(s.lat), 2.4, 0, 7); ctx.fill(); });
  if (fresh('emergencies')) feed('emergencies').data.items.forEach(a => { const X = x(a.lon), Y = y(a.lat); ctx.beginPath(); ctx.fillStyle = '#b91c1c'; ctx.moveTo(X, Y - 7); ctx.lineTo(X + 6, Y + 5); ctx.lineTo(X - 6, Y + 5); ctx.closePath(); ctx.fill(); });
  ctx.restore();
  // airports: disrupted ones last (on top); labels avoid overlap
  const col = { high: '#b91c1c', watch: '#b45309', normal: '#15803d', unknown: '#94a3b8' }, rank = { unknown: 0, normal: 1, watch: 2, high: 3 };
  HUBS = ((SNAP && SNAP.airports) || []).map(a => ({ ...a, ...hubStatus(a), X: x(a.lon), Y: y(a.lat) })).sort((a, b) => rank[a.status] - rank[b.status]);
  HUBS.forEach(h => {
    const r = h.status === 'high' ? 6.5 : h.status === 'watch' ? 5.5 : 4;
    if (h.status === 'high') { ctx.beginPath(); ctx.strokeStyle = 'rgba(185,28,28,.35)'; ctx.lineWidth = 2; ctx.arc(h.X, h.Y, r + 6, 0, 7); ctx.stroke(); }
    ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(h.X, h.Y, r + 2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = col[h.status]; ctx.arc(h.X, h.Y, r, 0, 7); ctx.fill();
  });
  const boxes = [], small = W < 600;
  HUBS.slice().reverse().forEach(h => {
    if (h.status !== 'high' && h.status !== 'watch' && (small || !['JFK', 'ORD', 'LAX', 'ATL', 'LHR', 'FRA', 'DXB', 'SIN', 'HKG', 'NRT', 'SYD', 'GRU'].includes(h.iata))) return;
    const strong = h.status === 'high' || h.status === 'watch';
    ctx.font = (strong ? '600 ' : '500 ') + (small ? '10px ' : '11px ') + "'IBM Plex Sans',sans-serif";
    const t = small ? h.iata : h.label, w = ctx.measureText(t).width;
    for (const [lx, ly] of [[h.X + 8, h.Y - 6], [h.X + 8, h.Y + 14], [h.X - 8 - w, h.Y - 6], [h.X - 8 - w, h.Y + 14]]) {
      const b = { x: lx - 2, y: ly - 11, w: w + 4, h: 14 };
      if (b.x < 0 || b.x + b.w > W || boxes.some(o => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)) continue;
      boxes.push(b); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = h.status === 'high' ? '#991b1b' : h.status === 'watch' ? '#92400e' : '#0b2a4a'; ctx.fillText(t, lx, ly); break;
    }
  });
  if (!SNAP) { ctx.font = "600 13px 'IBM Plex Sans',sans-serif"; ctx.fillStyle = '#5b6b7c'; ctx.fillText(SNAP_ERR ? 'Live data unavailable' : 'Loading live data…', 16, 24); }
  const parts = [];
  if (tk) parts.push('Aircraft: ' + (tk === 'adsblol' ? 'positions of the 8 most common airliner types (adsb.lol)' : 'all aircraft seen by OpenSky') + ', ' + asOf(tk));
  if (fresh('sigmet')) parts.push('SIGMETs ' + asOf('sigmet'));
  $('mapFoot').textContent = (parts.join(' · ') || 'Live map data unavailable.') + ' · Hover for a summary; click an airport for full details.';
}
function showTip(ev) {
  if (!MAPGEOM) return;
  const c = $('map'), r = c.getBoundingClientRect(), mx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left, my = (ev.touches ? ev.touches[0].clientY : ev.clientY) - r.top;
  let best = null, bd = 14;
  HUBS.forEach(h => { const d = Math.hypot(h.X - mx, h.Y - my); if (d < bd) { bd = d; best = h; } });
  const tip = $('tip');
  if (!best) { tip.style.display = 'none'; return; }
  const m = best.metar;
  tip.innerHTML = `<b>${esc(best.iata)}</b> · ${esc(best.icao)}<br>${best.lines.length ? best.lines.map(esc).join('<br>') : best.status === 'unknown' ? 'No live data' : 'No FAA programs'}${m ? `<br>Weather: ${esc(m.fltCat || '?')}${m.wx ? ' · ' + esc(m.wx) : ''}${m.windKt != null ? ' · wind ' + m.windKt + (m.gustKt ? 'G' + m.gustKt : '') + ' kt' : ''}<div class="raw">${esc(m.raw)}</div>` : ''}`;
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = clamp(mx + 14, 4, r.width - tw - 4) + 'px';
  tip.style.top = clamp(my - th - 10, 4, r.height - th - 4) + 'px';
}

// ---------------------------------------------------------------- loading
async function getJSON(url, ms) {
  const opts = { cache: 'no-store' }; if (window.AbortSignal && AbortSignal.timeout) opts.signal = AbortSignal.timeout(ms);
  const r = await fetch(url, opts); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
}
function renderAll() { renderHeader(); renderOutlook(); renderFaa(); renderTiles(); renderContext(); if (GL_READY) updateGL(); else drawMap(); renderAirportOutlooks(); renderAirports(); }
async function refreshLive() {
  const first = !SNAP;
  try { const s = await getJSON('/api/live', 20000); if (!s || !s.feeds) throw new Error('unexpected response'); SNAP = s; SNAP_ERR = null; }
  catch (e) { SNAP_ERR = (e && e.message) || 'error'; }
  renderAll();
  if (first && SNAP) { const c = location.hash.slice(1).toUpperCase(); if (/^[A-Z]{3}$/.test(c)) openAirport(c); }
}
async function refreshHistory() {
  try { const h = await getJSON('/api/history?range=24h', 15000); HIST = Array.isArray(h.rows) ? h.rows : []; } catch (e) { /* trend lines show "collecting" */ }
  renderOutlook(); renderTiles(); renderContext();
}
function prepLand(rings) { // unwrap shapes that cross the 180° line and draw them on both sides
  const out = [];
  rings.forEach(r => { const u = []; let off = 0; r.forEach((p, i) => { if (i) { const d = p[0] + off - u[i - 1][0]; if (d > 180) off -= 360; else if (d < -180) off += 360; } u.push([p[0] + off, p[1]]); });
    out.push(u); const xs = u.map(p => p[0]); if (Math.max(...xs) > 180) out.push(u.map(p => [p[0] - 360, p[1]])); if (Math.min(...xs) < -180) out.push(u.map(p => [p[0] + 360, p[1]])); });
  return out;
}

tick(); setInterval(tick, 1000);
renderAll();
refreshLive(); setInterval(refreshLive, 120000);
refreshHistory(); setInterval(refreshHistory, 600000);
getJSON('data/backtest-results.json', 15000).then(j => { TRACK = j; renderTiles(); }).catch(() => {});
getJSON('data/sfi-model.json', 15000).then(j => { MODEL = j; renderTiles(); $('howBody').innerHTML = window.renderModelTable(j, { link: true }); }).catch(() => { $('howBody').textContent = 'Model details unavailable.'; });
getJSON('data/land-110m.json', 15000).then(d => { LAND = prepLand(d); drawMap(); }).catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshLive(); });
setInterval(renderHeader, 60000);
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawMap, 120); });
$('map').addEventListener('mousemove', showTip);
$('map').addEventListener('mouseleave', () => { $('tip').style.display = 'none'; });
$('map').addEventListener('touchstart', showTip, { passive: true });

// ---------------------------------------------------------------- airports list and detail panel
const CAT_TEXT = { VFR: 'VFR · good visibility and high cloud', MVFR: 'MVFR · cloud 1,000–3,000 ft or visibility 3–5 mi', IFR: 'IFR · cloud below 1,000 ft or visibility under 3 mi', LIFR: 'LIFR · cloud below 500 ft or visibility under 1 mi' };
const WMO = c => c >= 95 ? 'Thunderstorm' : c >= 85 ? 'Snow showers' : c >= 80 ? 'Rain showers' : c >= 71 ? 'Snow' : c >= 61 ? 'Rain' : c >= 51 ? 'Drizzle' : c >= 45 ? 'Fog' : c >= 1 ? 'Cloudy' : 'Clear';
function hubPointsAt(h, j) { // same scoring as the server's US hub weather
  const at = k => (h[k] && h[k][j] != null ? Number(h[k][j]) : null);
  const wc = at('weather_code') || 0, vis = at('visibility'), low = at('cloud_cover_low'), gust = at('wind_gusts_10m') || 0;
  let x = 0;
  if (wc >= 95) x += 3; else if (wc >= 61 && wc <= 82) x += 0.7; else if (wc >= 71 && wc <= 77) x += 1.5;
  if (vis != null && vis < 1600) x += 2; else if (vis != null && vis < 4800) x += 1;
  if (low != null && low >= 95) x += 0.6;
  if (gust >= 40) x += 1.5; else if (gust >= 30) x += 0.7;
  return x;
}
function renderAirports() {
  const list = ((SNAP && SNAP.airports) || []).map(a => ({ ...a, ...hubStatus(a) }));
  const rank = { high: 3, watch: 2, normal: 1, unknown: 0 };
  const chip = a => `<button type="button" class="ap s-${a.status}" data-ap="${esc(a.iata)}"><b>${esc(a.iata)}</b><span>${esc(a.status === 'high' || a.status === 'watch' ? a.label.slice(a.iata.length + 1) : a.status === 'unknown' ? 'no data' : (a.metar && a.metar.fltCat) ? a.metar.fltCat + ' · normal' : 'normal')}</span><span>${esc(a.name || '')}</span>${airportOutlook(a.iata) ? `<span>Next 3 h: <b class="mono">${pct(airportOutlook(a.iata).p)}</b></span>` : ''}</button>`;
  const sorted = list.slice().sort((x, y) => rank[y.status] - rank[x.status] || x.iata.localeCompare(y.iata));
  $('apUS').innerHTML = sorted.filter(a => a.region === 'US').map(chip).join('') || '<span class="sub">Loading…</span>';
  $('apIntl').innerHTML = sorted.filter(a => a.region !== 'US').map(chip).join('');
  if (OPEN_AP) openAirport(OPEN_AP, false);
}
function tafSection(iata) {
  const f = feed('taf'), t = f && f.data ? f.data.airports[iata] : null;
  if (!t) return '<div class="dr-sec"><h3>Next 12 hours · official forecast (TAF)</h3><p>No forecast available for this airport right now.</p></div>';
  const hrs = t.hours.filter(h => Date.parse(h.t) + 3600000 > Date.now()).slice(0, 12);
  const cells = hrs.map(h => `<div class="cat-${h.cat || 'none'}" title="${utc(h.t)}: ${h.cat || 'no forecast'}${h.wx ? ' · ' + esc(h.wx) : ''}${h.windKt != null ? ' · wind ' + h.windKt + (h.gustKt ? 'G' + h.gustKt : '') + ' kt' : ''}"></div>`).join('');
  const alts = hrs.map(h => h.alt ? `<div class="alt cat-${h.alt.cat}" title="${esc(h.alt.kind)}: ${h.alt.cat}${h.alt.wx ? ' · ' + esc(h.alt.wx) : ''}"></div>` : '<div class="alt alt-none"></div>').join('');
  const labels = hrs.map((h, i) => `<span>${i % 3 === 0 ? utc(h.t).slice(0, 2) + 'Z' : ''}</span>`).join('');
  // plain-language list of changes
  const ch = []; let prev = null;
  hrs.forEach(h => {
    const desc = `${h.cat || 'no forecast'}${h.wx ? ', ' + h.wx : ''}${h.gustKt ? ', gusts ' + h.gustKt + ' kt' : ''}`;
    if (!prev || desc !== prev) ch.push(`<li><b class="mono">${utc(h.t)}</b> ${esc(desc)}</li>`); prev = desc;
    if (h.alt) { const a = `<li><b class="mono">${utc(h.t)}</b> ${h.alt.kind.startsWith('PROB') ? h.alt.kind.slice(4) + '% chance of' : 'at times'} ${esc(h.alt.cat)}${h.alt.wx ? ', ' + esc(h.alt.wx) : ''}</li>`; if (!ch.includes(a)) ch.push(a); }
  });
  return `<div class="dr-sec"><h3>Next 12 hours · official forecast (TAF)</h3>
    <div class="tl">${cells}</div><div class="tl">${alts}</div><div class="tl-lbl">${labels}</div>
    <div class="tl-legend"><span><i class="cat-VFR"></i>VFR</span><span><i class="cat-MVFR"></i>MVFR</span><span><i class="cat-IFR"></i>IFR</span><span><i class="cat-LIFR"></i>LIFR</span><span>thin bar: temporary or possible spell</span></div>
    <ul class="changes">${ch.slice(0, 8).join('')}</ul>
    <div class="raw">${esc(t.raw)}</div><p class="sub">Issued ${utc(t.issued)} · NOAA Aviation Weather Center${fresh('taf') ? '' : ' · out of date'}</p></div>`;
}
function openAirport(iata, focus = true) {
  const a = ((SNAP && SNAP.airports) || []).find(x => x.iata === iata);
  if (!a) return;
  const s = hubStatus(a), m = s.metar, el = $('drawer');
  OPEN_AP = iata;
  const pill = s.status === 'high' ? ['high', 'Disrupted'] : s.status === 'watch' ? ['elevated', 'Delays or low cloud'] : s.status === 'normal' ? ['low', 'Normal'] : ['none', 'No data'];
  let html = `<div class="dr-h"><h2 id="drTitle">${esc(a.iata)}</h2><span class="ic">${esc(a.icao)}</span><span class="nm">${esc(a.name || '')}</span><span class="pill ${pill[0]}">${pill[1]}</span></div>`;
  html += `<div class="dr-sec"><h3>FAA status now</h3><p>${s.lines.length ? s.lines.map(esc).join('<br>') : a.region === 'US' ? (fresh('faa') ? 'No ground stops, delay programs or closures.' : 'No live FAA data.') : 'Outside the US: no FAA programs. Live delay data for this region is not available.'}</p></div>`;
  html += airportOutlookSection(iata);
  html += `<div class="dr-sec"><h3>Weather now (METAR)</h3>${m ? `<dl class="kv"><dt>Conditions</dt><dd>${esc(CAT_TEXT[m.fltCat] || m.fltCat || '?')}</dd>${m.wx ? `<dt>Weather</dt><dd>${esc(m.wx)}</dd>` : ''}<dt>Wind</dt><dd>${m.windKt != null ? m.windKt + ' kt' + (m.gustKt ? ', gusts ' + m.gustKt + ' kt' : '') : '?'}</dd><dt>Visibility</dt><dd>${m.visSm != null ? m.visSm + '+ mi'.slice(m.visSm >= 10 ? 0 : 1) : '?'}</dd><dt>Observed</dt><dd>${utc(m.obsTime)}</dd></dl><div class="raw">${esc(m.raw)}</div>` : '<p>No live weather report.</p>'}</div>`;
  html += tafSection(iata);
  const hw = fresh('usHubWx') && feed('usHubWx').data;
  if (hw && hw.hourly[iata]) {
    const h = hw.hourly[iata], start = Math.floor(Date.now() / 3600000) * 3600000;
    const rows = hw.times.map((t, j) => [t, j]).filter(([t]) => Date.parse(t + ':00Z') >= start).slice(0, 4)
      .map(([t, j]) => `<tr><td class="mono">${utc(t + ':00Z')}</td><td>${WMO(h.weather_code[j] || 0)}</td><td>${Math.round(h.wind_gusts_10m[j] || 0)} mph</td><td>${h.visibility[j] != null ? (h.visibility[j] / 1609).toFixed(1) + ' mi' : '?'}</td><td class="mono">${hubPointsAt(h, j).toFixed(1)}</td></tr>`).join('');
    html += `<div class="dr-sec"><h3>Index input · hub weather forecast (Open-Meteo)</h3><table class="hubhrs"><tr><th>Hour</th><th>Weather</th><th>Gusts</th><th>Visibility</th><th>Points</th></tr>${rows}</table><p class="sub">Points feed the Sky Friction Index (see "US hub weather").</p></div>`;
  }
  const adv = feed('faaAdvisories') && feed('faaAdvisories').data;
  if (a.region === 'US') {
    const day = adv ? adv.programs.filter(p => p.airport === iata && Date.now() - Date.parse(p.sent) <= 864e5) : null;
    html += `<div class="dr-sec"><h3>FAA programs issued, last 24 hours</h3>${day == null ? '<p>No live advisory data.</p>' : day.length ? `<ul class="dr-list">${day.map(p => `<li><span>${p.type === 'GS' ? 'Ground stop' : 'Ground delay program'}</span><span class="mono">${utc(p.sent)}</span></li>`).join('')}</ul>` : '<p>None in the last 24 hours.</p>'}</div>`;
  }
  const ht = fresh('hubTraffic') && feed('hubTraffic').data.hubs[iata];
  if (ht) html += `<div class="dr-sec"><h3>Aircraft nearby</h3><p>${ht.airborne} airborne and ${ht.total - ht.airborne} on the ground within ${feed('hubTraffic').data.radiusNm} nm (adsb.lol volunteer receivers) · ${asOf('hubTraffic')}</p></div>`;
  html += `<div class="dr-sec"><h3>More</h3><div class="dr-links"><a href="https://aviationweather.gov/data/metar/?id=${esc(a.icao)}&taf=1" target="_blank" rel="noopener">METAR and TAF at AviationWeather.gov</a>${a.region === 'US' ? '<a href="https://nasstatus.faa.gov/" target="_blank" rel="noopener">FAA NAS Status</a>' : ''}<a href="https://www.flightaware.com/live/airport/${esc(a.icao)}" target="_blank" rel="noopener">Flights on FlightAware</a></div><p class="sub">Link to this page: dashboardrunway.live/#${esc(a.iata)}</p></div>`;
  $('drBody').innerHTML = html;
  if (el.hidden) { LAST_FOCUS = document.activeElement; el.hidden = false; document.body.style.overflow = 'hidden'; }
  if (focus) { el.querySelector('.drawer-x').focus(); if (location.hash !== '#' + iata) history.replaceState(null, '', '#' + iata); }
}
function closeAirport() {
  const el = $('drawer'); if (el.hidden) return;
  el.hidden = true; document.body.style.overflow = ''; OPEN_AP = null;
  history.replaceState(null, '', location.pathname + location.search);
  if (LAST_FOCUS && LAST_FOCUS.focus) LAST_FOCUS.focus();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ap]'); if (b) { openAirport(b.dataset.ap); return; }
  if (e.target.closest('[data-close]')) closeAirport();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAirport(); });
$('map').addEventListener('click', ev => {
  if (!MAPGEOM) return;
  const r = $('map').getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
  let best = null, bd = 16; HUBS.forEach(h => { const d = Math.hypot(h.X - mx, h.Y - my); if (d < bd) { bd = d; best = h; } });
  if (best) openAirport(best.iata);
});
window.addEventListener('hashchange', () => { const c = location.hash.slice(1).toUpperCase(); if (/^[A-Z]{3}$/.test(c)) openAirport(c); else closeAirport(); });

// ---------------------------------------------------------------- per-airport outlooks
let APT = null; // airport backtest results (per-airport test scores)
const APO_DRIVER = { wxNext3: 'weather here', own3: 'recent programs here', own24: 'programs here today', others3: 'programs elsewhere', tod: 'time of day' };
function airportOutlook(iata) { const A = SNAP && SNAP.scores && SNAP.scores.airports; return A && fresh('usHubWx') && fresh('faaAdvisories') ? A[iata] || null : null; }
function apoDriver(o) {
  const c = Object.entries(o.contributions || {}).filter(([k]) => k !== 'tod').sort((a, b) => b[1] - a[1])[0];
  return c && c[1] > 0.25 ? APO_DRIVER[c[0]] : null;
}
function apoColor(p) { return p >= 0.5 ? '#b91c1c' : p >= 0.25 ? '#c2410c' : p >= 0.10 ? '#b45309' : '#15803d'; }
function renderAirportOutlooks() {
  const el = $('apoList'); if (!el) return;
  const A = SNAP && SNAP.scores && SNAP.scores.airports;
  if (!A || !fresh('usHubWx') || !fresh('faaAdvisories')) { el.innerHTML = `<span class="sub">${SNAP ? 'Unavailable: needs live FAA advisories and the US hub forecast.' : 'Loading…'}</span>`; return; }
  const names = Object.fromEntries(((SNAP && SNAP.airports) || []).map(a => [a.iata, a.name]));
  el.innerHTML = Object.entries(A).sort((a, b) => b[1].p - a[1].p).map(([k, o]) => {
    const d = apoDriver(o), ratio = o.typical > 0 ? o.p / o.typical : 1;
    const note = (d ? 'mainly ' + d : 'nothing unusual') + ` · usual ${pct(o.typical)}`;
    return `<button type="button" class="apo-row" data-ap="${esc(k)}" aria-label="${esc(k)}: ${pct(o.p)} chance of a new FAA program in the next 3 hours"><b>${esc(k)}</b><span><span class="bar"><span style="width:${clamp(o.p * 200, 1, 100)}%;background:${apoColor(o.p)}"></span><i style="left:${clamp(o.typical * 200, 0, 99)}%"></i></span><small>${esc(names[k] || '')} · ${esc(note)}</small></span><span class="pct">${pct(o.p)}</span></button>`;
  }).join('') + '<div class="apo-legend" style="grid-column:1/-1">Bar: chance now (full bar = 50% or more) · <i></i> mark: usual chance at this hour</div>';
}
function airportOutlookSection(iata) {
  const o = airportOutlook(iata); if (!o) return '';
  const C = o.contributions || {}, bt = APT && APT.byAirport && APT.byAirport[iata];
  const rows = ['own3', 'own24', 'others3', 'wxNext3', 'tod'].filter(k => k in C).map(k => {
    const c = C[k], w = clamp(Math.abs(c) / 2.5 * 50, 0, 50);
    return `<div class="drv"><span>${APO_DRIVER[k][0].toUpperCase() + APO_DRIVER[k].slice(1)}</span><span class="bar"><span style="${c >= 0 ? `left:50%;width:${w}%;background:#b91c1c` : `left:${50 - w}%;width:${w}%;background:#15803d`}"></span></span><span class="val">${Math.abs(c) < 0.05 ? '0.0' : (c > 0 ? '+' : '−') + Math.abs(c).toFixed(1)}</span></div>`;
  }).join('');
  const F = o.features;
  const tested = bt ? (bt.eventsTest < 15 ? `Too few programs here in the test weeks (${bt.eventsTest}) to judge this airport on its own; the pooled score across all 15 hubs is ${APT.pooled.model.aucTest.toFixed(2)}.` : `Tested score at ${iata}: ${bt.aucModel.toFixed(2)} (usual-rate-only: ${bt.aucTod.toFixed(2)}; 0.5 = coin flip).`) : '';
  return `<div class="dr-sec"><h3>Outlook · next 3 hours</h3>
    <p style="font-size:15px;color:var(--ink)"><b class="mono" style="font-size:22px;color:${apoColor(o.p)}">${pct(o.p)}</b> chance the FAA starts a new ground stop or delay program here in the next 3 hours. Usual at this hour: <b>${pct(o.typical)}</b>.</p>
    <div class="drivers" style="margin-top:8px">${rows}</div>
    <p class="sub">Inputs now: ${F.own3} program(s) here in the last ~3 h, ${F.own24} in the last 24 h, ${F.others3} elsewhere in the US in the last ~3 h, weather ${F.wxNext3.toFixed(1)} pts over the next 3 h. ${tested} A program already in effect makes a new one less likely, not more.</p></div>`;
}
getJSON('data/airport-backtest.json', 15000).then(j => { APT = j; if (OPEN_AP) openAirport(OPEN_AP, false); }).catch(() => {});

// ---------------------------------------------------------------- zoomable map (MapLibre + OpenFreeMap)
// Falls back to the canvas map above if MapLibre, WebGL or the base map is unavailable.
const VIEWS = { world: [[-170, -50], [178, 72]], us: [[-125, 23], [-66, 50]], europe: [[-12, 35], [32, 60]], asia: [[90, -12], [150, 46]] };
const STATUS_COLOR = { high: '#b91c1c', watch: '#b45309', normal: '#15803d', unknown: '#94a3b8' };
const HAZ_COLOR = { TS: '#ea580c', TURB: '#7c3aed', ICE: '#0284c7', VA: '#475569' };
const fc = features => ({ type: 'FeatureCollection', features });
function glData() {
  const tk = trafficKey(), d = tk && feed(tk).data, cell = (d && d.densityCellDeg) || 3;
  const dens = d && d.density ? d.density.map(([i, j, n]) => { const x0 = i * cell - 180, y0 = j * cell - 90;
    return { type: 'Feature', properties: { n }, geometry: { type: 'Polygon', coordinates: [[[x0, y0], [x0 + cell, y0], [x0 + cell, y0 + cell], [x0, y0 + cell], [x0, y0]]] } }; }) : [];
  const sig = fresh('sigmet') ? feed('sigmet').data.items.map(s => ({ type: 'Feature', properties: { hazard: s.hazard, color: HAZ_COLOR[s.hazard] || '#64748b', fir: s.fir || '', top: s.top || '', base: s.base || '', validTo: s.validTo },
    geometry: s.poly ? { type: 'Polygon', coordinates: [s.poly] } : { type: 'Point', coordinates: [s.lon, s.lat] } })) : [];
  const aps = ((SNAP && SNAP.airports) || []).map(a => { const s = hubStatus(a), o = airportOutlook(a.iata);
    return { type: 'Feature', properties: { iata: a.iata, status: s.status, color: STATUS_COLOR[s.status], label: s.status === 'high' || s.status === 'watch' ? s.label : a.iata, rank: { high: 3, watch: 2, normal: 1, unknown: 0 }[s.status], outlook: o ? pct(o.p) : '' },
      geometry: { type: 'Point', coordinates: [a.lon, a.lat] } }; });
  const em = fresh('emergencies') ? feed('emergencies').data.items.map(a => ({ type: 'Feature', properties: { label: a.callsign + ' ' + a.code }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } })) : [];
  return { density: fc(dens), sigmets: fc(sig), airports: fc(aps), emergencies: fc(em), maxN: d && d.density && d.density.length ? Math.max(...d.density.map(x => x[2])) : 1 };
}
function updateGL() {
  if (!GL_READY) return;
  const D = glData();
  ['density', 'sigmets', 'airports', 'emergencies'].forEach(k => GL.getSource(k).setData(D[k]));
  // shading by aircraft count; fades as you zoom in, where 3-degree squares look coarse
  const byCount = max => ['interpolate', ['linear'], ['ln', ['+', 1, ['get', 'n']]], 0, 0.03, Math.log(1 + D.maxN), max];
  GL.setPaintProperty('density', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 1.5, byCount(0.5), 4.5, byCount(0.18)]);
}
function glAirportPopup(iata) {
  const a = ((SNAP && SNAP.airports) || []).find(x => x.iata === iata); if (!a) return '';
  const s = hubStatus(a), m = s.metar, o = airportOutlook(iata);
  return `<b>${esc(a.iata)}</b> · ${esc(a.name || a.icao)}<br>${s.lines.length ? s.lines.map(esc).join('<br>') : s.status === 'unknown' ? 'No live data' : 'No FAA programs'}${o ? `<br>Next 3 h: <b>${pct(o.p)}</b> chance of a new program (usual ${pct(o.typical)})` : ''}${m ? `<br>Weather: ${esc(m.fltCat || '?')}${m.wx ? ' · ' + esc(m.wx) : ''}<div class="raw">${esc(m.raw)}</div>` : ''}<br><i>Click for full details</i>`;
}
function initGL() {
  const box = $('mapgl');
  const fail = () => { if (GL) { try { GL.remove(); } catch (e) {} } GL = null; GL_READY = false; box.hidden = true; $('map').hidden = false; document.querySelector('.mapviews').hidden = true; drawMap(); };
  const webgl = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } })();
  if (!window.maplibregl || !webgl) return fail();
  box.hidden = false; $('map').hidden = true; document.querySelector('.mapviews').hidden = false;
  const timer = setTimeout(() => { if (!GL_READY) fail(); }, 12000);
  try {
    GL = new maplibregl.Map({ container: box, style: 'https://tiles.openfreemap.org/styles/positron', bounds: VIEWS.world, renderWorldCopies: true, attributionControl: { compact: true }, cooperativeGestures: window.matchMedia('(pointer: coarse)').matches });
  } catch (e) { clearTimeout(timer); return fail(); }
  GL.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  GL.on('error', e => { if (!GL_READY) { clearTimeout(timer); fail(); } });
  GL.on('load', () => {
    clearTimeout(timer);
    const firstSymbol = (GL.getStyle().layers.find(l => l.type === 'symbol') || {}).id;
    const D = glData();
    ['density', 'sigmets', 'airports', 'emergencies'].forEach(k => GL.addSource(k, { type: 'geojson', data: D[k] }));
    GL.addLayer({ id: 'density', type: 'fill', source: 'density', paint: { 'fill-color': '#1d4ed8', 'fill-opacity': 0.25, 'fill-outline-color': 'rgba(0,0,0,0)', 'fill-antialias': false } }, firstSymbol);
    GL.addLayer({ id: 'sigmet-fill', type: 'fill', source: 'sigmets', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 } }, firstSymbol);
    GL.addLayer({ id: 'sigmet-line', type: 'line', source: 'sigmets', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.8 } }, firstSymbol);
    GL.addLayer({ id: 'sigmet-pt', type: 'circle', source: 'sigmets', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': ['get', 'color'], 'circle-radius': 4, 'circle-opacity': 0.8 } });
    GL.addLayer({ id: 'emergencies', type: 'circle', source: 'emergencies', paint: { 'circle-color': '#b91c1c', 'circle-radius': 6, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    GL.addLayer({ id: 'airports', type: 'circle', source: 'airports', layout: { 'circle-sort-key': ['get', 'rank'] }, paint: {
      'circle-color': ['get', 'color'], 'circle-radius': ['match', ['get', 'status'], 'high', 8, 'watch', 7, 5], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    GL.addLayer({ id: 'airport-labels', type: 'symbol', source: 'airports', layout: {
      'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-optional': true, 'symbol-sort-key': ['-', 3, ['get', 'rank']] },
      paint: { 'text-color': ['match', ['get', 'status'], 'high', '#991b1b', 'watch', '#92400e', '#0b2a4a'], 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    GL_READY = true; updateGL();
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
    GL.on('mouseenter', 'airports', e => { GL.getCanvas().style.cursor = 'pointer'; popup.setLngLat(e.features[0].geometry.coordinates).setHTML(glAirportPopup(e.features[0].properties.iata)).addTo(GL); });
    GL.on('mouseleave', 'airports', () => { GL.getCanvas().style.cursor = ''; popup.remove(); });
    GL.on('click', 'airports', e => { popup.remove(); openAirport(e.features[0].properties.iata); });
    GL.on('click', 'sigmet-fill', e => { const p = e.features[0].properties, names = { TS: 'Thunderstorm', TURB: 'Turbulence', ICE: 'Icing', VA: 'Volcanic ash', MTW: 'Mountain wave' };
      new maplibregl.Popup({ offset: 6 }).setLngLat(e.lngLat).setHTML(`<b>${esc(names[p.hazard] || p.hazard)} SIGMET</b><br>${esc(p.fir)}${p.base || p.top ? `<br>${p.base ? 'from ' + Number(p.base).toLocaleString() + ' ft ' : ''}${p.top ? 'to ' + Number(p.top).toLocaleString() + ' ft' : ''}` : ''}<br>Valid until ${utc(p.validTo)}`).addTo(GL); });
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-view]'); if (!b || !GL) return;
  GL.fitBounds(VIEWS[b.dataset.view], { padding: 20, duration: 800 });
  document.querySelectorAll('[data-view]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
});
(function loadGL() {
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/maplibre/maplibre-gl.css'; document.head.appendChild(css);
  const js = document.createElement('script'); js.src = 'vendor/maplibre/maplibre-gl.js'; js.onload = initGL; js.onerror = () => { document.querySelector('.mapviews').hidden = true; };
  document.head.appendChild(js);
})();
