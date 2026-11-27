// Turns the fitted model (data/sfi-model.json) into plain-language weights and
// examples. Used by the dashboard and the Method page so both always match
// the model that is actually running.
'use strict';
window.explainModel = function (M) {
  const m = M.models.y3big, S = M.stats || {};
  const tods = Object.values(m.todTable), todMean = m.mu[m.keys.indexOf('tod')];
  const sig = z => 1 / (1 + Math.exp(-z));
  // typical conditions: median hub weather and recent programs, no storms, average hour
  const mu = k => m.mu[m.keys.indexOf(k)];
  const typical = { usHubStressNext3: S.usHubStressNext3 ? S.usHubStressNext3.p50 : mu('usHubStressNext3'), capeNext6: S.capeNext6 ? S.capeNext6.p50 : mu('capeNext6'), usStorms: 0, persist: S.persist ? S.persist.p50 : mu('persist'), tod: todMean, season: mu('season') };
  const seasons = m.seasonTable ? Object.values(m.seasonTable) : [];
  const p = x => sig(m.intercept + m.keys.reduce((a, k, i) => a + m.w[i] * ((x[k] ?? m.mu[i]) - m.mu[i]) / m.sd[i], 0));
  const base = p(typical);
  const abs = m.w.map(Math.abs), tot = abs.reduce((a, b) => a + b, 0);
  const rows = [
    { key: 'persist', name: 'Recent FAA programs', what: 'New ground stops and delay programs in the last ~3 hours', from: typical.persist, to: S.persist ? S.persist.p90 : 8, fmt: v => v + (v === 1 ? ' program' : ' programs') },
    { key: 'usHubStressNext3', name: 'US hub weather', what: 'Bad-weather points at 15 major hubs, worst of the next 3 hours', from: typical.usHubStressNext3, to: S.usHubStressNext3 ? S.usHubStressNext3.p90 : 6, fmt: v => v.toFixed(1) + ' pts' },
    { key: 'capeNext6', name: 'Storm energy', what: 'How ready the air is to build thunderstorms (CAPE) at 15 hubs, peak of the next 6 hours', from: typical.capeNext6, to: S.capeNext6 ? S.capeNext6.p90 : 5, fmt: v => v.toFixed(1) },
    { key: 'season', name: 'Season', what: 'How often a bad stretch followed this hour in this month in FAA records', from: seasons.length ? Math.min(...seasons) : 0, to: seasons.length ? Math.max(...seasons) : 0, fmt: v => Math.round(v * 100) + '% of hours', fromLabel: 'quietest month-hour', toLabel: 'busiest month-hour' },
    { key: 'tod', name: 'Time of day', what: 'How often a bad stretch followed this hour (weekday or weekend) in FAA records', from: Math.min(...tods), to: Math.max(...tods), fmt: v => Math.round(v * 100) + '% of hours', fromLabel: 'quietest hour', toLabel: 'busiest hour' },
  ].filter(r => m.keys.includes(r.key)).map(r => {
    const i = m.keys.indexOf(r.key);
    const lo = p({ ...typical, [r.key]: r.from }), hi = p({ ...typical, [r.key]: r.to });
    return { ...r, share: abs[i] / tot, coef: m.w[i], lo, hi };
  });
  return { rows, base, model: m, fittedAt: M.fittedAt, recentring: m.recentring };
};
window.renderModelTable = function (M, opts = {}) {
  const E = window.explainModel(M), pct = v => Math.round(v * 100) + '%';
  const tr = E.rows.map(r => `<tr><td><b>${r.name}</b><br><span style="color:var(--muted,#5b6b7c)">${r.what}</span></td>` +
    `<td class="num"><span class="wbar" style="width:${Math.round(r.share * 60)}px"></span>${pct(r.share)}</td>` +
    `<td>${r.fromLabel || 'typical'} (${r.fmt(r.from)}) → ${r.toLabel || 'elevated'} (${r.fmt(r.to)}): <b>${pct(r.lo)} → ${pct(r.hi)}</b></td></tr>`).join('');
  return `<table><tr><th>Input</th><th>Weight</th><th>Example: change this input alone</th></tr>${tr}</table>` +
    `<p>With every input at a typical level the chance is about ${pct(E.base)}. Weights are each input's share of the model's total pull (standardised coefficients); they were fitted to two years of FAA records, not chosen by hand, and are re-centred on the last ${E.recentring ? E.recentring.days : 30} days.${opts.link ? ' <a href="method.html#formula">Exact formula →</a>' : ''}</p>`;
};
