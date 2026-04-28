// Vercel Edge Function: GET /api/health
//
// Canary endpoint for external uptime monitors. Verifies that the Socrata
// dataset is reachable AND returning a plausible streetlight volume.
//
// Returns: {ok, value, year, detail}

export const config = { runtime: 'edge' };

const SOCRATA_URL = 'https://data.cityofnewyork.gov/resource/erm2-nwe9.json';
const TIMEOUT_MS  = 6000;

function pickYear() {
  const now = new Date();
  // Most recent fully-closed year (Jan/Feb still considers prev-year as recent)
  return now.getUTCMonth() > 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear() - 2;
}

function reply(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default async function handler() {
  const year = pickYear();
  const where = `complaint_type='Street Light Condition' AND created_date>='${year}-01-01T00:00:00' AND created_date<'${year+1}-01-01T00:00:00' AND borough='MANHATTAN'`;
  const url = `${SOCRATA_URL}?$select=count(*)&$where=${encodeURIComponent(where)}`;

  const headers = { 'Accept': 'application/json' };
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) {
      return reply({ ok: false, value: null, year, detail: `Socrata HTTP ${r.status}` });
    }
    const rows = await r.json();
    const n = Number(rows[0]?.count_1 || rows[0]?.count || 0);
    const ok = n >= 1000 && n <= 30000;
    return reply({
      ok, value: n, year,
      detail: ok
        ? `live · ${year} Manhattan = ${n.toLocaleString()} complaints`
        : `unexpected count (${n}) — dataset schema may have changed`,
    });
  } catch (err) {
    clearTimeout(timer);
    return reply({
      ok: false, value: null, year,
      detail: `Socrata unreachable: ${err.message}`,
    });
  }
}
