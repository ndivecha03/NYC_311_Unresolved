// Vercel serverless function (Node.js): GET /api/socrata-proxy
//
// Why this exists:
//   data.cityofnewyork.gov is unreachable from many networks (corporate
//   firewalls, certain ISPs, AND Vercel's own serverless DNS sandbox —
//   confirmed via DoH lookup returning NODATA from Vercel's network).
//   So we proxy through corsproxy.io, which does the DNS + fetch from its
//   own infrastructure and returns the result. The browser only ever
//   talks to *.vercel.app, and Vercel only ever talks to corsproxy.io.
//
// Optional: SOCRATA_APP_TOKEN env var to lift unauthenticated rate limit.

const DEFAULT_DATASET   = 'erm2-nwe9';
const SOCRATA_DIRECT    = 'https://data.cityofnewyork.gov';
// Public CORS proxies, tried in order until one works.
// Each entry: { wrap, headers } — different proxies require different headers.
const PROXY_PROVIDERS = [
  {
    wrap: url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    headers: () => ({}),
    timeout: 18000,
  },
  {
    wrap: url => `https://api.codetabs.com/v1/proxy/?quest=${url}`,
    headers: () => ({}),
    timeout: 12000,
  },
  {
    wrap: url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    headers: () => ({
      'Origin':  'https://nyc-311-unresolved.vercel.app',
      'Referer': 'https://nyc-311-unresolved.vercel.app/',
    }),
    timeout: 12000,
  },
  {
    wrap: url => `https://thingproxy.freeboard.io/fetch/${url}`,
    headers: () => ({}),
    timeout: 12000,
  },
];

const TIMEOUT_MS      = 12000;
const MAX_QUERY_LEN   = 4096;
const ALLOWED_PARAMS  = new Set([
  '$select', '$where', '$group', '$order', '$having',
  '$limit', '$offset', '$q', '$query', '_dataset',
]);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age',       '86400');
}

function reply(res, status, body) {
  setCors(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', status === 200
    ? 'public, max-age=300, s-maxage=300'
    : 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSocrata(directUrl, headers) {
  const errors = [];
  for (const provider of PROXY_PROVIDERS) {
    const proxyUrl = provider.wrap(directUrl);
    const allHeaders = { ...headers, ...provider.headers() };
    try {
      const r = await fetchWithTimeout(proxyUrl, {
        headers: allHeaders,
        timeout: provider.timeout,
      });
      const body = await r.text();
      // Some proxies return 200 with HTML error pages — sniff for JSON
      const looksJson = body.startsWith('[') || body.startsWith('{');
      if (r.ok && looksJson) {
        return { status: r.status, body, via: proxyUrl.split('?')[0].split('://')[1].split('/')[0] };
      }
      errors.push(`${proxyUrl.split('?')[0].split('://')[1].split('/')[0]} → ${r.ok ? 'non-JSON' : r.status}`);
    } catch (e) {
      const host = proxyUrl.split('?')[0].split('://')[1].split('/')[0];
      errors.push(`${host} → ${e.message}`);
    }
  }
  throw new Error(`All proxies failed: ${errors.join('; ')}`);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCors(res); res.statusCode = 204; res.end(); return; }
  if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });

  const fullUrl = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const sp = fullUrl.searchParams;

  if (sp.toString().length > MAX_QUERY_LEN) return reply(res, 414, { error: 'Query too long.' });
  for (const k of sp.keys()) {
    if (!ALLOWED_PARAMS.has(k)) return reply(res, 400, { error: `Unsupported parameter: ${k}` });
  }

  const dataset = (sp.get('_dataset') || DEFAULT_DATASET).trim();
  if (!/^[a-z0-9-]{1,16}$/i.test(dataset)) return reply(res, 400, { error: 'Invalid dataset id.' });
  sp.delete('_dataset');

  const directUrl = `${SOCRATA_DIRECT}/resource/${dataset}.json?${sp.toString()}`;
  const headers = {
    'Accept':     'application/json',
    'User-Agent': 'NYC-Street-Lights/1.0 (+via vercel)',
  };
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  try {
    const result = await fetchSocrata(directUrl, headers);
    setCors(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.setHeader('X-Proxy-Via', result.via);
    res.end(result.body);
  } catch (err) {
    return reply(res, 502, {
      error: 'All upstream proxies failed',
      detail: err.message,
    });
  }
}
