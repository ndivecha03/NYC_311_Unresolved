// Vercel serverless function (Node.js): GET /api/health
// Routes through public CORS proxies because Vercel's serverless DNS
// can't resolve data.cityofnewyork.gov.

const SOCRATA_DIRECT = 'https://data.cityofnewyork.gov';
const PROXIES = [
  { wrap: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, headers: () => ({}), timeout: 18000 },
  { wrap: u => `https://api.codetabs.com/v1/proxy/?quest=${u}`, headers: () => ({}), timeout: 12000 },
  { wrap: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    headers: () => ({ 'Origin': 'https://nyc-311-unresolved.vercel.app', 'Referer': 'https://nyc-311-unresolved.vercel.app/' }),
    timeout: 12000 },
  { wrap: u => `https://thingproxy.freeboard.io/fetch/${u}`, headers: () => ({}), timeout: 12000 },
];

function pickYear() {
  const now = new Date();
  return now.getUTCMonth() > 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear() - 2;
}

async function tryProxies(url, baseHeaders) {
  const errs = [];
  for (const p of PROXIES) {
    const proxied = p.wrap(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), p.timeout);
    const host = proxied.split('?')[0].split('://')[1].split('/')[0];
    try {
      const r = await fetch(proxied, {
        headers: { ...baseHeaders, ...p.headers() },
        signal: ctrl.signal,
      });
      const body = await r.text();
      clearTimeout(timer);
      if (r.ok && (body.startsWith('[') || body.startsWith('{'))) {
        return { status: r.status, body, via: host };
      }
      errs.push(`${host} → ${r.ok ? 'non-JSON' : r.status}`);
    } catch (e) {
      clearTimeout(timer);
      errs.push(`${host} → ${e.message}`);
    }
  }
  throw new Error(errs.join('; '));
}

export default async function handler(req, res) {
  const year = pickYear();
  const where = `complaint_type='Street Light Condition' AND created_date>='${year}-01-01T00:00:00' AND created_date<'${year+1}-01-01T00:00:00' AND borough='MANHATTAN'`;
  const direct = `${SOCRATA_DIRECT}/resource/erm2-nwe9.json?$select=count(*)&$where=${encodeURIComponent(where)}`;

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'NYC-Street-Lights/1.0 (+via vercel)',
  };
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const result = await tryProxies(direct, headers);
    const rows = JSON.parse(result.body);
    const n = Number(rows[0]?.count_1 || rows[0]?.count || 0);
    const ok = n >= 1000 && n <= 30000;
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok, value: n, year, via: result.via,
      detail: ok
        ? `live · ${year} Manhattan = ${n.toLocaleString()} complaints (via ${result.via})`
        : `unexpected count (${n}) — dataset schema may have changed`,
    }));
  } catch (err) {
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false, value: null, year,
      detail: 'All upstream proxies failed',
      cause: err.message || err.toString(),
    }));
  }
}
