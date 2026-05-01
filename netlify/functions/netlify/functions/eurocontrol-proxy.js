const B2B_ENDPOINT = 'https://www.b2b.nm.eurocontrol.int/B2B_PROXY/gateway/spec/';

exports.handler = async function (event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=120'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const b2bUser = process.env.EUROCONTROL_B2B_USER;
  const b2bPass = process.env.EUROCONTROL_B2B_PASS;
  const hasB2b = b2bUser && b2bPass;

  if (hasB2b) {
    try {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:00`;
      const plusTwo = new Date(now.getTime() + 2*3600000);
      const ts2 = `${plusTwo.getUTCFullYear()}${pad(plusTwo.getUTCMonth()+1)}${pad(plusTwo.getUTCDate())} ${pad(plusTwo.getUTCHours())}:${pad(plusTwo.getUTCMinutes())}:00`;

      const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fl="eurocontrol/cfmu/b2b/FlowServices">
  <soapenv:Body>
    <fl:RegulationListRequest>
      <sendTime>${ts}</sendTime>
      <dataset><type>OPERATIONAL</type></dataset>
      <tvFrom>${ts}</tvFrom><tvTo>${ts2}</tvTo>
    </fl:RegulationListRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

      const b2bRes = await fetch(B2B_ENDPOINT + 'FlowServices', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Authorization': 'Basic ' + Buffer.from(`${b2bUser}:${b2bPass}`).toString('base64')
        },
        body: soapBody,
        signal: AbortSignal.timeout(10000)
      });

      if (b2bRes.ok) {
        const xml = await b2bRes.text();
        return {
          statusCode: 200, headers,
          body: JSON.stringify({
            ok: true, source: 'b2b',
            timestamp: new Date().toISOString(),
            atfmPressureScore: xml.includes('ACTIVE') ? 55 : 20,
            activeCount: (xml.match(/ACTIVE/g)||[]).length,
            networkLoad: xml.includes('ACTIVE') ? 'MODERATE' : 'NORMAL',
            affectedAirspaces: [], b2bConfigured: true
          })
        };
      }
    } catch(e) {}
  }

  return {
    statusCode: 200, headers,
    body: JSON.stringify({
      ok: false, source: 'fallback',
      timestamp: new Date().toISOString(),
      b2bConfigured: hasB2b,
      b2bRegistrationUrl: 'https://www.eurocontrol.int/service/network-manager-business-business-b2b-web-services',
      atfmPressureScore: 0, activeCount: 0,
      networkLoad: 'NORMAL', affectedAirspaces: [],
      message: 'Set EUROCONTROL_B2B_USER and EUROCONTROL_B2B_PASS in Netlify env vars.'
    })
  };
};
