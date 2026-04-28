// Vercel serverless function (Node.js): GET /api/health
//
// Canary endpoint for external uptime monitors. Verifies that the Socrata
// dataset is reachable AND returning a plausible streetlight volume.
//
// Returns: {ok, value, year, detail}

// Override Vercel's default DNS resolver, which returns ENOTFOUND for
// data.cityofnewyork.gov. Force Cloudflare + Google nameservers.
import dns from 'node:dns';
dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4']);

const SOCRATA_URL = 'https://data.cityofnewyork.gov/resource/erm2-nwe9.json';
const TIMEOUT_MS  = 8000;

function pickYear() {
  const now = new Date();
  return now.getUTCMonth() > 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear() - 2;
}

export default async function handler(req, res) {
  const year = pickYear();
  const where = `complaint_type='Street Light Condition' AND created_date>='${year}-01-01T00:00:00' AND created_date<'${year+1}-01-01T00:00:00' AND borough='MANHATTAN'`;
  const url = `${SOCRATA_URL}?$select=count(*)&$where=${encodeURIComponent(where)}`;

  const headers = {
    'Accept':     'application/json',
    'User-Agent': 'NYC-Street-Lights/1.0 (Vercel)',
  };
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, value: null, year, detail: `Socrata HTTP ${r.status}` }));
    }
    const rows = await r.json();
    const n = Number(rows[0]?.count_1 || rows[0]?.count || 0);
    const ok = n >= 1000 && n <= 30000;
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok, value: n, year,
      detail: ok
        ? `live · ${year} Manhattan = ${n.toLocaleString()} complaints`
        : `unexpected count (${n}) — dataset schema may have changed`,
    }));
  } catch (err) {
    clearTimeout(timer);
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false, value: null, year,
      detail: `Socrata unreachable: ${err.message || err.toString()}`,
      cause: err.cause?.message || null,
    }));
  }
}
