// TEMPORARY diagnostic: reports how OpenSky responds from Netlify's servers.
// Never returns credential values. Remove before publishing.
const UA = 'GAPS-dashboard/2.0 (+https://dashboardrunway.live)';

async function timed(label, fn) {
  const t = Date.now();
  try { const r = await fn(); return { step: label, ms: Date.now() - t, ...r }; }
  catch (e) { return { step: label, ms: Date.now() - t, error: e.name === 'TimeoutError' ? 'timed out' : e.message }; }
}

export default async (req, context) => {
  if (context?.deploy?.context === 'production') return new Response('not available', { status: 404 });
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  const out = { credentialsPresent: { clientId: !!id, clientSecret: !!secret }, steps: [] };
  let token = null;
  if (id && secret) {
    const r = await timed('token', async () => {
      const res = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
        signal: AbortSignal.timeout(4000),
      });
      const j = await res.json().catch(() => ({}));
      token = j.access_token || null;
      return { status: res.status, gotToken: !!token, error: j.error_description || j.error || undefined };
    });
    out.steps.push(r);
  }
  // Small request first (one bounding box), then the global one with the time left.
  out.steps.push(await timed('states-small-box', async () => {
    const res = await fetch('https://opensky-network.org/api/states/all?lamin=40&lomin=-75&lamax=41&lomax=-73', {
      headers: { 'User-Agent': UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(2500),
    });
    return { status: res.status, creditsRemaining: res.headers.get('x-rate-limit-remaining'), bytes: (await res.text()).length };
  }));
  out.steps.push(await timed('states-global', async () => {
    const res = await fetch('https://opensky-network.org/api/states/all', {
      headers: { 'User-Agent': UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(3000),
    });
    return { status: res.status, creditsRemaining: res.headers.get('x-rate-limit-remaining'), bytes: (await res.text()).length };
  }));
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/api/diag/opensky' };
