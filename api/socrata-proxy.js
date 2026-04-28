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

// Vercel's serverless DNS sandbox returns ENOTFOUND for
// data.cityofnewyork.gov. Workaround: use DNS-over-HTTPS to Cloudflare
// 1.1.1.1, get the real IP, then fetch directly to that IP with proper
// SNI/Host headers. This bypasses Vercel's DNS resolver entirely while
// keeping the original hostname for TLS cert validation.

import https from 'node:https';

const DEFAULT_DATASET = 'erm2-nwe9';
const SOCRATA_HOST    = 'https://data.cityofnewyork.gov';
const SOCRATA_HOSTNAME = 'data.cityofnewyork.gov';

// Tiny in-memory cache so we don't DoH-lookup on every request
let _cachedIp = null, _cachedAt = 0;
const IP_TTL_MS = 5 * 60 * 1000;

async function resolveIp(hostname) {
  if (_cachedIp && Date.now() - _cachedAt < IP_TTL_MS) return _cachedIp;
  const r = await fetch(
    `https://1.1.1.1/dns-query?name=${hostname}&type=A`,
    { headers: { 'accept': 'application/dns-json' } }
  );
  const j = await r.json();
  const ans = (j.Answer || []).find(a => a.type === 1);
  if (!ans) throw new Error(`DoH: no A record for ${hostname}`);
  _cachedIp = ans.data;
  _cachedAt = Date.now();
  return _cachedIp;
}

// Fetch by IP with explicit SNI hostname so TLS cert validation passes
function httpsGetByIp(ip, hostname, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: ip,
      port: 443,
      path,
      servername: hostname,    // SNI
      headers: {
        'Host': hostname,
        'Accept': 'application/json',
        'User-Agent': 'NYC-Street-Lights/1.0 (Vercel)',
        ...extraHeaders,
      },
      timeout: 12000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf-8'),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}
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

  const path = `/resource/${dataset}.json?${sp.toString()}`;
  const extra = {};
  if (process.env.SOCRATA_APP_TOKEN) extra['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  try {
    const ip = await resolveIp(SOCRATA_HOSTNAME);
    const result = await httpsGetByIp(ip, SOCRATA_HOSTNAME, path, extra);

    if (result.status >= 400) {
      return reply(res, result.status, {
        error: `Socrata HTTP ${result.status}`,
        detail: result.body.slice(0, 400),
      });
    }
    setCors(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.end(result.body);
  } catch (err) {
    return reply(res, 502, {
      error: `Cannot reach Socrata: ${err.message || err.toString()}`,
      cause: err.cause?.message || null,
      ip: _cachedIp,
    });
  }
}
