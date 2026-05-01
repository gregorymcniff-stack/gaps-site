// netlify/functions/faa-proxy.js
const FAA_NAS_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

function parseFaaXml(xml) {
  const result = {
    ok: true,
    timestamp: new Date().toISOString(),
    programs: [],
    groundStops: [],
    groundDelays: [],
    airspaceFlows: [],
    centerAdvisories: [],
    rawHasData: false
  };

  if (!xml || typeof xml !== 'string') return result;
  result.rawHasData = xml.includes('<Airport_Status_Information') || xml.includes('<Delay_type>');

  const gdpMatches = xml.matchAll(/<Delay_type>[\s\S]*?<\/Delay_type>/g);
  for (const m of gdpMatches) {
    const block = m[0];
    const get = (tag) => {
      const r = block.match(new RegExp(`<${tag}>(.*?)<\/${tag}>`, 's'));
      return r ? r[1].trim() : null;
    };
    const name = get('Name') || '';
    const airport = get('ARPT');
    const delay = get('Delay');
    const reason = get('Reason');
    const minDelay = get('Min');
    const maxDelay = get('Max');
    const avgDelay = get('Avg');
    const trend = get('Trend');
    const endTime = get('End');
    if (!airport) continue;
    const program = {
      type: name.toLowerCase().includes('ground stop') ? 'GROUND_STOP'
          : name.toLowerCase().includes('airspace flow') ? 'AFP'
          : 'GDP',
      airport, reason: reason || 'Unspecified',
      delay: delay || null,
      minDelay: minDelay ? parseInt(minDelay) : null,
      maxDelay: maxDelay ? parseInt(maxDelay) : null,
      avgDelay: avgDelay ? parseInt(avgDelay) : null,
      trend: trend || null, endTime: endTime || null, raw: name
    };
    result.programs.push(program);
    if (program.type === 'GROUND_STOP') result.groundStops.push(program);
    else if (program.type === 'AFP') result.airspaceFlows.push(program);
    else result.groundDelays.push(program);
  }

  let pressureScore = 0;
  result.groundStops.forEach(() => pressureScore += 22);
  result.groundDelays.forEach(p => pressureScore += 12 + Math.min(20, (p.avgDelay || 0) * 0.3));
  result.airspaceFlows.forEach(() => pressureScore += 8);
  result.operationalPressureScore = Math.min(100, Math.round(pressureScore));
  result.affectedHubs = [...new Set(result.programs.map(p => p.airport).filter(Boolean))];
  return result;
}

exports.handler = async function (event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=90'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const response = await fetch(FAA_NAS_URL, {
      headers: { 'Accept': 'application/xml, text/xml, */*', 'User-Agent': 'GAPS-Aviation-Monitor/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`FAA NAS returned HTTP ${response.status}`);
    const xml = await response.text();
    const parsed = parseFaaXml(xml);
    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  } catch (err) {
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: false, error: err.message,
        timestamp: new Date().toISOString(),
        programs: [], groundStops: [], groundDelays: [],
        airspaceFlows: [], centerAdvisories: [],
        operationalPressureScore: 0, affectedHubs: []
      })
    };
  }
};
