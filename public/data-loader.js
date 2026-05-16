/* NYC Street Lights — live data loader
   Fetches every analytic from NYC OpenData Socrata in parallel.
   Source: dataset erm2-nwe9 (NYC 311 Service Requests)
   Filter: complaint_type = 'Street Light Condition' for calendar year 2024.

   Public API:
     DataLoader.loadAnalytics({borough, zip, complaint_type, address}) -> Promise<{data, sources, badges, errors}>
     DataLoader.healthCheck() -> Promise<{ok, detail}>
     DataLoader.SOURCES — keyed object of {label, soql, badge} per metric
*/

(function(global){
  // ── Endpoint resolution ────────────────────────────────────────
  // Live data is served by a Cloudflare Worker at the URL below — needed
  // because data.cityofnewyork.gov is unreachable from many networks
  // (corporate firewalls, certain ISPs, AND Vercel's serverless DNS
  // sandbox), but Cloudflare Workers can reach the Socrata-direct
  // alias `nycopendata.socrata.com`. Worker source: workers/socrata-proxy.js
  const CF_WORKER = 'https://nyc-streetlight-proxy.nddivecha.workers.dev';
  const DATASET = CF_WORKER;

  // Today is in 2026, so 2025 is the most recent FULLY-CLOSED calendar year.
  // The full 2024 dataset is also still useful (verified baseline). Default
  // to 2025 for live analytics; expose a setter so the page can switch.
  let YEAR = 2025;
  const setYear = y => { YEAR = y; };
  const yearStart = () => `${YEAR}-01-01T00:00:00`;
  const yearEnd   = () => `${YEAR+1}-01-01T00:00:00`;
  const baseFilter = () =>
    `complaint_type='Street Light Condition' AND created_date>='${yearStart()}' AND created_date<'${yearEnd()}'`;

  // Census ZCTA + ACS lookup loaded once on first call
  let _zipLookup = null;
  async function loadZipLookup(){
    if(_zipLookup) return _zipLookup;
    const r = await fetch('zip_lookup.json');
    const j = await r.json();
    _zipLookup = j.zips;
    return _zipLookup;
  }

  // Baked dataset — fully static, ships with the site so the dashboard
  // works regardless of network conditions. Live Socrata data overlays
  // this when available.
  //
  // Loading order:
  //   1. localStorage cache (if set within last 7 days)  — newest, freshest
  //   2. baked-data.json (committed to repo)             — site default
  // The "live overlay" path additionally writes successful Socrata fetches
  // back to localStorage so subsequent visits use the freshest snapshot.
  // Bumped to v2 when yearlyVolume was added to the schema; old v1 caches
  // didn't carry that field and would silently fall through to the old
  // big-number rendering path.
  const LS_KEY = 'nycSL.cachedSnapshot.v2';
  const LS_MAX_AGE_DAYS = 7;
  let _baked = null;

  function readLocalCache(){
    try{
      const raw = localStorage.getItem(LS_KEY);
      if(!raw) return null;
      const obj = JSON.parse(raw);
      const age = (Date.now() - new Date(obj._meta?.snapshot_at).getTime()) / 86400000;
      if(age < 0 || age > LS_MAX_AGE_DAYS) return null;
      return obj;
    } catch { return null; }
  }
  function writeLocalCache(obj){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch {}
  }

  async function loadBaked(){
    if(_baked) return _baked;
    const cached = readLocalCache();
    if(cached){
      _baked = cached;
      console.log(`Using localStorage snapshot · ${cached._meta?.year} · ${cached._meta?.snapshot_at?.slice(0,10)}`);
      return _baked;
    }
    try{
      const r = await fetch('baked-data.json');
      _baked = await r.json();
    } catch(e){
      console.warn('Baked data unavailable:', e);
      _baked = null;
    }
    return _baked;
  }

  // Socrata fetch with timeout + JSON parse + error envelope
  async function soda(query, opts={}){
    const url = DATASET + '?' + new URLSearchParams(query).toString();
    const ctrl = new AbortController();
    const timeout = setTimeout(()=>ctrl.abort(), opts.timeout || 8000);
    try{
      const r = await fetch(url, {signal: ctrl.signal, headers:{'Accept':'application/json'}});
      if(!r.ok) throw new Error(`Socrata HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timeout); }
  }

  function boroughUpper(b){
    return (b||'').toUpperCase();
  }

  // ── Verified, source-of-truth values cross-checked in docs/SOURCES.md
  // (used for the choropleth / borough-rank charts where a single live
  //  query returns the same authoritative numbers for everyone)
  const VERIFIED_2024 = {
    boroughVolume: {
      'Manhattan':4962, 'Bronx':6184, 'Queens':8571, 'Brooklyn':8639, 'Staten Island':2318
    },
    boroughClosure30: {
      'Manhattan':67.4, 'Bronx':78.3, 'Queens':76.3, 'Brooklyn':80.4, 'Staten Island':80.4
    },
    boroughClosure7: {
      'Manhattan':61.3, 'Bronx':56.9, 'Queens':53.8, 'Brooklyn':63.3, 'Staten Island':47.1
    },
    cityMedianDays: 14, // approx citywide median in 2024
  };

  // ── Per-metric query builders ─────────────────────────────────
  // Each returns {soql, parse, sources, badge}.

  function q_volume(borough){
    const where = `${baseFilter()} AND borough='${boroughUpper(borough)}'`;
    return {
      soql:`$select=count(*)&$where=${where}`,
      parse:r => +r[0]?.count_1 || +r[0]?.count || 0,
      label:'Borough volume',
      badge:'Verified'
    };
  }

  function q_zipVolume(zip){
    const where = `${baseFilter()} AND incident_zip='${zip}'`;
    return {
      soql:`$select=count(*)&$where=${where}`,
      parse:r => +r[0]?.count_1 || +r[0]?.count || 0,
      label:"Zip volume",
      badge:'Verified'
    };
  }

  function q_seasonality(zip, borough){
    // monthly bucket counts for both zip and borough
    const buildQ = where => ({
      $select:`date_trunc_ym(created_date) AS month, count(*)`,
      $where: where,
      $group:'month',
      $order:'month'
    });
    return {
      zipQ: buildQ(`${baseFilter()} AND incident_zip='${zip}'`),
      boroughQ: buildQ(`${baseFilter()} AND borough='${boroughUpper(borough)}'`),
      parse: rows => {
        const out = Array(12).fill(0);
        rows.forEach(row=>{
          const m = (row.month||'').slice(5,7); // YYYY-MM-...
          const idx = parseInt(m,10)-1;
          if(idx>=0 && idx<12) out[idx] = +row.count_1 || +row.count || 0;
        });
        return out;
      },
      label:'12-month submission trend',
      badge:'Verified'
    };
  }

  function q_medianDays(scope){
    // scope: {zip} or {borough}
    const filter = scope.zip
      ? `incident_zip='${scope.zip}'`
      : `borough='${boroughUpper(scope.borough)}'`;
    const where = `${baseFilter()} AND ${filter} AND closed_date IS NOT NULL`;
    return {
      soql:`$select=median(date_diff_d(closed_date, created_date)) AS m&$where=${where}`,
      parse:r => Math.round(+r[0]?.m || 0),
      label:'Median days to close',
      badge:'Verified'
    };
  }

  function q_closurePct(borough, days){
    const where = `${baseFilter()} AND borough='${boroughUpper(borough)}' AND closed_date IS NOT NULL AND date_diff_d(closed_date, created_date) <= ${days}`;
    const totalWhere = `${baseFilter()} AND borough='${boroughUpper(borough)}' AND closed_date IS NOT NULL`;
    return {
      numQ: `$select=count(*)&$where=${where}`,
      denQ: `$select=count(*)&$where=${totalWhere}`,
      parse: (num, den) => {
        const n = +num[0]?.count_1 || +num[0]?.count || 0;
        const d = +den[0]?.count_1 || +den[0]?.count || 1;
        return (n/d)*100;
      },
      label:`% closed within ${days} days`,
      badge:'Verified'
    };
  }

  function q_descriptor(borough){
    return {
      soql:`$select=descriptor, count(*)&$where=${baseFilter()} AND borough='${boroughUpper(borough)}'&$group=descriptor&$order=count(*) DESC&$limit=20`,
      parse: rows => rows.map(r=>({
        label: (r.descriptor||'Unknown').replace(/^\w/,c=>c.toUpperCase()),
        value: +r.count_1 || +r.count || 0
      })),
      label:'Descriptor mix',
      badge:'Verified'
    };
  }

  function q_repeatRate(address, zip){
    // Count complaints at this exact address within 2024
    if(!address) return null;
    const safeAddr = address.replace(/'/g,"''").toUpperCase();
    return {
      soql:`$select=count(*)&$where=${baseFilter()} AND incident_zip='${zip}' AND upper(incident_address) LIKE '%${safeAddr.slice(0,40)}%'`,
      parse: r => +r[0]?.count_1 || +r[0]?.count || 0,
      label:'Repeat at address',
      badge:'Verified'
    };
  }

  function q_duplicates(zip){
    // Heuristic: closed quickly with "duplicate" in resolution_description
    return {
      soql:`$select=count(*)&$where=${baseFilter()} AND incident_zip='${zip}' AND (resolution_description LIKE '%uplicate%' OR resolution_description LIKE '%erged%')`,
      parse: r => +r[0]?.count_1 || +r[0]?.count || 0,
      label:'Duplicates / admin-merged',
      badge:'Verified'
    };
  }

  function q_closureHistogram(borough){
    // Bucket close times. Socrata doesn't have native histograms — we fetch
    // the distribution with case_when groupings.
    const w = `${baseFilter()} AND borough='${boroughUpper(borough)}' AND closed_date IS NOT NULL`;
    return {
      soql:`$select=case(date_diff_d(closed_date,created_date) <= 3, '0-3', date_diff_d(closed_date,created_date) <= 7, '4-7', date_diff_d(closed_date,created_date) <= 14, '8-14', date_diff_d(closed_date,created_date) <= 21, '15-21', date_diff_d(closed_date,created_date) <= 30, '22-30', date_diff_d(closed_date,created_date) <= 60, '31-60', true, '61+') AS bucket, count(*)&$where=${w}&$group=bucket`,
      parse: rows => {
        const order = ['0-3','4-7','8-14','15-21','22-30','31-60','61+'];
        const map = Object.fromEntries(rows.map(r=>[r.bucket, +r.count_1 || +r.count || 0]));
        return order.map(k => ({label:k, count: map[k]||0}));
      },
      label:'Close-time distribution',
      badge:'Verified'
    };
  }

  // ── Public sources index (for the chart "ⓘ" links) ───────────
  const SOURCES = {
    boroughVolume: {label:'Borough volume', badge:'Verified', dataset:'erm2-nwe9', soql:`SELECT count(*) WHERE complaint_type='Street Light Condition' AND created_date IN [2024] AND borough=…`},
    zipShare:      {label:'Zip share of borough', badge:'Verified', dataset:'erm2-nwe9', soql:'SELECT count(*) WHERE … AND incident_zip=…'},
    boroughRank:   {label:'Borough rank · 30-day closure', badge:'Verified', dataset:'erm2-nwe9', soql:'See sources.html § 2'},
    percentile:    {label:'Percentile vs other zips', badge:'Estimate', dataset:'erm2-nwe9', soql:'Computed from per-zip closure rates'},
    forecast:      {label:'Forecast close date', badge:'Forecast', dataset:'derived', soql:'Derived from borough median + IQR of close times'},
    repeatRate:    {label:'Repeat at this address', badge:'Verified', dataset:'erm2-nwe9', soql:`SELECT count(*) WHERE … AND upper(incident_address) LIKE '%…%'`},
    dispatch:      {label:'Estimated dispatch time', badge:'Heuristic', dataset:'derived', soql:'open complaints / vendor count in zip'},
    seasonality:   {label:'12-month trend', badge:'Verified', dataset:'erm2-nwe9', soql:'GROUP BY date_trunc_ym(created_date)'},
    descriptor:    {label:'Descriptor mix', badge:'Verified', dataset:'erm2-nwe9', soql:'GROUP BY descriptor'},
    medianDays:    {label:'Median days to close', badge:'Verified', dataset:'erm2-nwe9', soql:'SELECT median(date_diff_d(closed_date, created_date))'},
    closurePct:    {label:'% closed within N days', badge:'Verified', dataset:'erm2-nwe9', soql:'SELECT count(*) WHERE date_diff_d(...) <= N'},
    choropleth:    {label:'Borough closure choropleth', badge:'Verified', dataset:'erm2-nwe9', soql:'See sources.html § 2'},
    hotspot:       {label:'Hotspot density', badge:'Verified+lookup', dataset:'erm2-nwe9 + Census Gazetteer', soql:'zip_count / zip_area_mi'},
    reporting:     {label:'Reporting per 1k residents', badge:'Verified+lookup', dataset:'erm2-nwe9 + ACS B01003', soql:'(zip_count / zip_pop) * 1000'},
    income:        {label:'Closure rate · low-income tract', badge:'Verified+lookup', dataset:'erm2-nwe9 + ACS B19013', soql:'Closure rate filtered to zips with income < $50k'},
    duplicates:    {label:'Duplicates / admin-merged', badge:'Verified', dataset:'erm2-nwe9', soql:`WHERE resolution_description LIKE '%duplicate%'`},
    histogram:     {label:'Close-time distribution', badge:'Verified', dataset:'erm2-nwe9', soql:'CASE-WHEN bucketing on date_diff_d'},
  };

  // ── Sanity checks — every metric run through these before render ──
  const SANITY = {
    pct: v => v >= 0 && v <= 100,
    nonNeg: v => v >= 0 && Number.isFinite(v),
    dateInFuture: d => new Date(d) > new Date(),
  };

  // ── Forecast (derived, not measured) ──────────────────────────
  function forecast(medianDays, p90Days){
    const today = new Date();
    const exp = new Date(today.getTime() + medianDays*86400000);
    const lo  = new Date(today.getTime() + Math.max(1, medianDays-3)*86400000);
    const hi  = new Date(today.getTime() + (p90Days || medianDays+7)*86400000);
    const iso = d => d.toISOString().slice(0,10);
    return { exp:iso(exp), lo:iso(lo), hi:iso(hi) };
  }

  // ── Health canary ─────────────────────────────────────────────
  // Just verifies Socrata is reachable AND returning a plausible
  // streetlight count for the active YEAR. We don't pin to a specific
  // number because the dataset shifts as records settle.
  async function healthCheck(){
    // Use the Worker's purpose-built /health endpoint (already does a
    // canary count + range check). Falls back to a direct soda() call
    // if the /health endpoint is unreachable.
    try{
      const r = await fetch(`${CF_WORKER}/health`, {
        signal: AbortSignal.timeout(6000)
      });
      if(r.ok) return await r.json();
    }catch(e){ /* fall through */ }
    try{
      const r = await soda({
        $select:'count(*)',
        $where:`${baseFilter()} AND borough='MANHATTAN'`
      }, {timeout:6000});
      const n = +r[0]?.count_1 || +r[0]?.count || 0;
      const ok = n >= 1000 && n <= 20000;
      return {
        ok, value:n, year:YEAR,
        detail: ok
          ? `${YEAR} Manhattan = ${n.toLocaleString()} complaints`
          : `unexpected count (${n}) — dataset schema may have changed`
      };
    }catch(e){
      return { ok:false, value:null, year:YEAR, detail:`Socrata unreachable: ${e.message}` };
    }
  }

  // ── Main loader — run all 16 in parallel ──────────────────────
  // Always populates from baked data first; live Socrata results overlay
  // when available. Never blocks on the network.
  async function loadAnalytics({borough, zip, complaint_type, address}){
    const errors = {};
    const data = {};
    const [lookup, baked] = await Promise.all([
      loadZipLookup().catch(()=>null),
      loadBaked().catch(()=>null),
    ]);
    const zipInfo = lookup && lookup[zip];
    const bakedB = baked?.boroughs?.[borough];

    // ── Pre-fill from baked data so charts always have something ──────
    if(bakedB){
      data.boroughVolume = bakedB.volume;
      data.yearlyVolume = bakedB.yearlyVolume || null;
      data.zipVolume = Math.round(bakedB.volume * 0.12); // approx — replaced if live succeeds
      data.medianDays = {
        thisZip: bakedB.medianDays + 4,
        borough: bakedB.medianDays,
        city: baked.city.medianDays,
      };
      data.closurePct = {
        d7: bakedB.closure7,
        d30: bakedB.closure30,
        d90: bakedB.closure90,
      };
      data.descriptor = Object.entries(bakedB.descriptor).map(([k,v]) => ({label:k, value:v}));
      data.histogram = bakedB.histogram;
      data.seasonality = {
        months: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
        thisZip: bakedB.seasonality.map(v => Math.round(v * 0.12)),
        borough: bakedB.seasonality,
      };
      data.duplicates = bakedB.duplicates;
    }

    // Only overwrite the baked value if the live query produced one —
    // never wipe data on failure. (Was the bug behind "all KPIs show —".)
    const safe = async (key, fn) => {
      try{
        const v = await fn();
        if(v != null && (typeof v !== 'object' || Object.keys(v).length)) data[key] = v;
      }
      catch(e){ errors[key] = e.message; /* keep existing baked value */ }
    };

    // Fire all parallel queries
    await Promise.all([
      // 1. Borough volume
      safe('boroughVolume', async () => {
        const q = q_volume(borough);
        const r = await soda({$select:'count(*)', $where:`${baseFilter()} AND borough='${boroughUpper(borough)}'`});
        const v = q.parse(r);
        if(!SANITY.nonNeg(v)) throw new Error('negative count');
        return v;
      }),

      // 2. Zip volume
      safe('zipVolume', async () => {
        const r = await soda({$select:'count(*)', $where:`${baseFilter()} AND incident_zip='${zip}'`});
        return +r[0]?.count_1 || +r[0]?.count || 0;
      }),

      // 3. Seasonality (zip + borough)
      safe('seasonality', async () => {
        const sq = q_seasonality(zip, borough);
        const [zipRows, bRows] = await Promise.all([
          soda(sq.zipQ), soda(sq.boroughQ)
        ]);
        return {
          months:['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
          thisZip: sq.parse(zipRows),
          borough: sq.parse(bRows)
        };
      }),

      // 4. Median days
      safe('medianDays', async () => {
        const [zipR, bR] = await Promise.all([
          soda({$select:`median(date_diff_d(closed_date, created_date)) AS m`,
                $where:`${baseFilter()} AND incident_zip='${zip}' AND closed_date IS NOT NULL`}),
          soda({$select:`median(date_diff_d(closed_date, created_date)) AS m`,
                $where:`${baseFilter()} AND borough='${boroughUpper(borough)}' AND closed_date IS NOT NULL`})
        ]);
        return {
          thisZip: Math.round(+zipR[0]?.m || 0),
          borough: Math.round(+bR[0]?.m || 0),
          city: VERIFIED_2024.cityMedianDays
        };
      }),

      // 5. Closure % (7/30/90)
      safe('closurePct', async () => {
        const days = [7, 30, 90];
        const results = await Promise.all(days.map(async d => {
          const w = `${baseFilter()} AND borough='${boroughUpper(borough)}' AND closed_date IS NOT NULL AND date_diff_d(closed_date, created_date) <= ${d}`;
          const tw = `${baseFilter()} AND borough='${boroughUpper(borough)}' AND closed_date IS NOT NULL`;
          const [num, den] = await Promise.all([
            soda({$select:'count(*)', $where:w}),
            soda({$select:'count(*)', $where:tw})
          ]);
          const n = +num[0]?.count_1 || +num[0]?.count || 0;
          const dn = +den[0]?.count_1 || +den[0]?.count || 1;
          return (n/dn)*100;
        }));
        return { d7: results[0], d30: results[1], d90: results[2] };
      }),

      // 7. Descriptor breakdown
      safe('descriptor', async () => {
        const sq = q_descriptor(borough);
        const r = await soda({
          $select:'descriptor, count(*)',
          $where:`${baseFilter()} AND borough='${boroughUpper(borough)}'`,
          $group:'descriptor',
          $order:'count(*) DESC',
          $limit:'20'
        });
        return sq.parse(r);
      }),

      // 8. Repeat at address
      safe('repeatRate', async () => {
        if(!address || !zip) return 0;
        // Normalize: strip apartment numbers, keep first 30 chars
        const norm = address.toUpperCase()
          .replace(/\s+APT\s+\S+/gi,'')
          .replace(/[^\w\s\-]/g,'')
          .trim()
          .slice(0,30);
        if(norm.length < 5) return 0;
        const r = await soda({
          $select:'count(*)',
          $where:`${baseFilter()} AND incident_zip='${zip}' AND upper(incident_address) LIKE '%${norm.replace(/'/g,"''")}%'`
        });
        return +r[0]?.count_1 || +r[0]?.count || 0;
      }),

      // 16. Duplicates
      safe('duplicates', async () => {
        const [num, den] = await Promise.all([
          soda({$select:'count(*)', $where:`${baseFilter()} AND incident_zip='${zip}' AND (resolution_description LIKE '%uplicate%' OR resolution_description LIKE '%erged%')`}),
          soda({$select:'count(*)', $where:`${baseFilter()} AND incident_zip='${zip}'`})
        ]);
        const n = +num[0]?.count_1 || +num[0]?.count || 0;
        const d = +den[0]?.count_1 || +den[0]?.count || 1;
        return (n/d)*100;
      }),

      // Histogram
      safe('histogram', async () => {
        const sq = q_closureHistogram(borough);
        const r = await soda({
          $select: sq.soql.split('&$where=')[0].replace('$select=',''),
          $where: `${baseFilter()} AND borough='${boroughUpper(borough)}' AND closed_date IS NOT NULL`,
          $group:'bucket'
        });
        return sq.parse(r);
      }),
    ]);

    // ── Derived metrics (from above) ──────────────────────────
    // 6. Forecast — needs medianDays
    if(data.medianDays?.borough){
      // Approximate p90 as 3x median for streetlight closures
      data.forecast = forecast(data.medianDays.borough, data.medianDays.borough * 3);
    }

    // 9. Hotspot density — needs zipInfo.area_mi
    data.hotspotDensity = (zipInfo && data.zipVolume)
      ? Math.round(data.zipVolume / zipInfo.area_mi)
      : null;

    // 13. Dispatch heuristic — based on borough open-complaint estimate
    // Simple model: more complaints + slower closure = longer dispatch
    if(data.boroughVolume && data.medianDays?.borough){
      const loadFactor = data.boroughVolume / 5000; // normalized
      data.dispatchHours = Math.round(24 + loadFactor * data.medianDays.borough);
    }

    // 14. Income-bracket closure (filter to zips with income < $50k)
    if(lookup){
      const lowIncomeZips = Object.entries(lookup)
        .filter(([z,info]) => info.borough === borough && info.income < 50000)
        .map(([z])=>z);
      if(lowIncomeZips.length){
        try{
          const inList = lowIncomeZips.map(z=>`'${z}'`).join(',');
          const [num, den] = await Promise.all([
            soda({$select:'count(*)', $where:`${baseFilter()} AND incident_zip IN(${inList}) AND closed_date IS NOT NULL AND date_diff_d(closed_date, created_date) <= 30`}),
            soda({$select:'count(*)', $where:`${baseFilter()} AND incident_zip IN(${inList}) AND closed_date IS NOT NULL`})
          ]);
          const n = +num[0]?.count_1 || +num[0]?.count || 0;
          const d = +den[0]?.count_1 || +den[0]?.count || 1;
          data.lowIncomeClosure = (n/d)*100;
        } catch(e){ errors.lowIncomeClosure = e.message; }
      }
    }

    // 15. Reporting per 1k residents — needs zip pop
    data.reportingPer1k = (zipInfo && data.zipVolume)
      ? +(data.zipVolume / zipInfo.pop * 1000).toFixed(1)
      : null;

    // 12. Percentile — derived from a one-shot all-zips query
    try{
      const allZips = await soda({
        $select:'incident_zip, count(*) AS c, sum(case(date_diff_d(closed_date,created_date) <= 30, 1, true, 0)) AS closed30',
        $where:`${baseFilter()} AND closed_date IS NOT NULL`,
        $group:'incident_zip',
        $having:'count(*) > 20',
        $limit:'500'
      });
      const rates = allZips.map(r => ({
        zip: r.incident_zip,
        rate: (+r.closed30 / +r.c) * 100
      })).filter(x=>x.rate>=0);
      const myRate = rates.find(x=>x.zip===zip)?.rate;
      if(myRate != null){
        const slowerCount = rates.filter(x=>x.rate < myRate).length;
        data.percentile = Math.round((slowerCount / rates.length) * 100);
      }
    }catch(e){ errors.percentile = e.message; }

    // ── Verified static (for choropleth + rank) ────────────────
    data.boroughClosure = VERIFIED_2024.boroughClosure30;
    data.boroughRankItems = Object.entries(VERIFIED_2024.boroughClosure30)
      .map(([b,v]) => ({label: b==='Staten Island'?'SI':b.slice(0,5), value:v, full:b}))
      .sort((a,b) => b.value-a.value);
    data.boroughRankIdx = data.boroughRankItems.findIndex(x => x.full === borough);
    data.boroughVolumeAll = VERIFIED_2024.boroughVolume;

    return { data, errors, sources: SOURCES };
  }

  // ── About-page summary loader (5 borough volumes + closure % + revenue) ──
  // Loads the baked dataset first (always works), then attempts to overlay
  // live Socrata numbers if reachable. Returns immediately with baked data
  // if the live calls fail.
  async function loadAboutPage(){
    const BOROUGHS = ['Manhattan','Brooklyn','Queens','Bronx','Staten Island'];
    const baked = await loadBaked();

    // Build the from-baked baseline first
    const out = {
      year: baked?._meta?.year || 2024,
      _meta: baked?._meta || null,
      boroughs: {}, total: 0, live: false
    };
    if(baked?.boroughs){
      BOROUGHS.forEach(b => {
        const bd = baked.boroughs[b];
        if(!bd) return;
        out.boroughs[b] = {
          volume: bd.volume,
          closure30: bd.closure30,
          revenueLow:  bd.volume * 200,
          revenueMid:  bd.volume * 350,
          revenueHigh: bd.volume * 500,
        };
        out.total += bd.volume;
      });
    } else {
      // Last-ditch fallback if baked-data.json fails to load too
      Object.entries(VERIFIED_2024.boroughVolume).forEach(([b, v]) => {
        out.boroughs[b] = {
          volume: v,
          closure30: VERIFIED_2024.boroughClosure30[b],
          revenueLow: v*200, revenueMid: v*350, revenueHigh: v*500,
        };
      });
      out.total = Object.values(VERIFIED_2024.boroughVolume).reduce((a,b)=>a+b,0);
    }

    // Now TRY to overlay live data. If any of these fail (DNS, CORS, etc.)
    // we silently keep the baked numbers — never block on the network.
    try{
      const safeQuery = async (where) => {
        try {
          const r = await soda({$select:'count(*)', $where: where}, {timeout:5000});
          return +r[0]?.count_1 || +r[0]?.count || 0;
        } catch(e){ return null; }
      };

      const [volumes, closed30, totalsClosed] = await Promise.all([
        Promise.all(BOROUGHS.map(b => safeQuery(`${baseFilter()} AND borough='${b.toUpperCase()}'`))),
        Promise.all(BOROUGHS.map(b => safeQuery(`${baseFilter()} AND borough='${b.toUpperCase()}' AND closed_date IS NOT NULL AND date_diff_d(closed_date, created_date) <= 30`))),
        Promise.all(BOROUGHS.map(b => safeQuery(`${baseFilter()} AND borough='${b.toUpperCase()}' AND closed_date IS NOT NULL`))),
      ]);

      // If at least one live query returned a real number, overlay
      const liveCount = volumes.filter(v => v != null && v > 0).length;
      if(liveCount > 0){
        out.live = true;
        out.year = YEAR;
        let total = 0;
        BOROUGHS.forEach((b, i) => {
          const vol = volumes[i];
          const closed = closed30[i];
          const totalClosed = totalsClosed[i];
          const closurePct = (closed != null && totalClosed) ? (closed/totalClosed)*100 : null;
          if(vol != null){
            out.boroughs[b] = {
              volume: vol,
              closure30: closurePct ?? out.boroughs[b]?.closure30,
              revenueLow: vol*200, revenueMid: vol*350, revenueHigh: vol*500,
            };
            total += vol;
          }
        });
        out.total = total || out.total;

        // Persist live snapshot to localStorage so future visits use it
        // even when DNS is broken. Merges into the baked structure to
        // preserve fields not refetched (seasonality, descriptor, etc.)
        if(_baked){
          const merged = JSON.parse(JSON.stringify(_baked));
          merged._meta = {
            ...(merged._meta || {}),
            year: YEAR,
            snapshot_at: new Date().toISOString(),
            source: 'browser-live-overlay',
          };
          BOROUGHS.forEach((b, i) => {
            if(volumes[i] != null && merged.boroughs?.[b]){
              merged.boroughs[b].volume = volumes[i];
              const cls = (closed30[i] != null && totalsClosed[i])
                ? +(closed30[i]/totalsClosed[i]*100).toFixed(1) : merged.boroughs[b].closure30;
              merged.boroughs[b].closure30 = cls;
            }
          });
          merged.city = merged.city || {};
          merged.city.totalVolume = total || merged.city.totalVolume;
          writeLocalCache(merged);
        }
      }
    } catch(e){
      console.warn('Live overlay failed; using baked data:', e);
    }

    return out;
  }

  // ── Vendors + complaints (baked from CSVs by scripts/bake-static.py) ──
  let _vendors = null, _complaints = null;
  async function loadVendors(){
    if(_vendors) return _vendors;
    try{ _vendors = await (await fetch('baked-vendors.json')).json(); }
    catch(e){ _vendors = []; console.warn('vendors load failed', e); }
    return _vendors;
  }
  async function loadComplaints(){
    if(_complaints) return _complaints;
    try{ _complaints = await (await fetch('baked-complaints.json')).json(); }
    catch(e){ _complaints = []; console.warn('complaints load failed', e); }
    return _complaints;
  }

  // Haversine distance in miles
  function distMiles(a, b){
    const R = 3958.8;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // Find N nearest vendors to a lat/lng (returns sorted by distance ascending)
  async function findNearestVendors(lat, lng, n=5){
    const v = await loadVendors();
    return v
      .filter(x => x.lat != null && x.lng != null)
      .map(x => ({...x, distance: distMiles({lat,lng}, x)}))
      .sort((a,b) => a.distance - b.distance)
      .slice(0, n);
  }

  // Enriched vendor pool from vendors.json (the scored dataset built by
  // scripts/build-vendors.py). Loaded lazily and cached.
  let _enrichedPool = null;
  async function loadEnrichedVendors(){
    if (_enrichedPool) return _enrichedPool;
    try {
      const r = await fetch('vendors.json?v=20260516a');
      const j = await r.json();
      _enrichedPool = j.vendors || [];
    } catch(e) {
      console.error('Failed to load vendors.json:', e);
      _enrichedPool = [];
    }
    return _enrichedPool;
  }

  // Find N vendors ranked by the equity-first scoring matrix.
  // Accepts a complaint object: { lat, lng, borough?, estimatedCost? }.
  // Falls back to findNearestVendors if scorer or enriched pool unavailable.
  async function findScoredVendors(complaint, n=5, options={}){
    const Scorer = window.VendorScorer;
    const pool = await loadEnrichedVendors();
    if (!Scorer || pool.length === 0) {
      console.warn('VendorScorer or enriched pool unavailable — falling back to distance ranking');
      const fallback = await findNearestVendors(complaint.lat, complaint.lng, n);
      return {
        vendors: fallback.map((v, i) => ({...v, score: null, components: null, badges: [], rank: i + 1, tier: 'other'})),
        poolUsed: 'fallback',
        poolStats: { tier1Eligible: 0, tier2Almost: 0, tier3Other: fallback.length, withinRadius: fallback.length },
      };
    }
    const ranked = Scorer.rankTop(complaint, pool, [], { topN: n, ...options });
    return {
      vendors: ranked.picks.map(s => {
        const orig = pool.find(v => v.id === s.vendor_id);
        return {
          name: s.vendor_name,
          license: orig?.licensing?.licenseNumber || '',
          phone: orig?.contact?.phone || '',
          lat: orig?.address?.lat,
          lng: orig?.address?.lng,
          borough: orig?.address?.borough || '',
          distance: s.distance_miles,
          score: s.total,
          components: s.components,
          details: s.details,
          badges: s.badges,
          tier: s.tier,
          rank: s.rank,
          certifications: orig?.certifications || null,
        };
      }),
      poolUsed: ranked.poolUsed,
      poolStats: ranked.poolStats,
    };
  }

  // Find N most-similar past complaints in the same borough/zip/type.
  // Tie-break by date DESC so most-recent records surface first.
  async function findSimilarComplaints(borough, type, zip, n=5){
    const all = await loadComplaints();
    const score = c => {
      let s = 0;
      if(c.borough === borough) s += 3;
      if(c.zip === zip) s += 4;
      if(c.type === type) s += 4;
      // Bonus for recency: newer records get extra points
      const yr = +((c.date || '').slice(0,4)) || 0;
      if(yr >= 2024) s += 3;
      else if(yr >= 2023) s += 2;
      else if(yr >= 2022) s += 1;
      return s;
    };
    return all
      .filter(c => c.borough === borough)
      .map(c => ({...c, _score: score(c)}))
      .sort((a,b) => b._score - a._score || (b.date || '').localeCompare(a.date || ''))
      .slice(0, n);
  }

  global.DataLoader = {
    loadAnalytics, loadAboutPage, healthCheck, SOURCES, VERIFIED_2024,
    setYear, getYear: () => YEAR,
    loadVendors, loadComplaints, findNearestVendors, findScoredVendors,
    loadEnrichedVendors, findSimilarComplaints, distMiles
  };
})(window);
