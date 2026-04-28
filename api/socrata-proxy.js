// Vercel serverless function (Node.js runtime): GET /api/socrata-proxy
//
// Proxies NYC OpenData Socrata queries through this same-origin endpoint
// so users behind firewalls / DNS filters / corporate proxies that block
// data.cityofnewyork.gov can still see live data — their browser only
// ever talks to *.vercel.app.
//
// Runs on Node.js 20 default runtime. The Python runtime cannot resolve
// data.cityofnewyork.gov in its DNS sandbox, and Edge Runtime had
// outbound-fetch restrictions for this host. Plain Node works.
//
// Optional: set SOCRATA_APP_TOKEN env var in Vercel project settings to
// lift the unauthenticated rate limit. Token never reaches the browser.

const DEFAULT_DATASET = 'erm2-nwe9';
const SOCRATA_HOST    = 'https://data.cityofnewyork.gov';
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
  if (status === 200) {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res); res.statusCode = 204; res.end(); return;
  }
  if (req.method !== 'GET') {
    return reply(res, 405, { error: 'Method not allowed' });
  }

  // Parse the query string (req.url is path + query)
  const fullUrl = new URL(req.url, `http://${req.headers.host || 'x'}`);
  const sp = fullUrl.searchParams;

  if (sp.toString().length > MAX_QUERY_LEN) {
    return reply(res, 414, { error: 'Query too long.' });
  }

  for (const key of sp.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return reply(res, 400, { error: `Unsupported parameter: ${key}` });
    }
  }

  const dataset = (sp.get('_dataset') || DEFAULT_DATASET).trim();
  if (!/^[a-z0-9-]{1,16}$/i.test(dataset)) {
    return reply(res, 400, { error: 'Invalid dataset id.' });
  }
  sp.delete('_dataset');

  const forwardUrl = `${SOCRATA_HOST}/resource/${dataset}.json?${sp.toString()}`;

  const headers = {
    'Accept':     'application/json',
    'User-Agent': 'NYC-Street-Lights/1.0 (Vercel)',
  };
  if (process.env.SOCRATA_APP_TOKEN) {
    headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(forwardUrl, { headers, signal: ctrl.signal });
    const body = await r.text();
    clearTimeout(timer);

    if (!r.ok) {
      return reply(res, r.status, {
        error: `Socrata HTTP ${r.status}`,
        detail: body.slice(0, 400),
      });
    }
    setCors(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.end(body);
  } catch (err) {
    clearTimeout(timer);
    return reply(res, 502, {
      error: `Cannot reach Socrata: ${err.message || err.toString()}`,
      cause: err.cause?.message || null,
      url: forwardUrl,
    });
  }
}
