// Vercel Edge Function: GET /api/socrata-proxy?<soql params>
//
// Proxies NYC OpenData Socrata queries through this same-origin endpoint
// so users behind firewalls / DNS filters / corporate proxies that block
// data.cityofnewyork.gov can still see live data — their browser only
// ever talks to *.vercel.app.
//
// Runs on Vercel Edge Runtime (V8, native fetch) — bypasses the Python
// runtime's DNS sandbox limitation that broke socrata-proxy.py.
//
// Optional: set SOCRATA_APP_TOKEN env var in Vercel project settings to
// lift the unauthenticated rate limit. Token never reaches the browser.

export const config = { runtime: 'edge' };

const DEFAULT_DATASET = 'erm2-nwe9';
const SOCRATA_HOST    = 'https://data.cityofnewyork.gov';
const TIMEOUT_MS      = 12000;
const MAX_QUERY_LEN   = 4096;
const ALLOWED_PARAMS  = new Set([
  '$select', '$where', '$group', '$order', '$having',
  '$limit', '$offset', '$q', '$query', '_dataset',
]);

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...extra,
    },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const url = new URL(req.url);
  if (url.search.length > MAX_QUERY_LEN) {
    return json(414, { error: 'Query too long.' });
  }

  // Validate params (defense-in-depth against open-proxy abuse)
  const sp = url.searchParams;
  for (const key of sp.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return json(400, { error: `Unsupported parameter: ${key}` });
    }
  }

  const dataset = (sp.get('_dataset') || DEFAULT_DATASET).trim();
  if (!/^[a-z0-9-]{1,16}$/i.test(dataset)) {
    return json(400, { error: 'Invalid dataset id.' });
  }
  sp.delete('_dataset');

  const forwardUrl = `${SOCRATA_HOST}/resource/${dataset}.json?${sp.toString()}`;

  const headers = { 'Accept': 'application/json' };
  if (typeof process !== 'undefined' && process.env && process.env.SOCRATA_APP_TOKEN) {
    headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(forwardUrl, { headers, signal: ctrl.signal });
    const body = await r.text();
    clearTimeout(timer);

    if (!r.ok) {
      return json(r.status, {
        error: `Socrata HTTP ${r.status}`,
        detail: body.slice(0, 400),
      });
    }
    // Cache successful aggregate responses for 5 min
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        ...corsHeaders,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    return json(502, {
      error: `Cannot reach Socrata: ${err.message}`,
      url: forwardUrl,
    });
  }
}
