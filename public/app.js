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

let SNAP = null, SNAP_ERR = null, HIST = [], TRACK = null, LAND = null, HUBS = [];

// ---------------------------------------------------------------- freshness
const MAX_AGE = { faaAdvisories: 30, usHubWx: 90, faa: 25, opensky: 25, adsblol: 25, metar: 90, sigmet: 60, openmeteo: 90, kp: 240, emergencies: 30 };
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
    const cls = ok ? 'ok' : has ? 'stale' : 'off';
    const age = has ? Math.round((Date.now() - Date.parse(f.fetchedAt)) / 60000) : null;
    return `<span class="feed ${cls}" title="${esc(LABEL[k])}: ${ok ? 'live' : has ? 'out of date' : 'unavailable'}"><i></i>${esc(LABEL[k])}${age != null ? ' ' + (age < 1 ? 'now' : age + 'm') : ' ·  off'}</span>`;
  }).join('') + '<span class="feed off" title="Needs an approved EUROCONTROL account"><i></i>Europe off</span>' +
    `<span class="updated">${SNAP && SNAP.generatedAt ? 'Server snapshot ' + utc(SNAP.generatedAt) : ''}${SNAP_ERR ? ' · cannot reach the data server' : ''}</span>`;
  $('feeds').innerHTML = html;
}
function tick() { const d = new Date(); $('clock').textContent = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0'); }

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
  const ratio = O.typical > 0 ? p / O.typical : null;
  const vs = ratio == null ? '' : ratio >= 1.5 ? `, ${ratio >= 10 ? 'many' : ratio.toFixed(ratio < 3 ? 1 : 0)} times the usual for this hour` : ratio <= 0.67 ? ', below the usual for this hour' : ', about usual for this hour';
  $('lede').textContent = `${pct(p)} chance of a bad stretch at US airports in the next 3 hours${vs}. ` +
    (F.persist ? `${F.persist} new FAA program${F.persist > 1 ? 's' : ''} in the last ~3 hours (${airports}).` : 'No new FAA programs in the last ~3 hours.') +
    (F.usStorms ? ` Thunderstorms forecast at ${F.stormHubs.join(', ')}.` : '');
  const C = O.contributions || {};
  $('drivers').innerHTML = ['persist', 'usHubStressNext3', 'tod', 'usStorms'].map(k => {
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
  $('faaSrc').textContent = 'Sources: FAA NAS Status (' + asOf('faa') + ') · ATCSCC advisory database (' + asOf('faaAdvisories') + ')';
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
  spark(setTile('tHub', F ? F.usHubStressNext3.toFixed(1) + '<small> pts</small>' : '--',
    F ? `Worst of the next 3 h at 15 hubs · Jul–Nov average 3.5${F.usStorms ? ' · storms at ' + F.stormHubs.join(', ') : ''} · ${asOf('usHubWx')}` : 'No live hub forecast', !!F), 'hubWx', '#b45309');
  spark(setTile('tRecent', F ? F.persist + '<small> new</small>' : '--',
    F ? `Started in the current and previous two hours · Jul–Nov average 2.9 · ${asOf('faaAdvisories')}` : 'No live FAA advisories', !!F), 'persist', '#b91c1c');
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
  const m = feed('metar');
  if (fresh('metar')) {
    const r = m.data.reports, low = r.filter(x => x.fltCat === 'IFR' || x.fltCat === 'LIFR'), ts = r.filter(x => /TS/.test(x.wx || ''));
    ctx('cWx', low.length + ts.length ? (low.length + ts.length) + '<span class="sub"> of ' + r.length + ' airports</span>' : 'All clear', 'Thunderstorms or instrument conditions in live METARs · ' + asOf('metar'),
      [...ts.map(x => `<div><b class="mono">${esc(x.iata)}</b> thunderstorm</div>`), ...low.map(x => `<div><b class="mono">${esc(x.iata)}</b> ${esc(x.fltCat)} (low cloud or visibility)</div>`)].join('') || '<div>No thunderstorms or instrument conditions at the 23 monitored airports.</div>');
  } else ctx('cWx', '--', 'No live airport weather', '');
  if (fresh('sigmet')) {
    const c = feed('sigmet').data.counts || {}, names = { TS: 'Thunderstorm', TURB: 'Turbulence', ICE: 'Icing', VA: 'Volcanic ash', MTW: 'Mountain wave', TC: 'Tropical cyclone' };
    ctx('cSig', String(Object.values(c).reduce((a, b) => a + b, 0)), 'Active SIGMETs worldwide · ' + asOf('sigmet'), Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div>${esc(names[k] || k)} · ${n}</div>`).join(''));
  } else ctx('cSig', '--', 'No live SIGMET data', '');
  if (fresh('emergencies')) {
    const em = feed('emergencies').data.items;
    ctx('cSqk', String(em.length), 'Aircraft broadcasting 7700, 7600 or 7500 · transponder codes, not confirmed incidents · ' + asOf('emergencies'),
      em.slice(0, 5).map(a => `<div><b class="mono">${esc(a.callsign)}</b> ${esc(a.code)} · ${esc(a.region)}</div>`).join(''));
  } else ctx('cSqk', '--', 'No live squawk data', '');
  if (fresh('kp')) { const kp = feed('kp').data.kp; ctx('cKp', 'Kp ' + kp.toFixed(1), (kp >= 5 ? 'Geomagnetic storm: HF radio on polar and oceanic routes may degrade' : 'Quiet to unsettled') + ' · NOAA · ' + asOf('kp')); }
  else ctx('cKp', '--', 'No live NOAA data');
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
  $('mapFoot').textContent = (parts.join(' · ') || 'Live map data unavailable.') + ' · Hover or tap an airport for details.';
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
function renderAll() { renderHeader(); renderOutlook(); renderFaa(); renderTiles(); renderContext(); drawMap(); }
async function refreshLive() {
  try { const s = await getJSON('/api/live', 20000); if (!s || !s.feeds) throw new Error('unexpected response'); SNAP = s; SNAP_ERR = null; }
  catch (e) { SNAP_ERR = (e && e.message) || 'error'; }
  renderAll();
}
async function refreshHistory() {
  try { const h = await getJSON('/api/history?range=24h', 15000); HIST = Array.isArray(h.rows) ? h.rows : []; } catch (e) { /* trend lines show "collecting" */ }
  renderOutlook(); renderTiles();
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
getJSON('data/land-110m.json', 15000).then(d => { LAND = prepLand(d); drawMap(); }).catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshLive(); });
setInterval(renderHeader, 60000);
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawMap, 120); });
$('map').addEventListener('mousemove', showTip);
$('map').addEventListener('mouseleave', () => { $('tip').style.display = 'none'; });
$('map').addEventListener('touchstart', showTip, { passive: true });
