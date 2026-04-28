// Vercel serverless function (Node.js): GET /api/health
//
// Same DoH + SNI workaround as socrata-proxy.js: Vercel's serverless DNS
// can't resolve data.cityofnewyork.gov, so we look up the IP via
// Cloudflare 1.1.1.1's DNS-over-HTTPS endpoint and connect by IP with
// explicit SNI for TLS cert validation.

import https from 'node:https';

const SOCRATA_HOSTNAME = 'data.cityofnewyork.gov';
const TIMEOUT_MS = 8000;

function pickYear() {
  const now = new Date();
  return now.getUTCMonth() > 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear() - 2;
}

async function resolveIp(hostname) {
  const r = await fetch(
    `https://1.1.1.1/dns-query?name=${hostname}&type=A`,
    { headers: { 'accept': 'application/dns-json' } }
  );
  const j = await r.json();
  const ans = (j.Answer || []).find(a => a.type === 1);
  if (!ans) throw new Error(`DoH: no A record for ${hostname}`);
  return ans.data;
}

function httpsGetByIp(ip, hostname, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: ip, port: 443, path,
      servername: hostname,
      headers: {
        'Host': hostname,
        'Accept': 'application/json',
        'User-Agent': 'NYC-Street-Lights/1.0 (Vercel)',
        ...extraHeaders,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
  });
}

export default async function handler(req, res) {
  const year = pickYear();
  const where = `complaint_type='Street Light Condition' AND created_date>='${year}-01-01T00:00:00' AND created_date<'${year+1}-01-01T00:00:00' AND borough='MANHATTAN'`;
  const path = `/resource/erm2-nwe9.json?$select=count(*)&$where=${encodeURIComponent(where)}`;

  const extra = {};
  if (process.env.SOCRATA_APP_TOKEN) extra['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const ip = await resolveIp(SOCRATA_HOSTNAME);
    const result = await httpsGetByIp(ip, SOCRATA_HOSTNAME, path, extra);

    if (result.status >= 400) {
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: false, value: null, year, ip,
        detail: `Socrata HTTP ${result.status}`,
      }));
    }
    const rows = JSON.parse(result.body);
    const n = Number(rows[0]?.count_1 || rows[0]?.count || 0);
    const ok = n >= 1000 && n <= 30000;
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok, value: n, year, ip,
      detail: ok
        ? `live · ${year} Manhattan = ${n.toLocaleString()} complaints`
        : `unexpected count (${n}) — dataset schema may have changed`,
    }));
  } catch (err) {
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false, value: null, year,
      detail: `${err.message || err.toString()}`,
      cause: err.cause?.message || null,
    }));
  }
}
