/**
 * Cloudflare Worker — NYC Street Lights Socrata Proxy
 *
 * Tries multiple Socrata-equivalent upstreams because data.cityofnewyork.gov
 * (Akamai-fronted) has DNS/edge-routing issues from many serverless platforms.
 * Falls back through alternate hostnames + paths until one returns valid JSON.
 *
 * Diagnostic endpoints:
 *   /test    — proves CF Workers can reach external sites at all (fetches github.com)
 *   /probe   — tries each Socrata upstream and reports which one(s) work
 *   /health  — same data check used by the dashboard's status pill
 */

const DEFAULT_DATASET = 'erm2-nwe9';

// Socrata-equivalent upstreams, tried in order. The dataset id is the same
// across all of them — only the hostname/path differs.
//
// Order matters: nycopendata.socrata.com is the PRIMARY because Akamai-fronted
// data.cityofnewyork.gov returns CF error 1016 ("origin DNS error") from
// Cloudflare Workers and most serverless platforms — Akamai's edge routing
// is hostile to non-residential client IPs. Confirmed via /probe.
const UPSTREAMS = [
  base => `https://nycopendata.socrata.com/resource/${base}.json`,        // PRIMARY — Socrata-direct, works from Workers
  base => `https://data.cityofnewyork.gov/resource/${base}.json`,         // fallback — Akamai-fronted
  base => `https://data.cityofnewyork.gov/api/odata/v4/${base}`,          // last resort — OData v4 endpoint
];

const MAX_QUERY_LEN = 4096;
const ALLOWED_PARAMS = new Set([
  '$select', '$where', '$group', '$order', '$having',
  '$limit', '$offset', '$q', '$query', '_dataset',
]);

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':       '86400',
};

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
});

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET')      return json(405, { error: 'Method not allowed' });

    const url = new URL(request.url);
    if (url.pathname === '/test')  return await handleTest();
    if (url.pathname === '/probe') return await handleProbe(env);
    if (url.pathname === '/health') return await handleHealth(env);
    return await handleProxy(url, env);
  },
};

// ── Diagnostics ─────────────────────────────────────────────────
async function handleTest() {
  // Confirms CF Workers can fetch arbitrary HTTPS — known-good URL
  try {
    const r = await fetch('https://api.github.com/zen', {
      headers: { 'User-Agent': 'NYC-Street-Lights/1.0 (cloudflare-worker)' },
    });
    const body = await r.text();
    return json(200, {
      ok: true,
      target: 'api.github.com/zen',
      status: r.status,
      body: body.slice(0, 200),
    });
  } catch (err) {
    return json(200, { ok: false, target: 'api.github.com/zen', error: err.message });
  }
}

async function handleProbe(env) {
  // Tries every Socrata upstream and reports success/failure for each
  const results = [];
  const where = `complaint_type='Street Light Condition'`;
  const probeQs = `?$select=count(*)&$where=${encodeURIComponent(where)}&$limit=1`;

  for (const wrap of UPSTREAMS) {
    const url = wrap(DEFAULT_DATASET) + probeQs;
    try {
      const headers = { 'Accept': 'application/json' };
      if (env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = env.SOCRATA_APP_TOKEN;
      const r = await fetch(url, { headers });
      const body = await r.text();
      results.push({
        url,
        status: r.status,
        ok: r.ok,
        bodyPeek: body.slice(0, 120),
      });
    } catch (err) {
      results.push({ url, error: err.message || String(err) });
    }
  }
  return json(200, { results });
}

// ── Main proxy ──────────────────────────────────────────────────
async function handleProxy(url, env) {
  const sp = url.searchParams;

  if (sp.toString().length > MAX_QUERY_LEN) return json(414, { error: 'Query too long.' });
  for (const k of sp.keys()) {
    if (!ALLOWED_PARAMS.has(k)) return json(400, { error: `Unsupported parameter: ${k}` });
  }

  const dataset = (sp.get('_dataset') || DEFAULT_DATASET).trim();
  if (!/^[a-z0-9-]{1,16}$/i.test(dataset)) return json(400, { error: 'Invalid dataset id.' });
  sp.delete('_dataset');

  const qs = sp.toString();
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'NYC-Street-Lights/1.0 (cloudflare-worker)',
  };
  if (env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = env.SOCRATA_APP_TOKEN;

  const errors = [];
  for (const wrap of UPSTREAMS) {
    const target = `${wrap(dataset)}?${qs}`;
    try {
      const r = await fetch(target, { headers });
      const body = await r.text();
      // Some upstreams return 200 with an HTML error page — sniff for JSON
      const looksJson = body.startsWith('[') || body.startsWith('{');
      if (r.ok && looksJson) {
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300, s-maxage=300',
            'X-Upstream': new URL(target).hostname,
            ...CORS,
          },
        });
      }
      errors.push(`${new URL(target).hostname} → ${r.status}${looksJson ? '' : ' (non-JSON)'}`);
    } catch (err) {
      try { errors.push(`${new URL(target).hostname} → ${err.message}`); }
      catch { errors.push(`(bad-url) → ${err.message}`); }
    }
  }
  return json(502, {
    error: 'All Socrata upstreams unreachable',
    detail: errors.join('; '),
  });
}

async function handleHealth(env) {
  const now = new Date();
  const year = now.getUTCMonth() > 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear() - 2;
  const where = `complaint_type='Street Light Condition' AND created_date>='${year}-01-01T00:00:00' AND created_date<'${year + 1}-01-01T00:00:00' AND borough='MANHATTAN'`;
  const qs = `?$select=count(*)&$where=${encodeURIComponent(where)}`;

  const headers = { 'Accept': 'application/json' };
  if (env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = env.SOCRATA_APP_TOKEN;

  for (const wrap of UPSTREAMS) {
    const target = wrap(DEFAULT_DATASET) + qs;
    try {
      const r = await fetch(target, { headers });
      if (!r.ok) continue;
      const body = await r.text();
      if (!body.startsWith('[')) continue;
      const rows = JSON.parse(body);
      const n = Number(rows[0]?.count_1 || rows[0]?.count || 0);
      const ok = n >= 1000 && n <= 30000;
      return json(200, {
        ok, value: n, year,
        upstream: new URL(target).hostname,
        detail: ok
          ? `live · ${year} Manhattan = ${n.toLocaleString()} complaints`
          : `unexpected count (${n})`,
      });
    } catch (e) { /* try next */ }
  }
  return json(200, {
    ok: false, value: null, year,
    detail: 'All Socrata upstreams unreachable from Cloudflare Worker',
  });
}
