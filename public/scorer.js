// Vendor scoring engine — equity-first matrix.
//
// One file, two consumers:
//   • Browser (production): loaded via <script type="module"> from index.html.
//   • Node (testing):       imported by scripts/test-scorer.mjs.
//
// Public API:
//   rankTop(complaint, vendorPool, journal, options)  → array of ranked picks
//   scoreVendor(complaint, vendor, journal, options)  → single vendor's score
//
// All scoring math lives here. vendors.json carries the static per-vendor
// inputs the build script pre-computed; this file applies the runtime inputs
// (proximity, workload, dollar-threshold context) and produces the 0-100 score
// plus the per-component breakdown the UI displays.

// ─────────────────────────────────────────────────────────────────────────────
// Constants

export const WEIGHTS = {
  workload_balance: 17,
  overlooked_but_qualified: 18,
  direct_purchase_eligibility: 15,
  demographic_equity: 15,
  proximity: 18,            // bumped from 13 → 18 so geography meaningfully ranks within the equity pool
  reliability: 10,
  baseline_capability: 4,
  capacity_headroom: 3,
};

const HARD_FILTERS = {
  radiusMiles: 10,          // tightened from 15 → 10; 15 mi crosses 4 boroughs for streetlight work
  requireLicenseActive: true,
};

const DIRECT_PURCHASE_THRESHOLD = 1_500_000;
const BOROUGH_SPREAD_CAP = 2;            // max vendors from one borough in top-N
const BOROUGH_SPREAD_TOLERANCE = 15;     // points within which we enforce the cap

// ─────────────────────────────────────────────────────────────────────────────
// Geometry

function haversineMiles(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null || Number.isNaN(v))) return Infinity;
  const R = 3958.8; // Earth radius in miles
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard filters — vendors that fail any of these are excluded entirely.

function hardFiltersPass(complaint, vendor, options = {}) {
  const radius = options.radiusMiles ?? HARD_FILTERS.radiusMiles;
  const fails = [];

  // License must be active
  if (HARD_FILTERS.requireLicenseActive) {
    const active = vendor.scoring_inputs?.reliability_proxy?.licenseActive;
    if (!active) fails.push('license_inactive');
  }

  // Within radius of complaint
  const miles = haversineMiles(
    complaint.lat, complaint.lng,
    vendor.address?.lat, vendor.address?.lng,
  );
  if (miles > radius) fails.push('outside_radius');

  // M/WBE-only mode: only direct-purchase-eligible vendors
  if (options.directPurchaseOnly) {
    const eligible = vendor.scoring_inputs?.direct_purchase_eligibility?.eligible;
    if (!eligible) fails.push('not_direct_purchase_eligible');
  }

  return { pass: fails.length === 0, fails, distanceMiles: miles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workload balance — component 1 (inverse).

function workloadBalanceScore(vendor, journal) {
  if (!journal || journal.length === 0) {
    return { points: WEIGHTS.workload_balance, weighted_dispatches: 0 };
  }
  const now = Date.now();
  const HALF_LIFE_DAYS = 60;
  let weighted = 0;
  for (const dispatch of journal) {
    if (dispatch.vendor_id !== vendor.id) continue;
    const dispatchTime = new Date(dispatch.dispatched_at).getTime();
    const daysAgo = (now - dispatchTime) / (1000 * 60 * 60 * 24);
    if (daysAgo < 0 || daysAgo > 365) continue;
    weighted += Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
  }
  // Inverse: 0 dispatches → full points. 5+ weighted → ~zero.
  const points = WEIGHTS.workload_balance / (1 + weighted);
  return { points, weighted_dispatches: weighted };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlooked-but-qualified — component 3 (inverse, tenure-modulated).

function overlookedScore(vendor) {
  const o = vendor.scoring_inputs?.overlooked || {};
  const awardCount5yr = o.awardCount5yr ?? 0;
  const yearsLicensed = o.yearsLicensed ?? 0;
  const yearsSinceLastAward = o.yearsSinceLastAward ?? yearsLicensed; // never awarded → use full tenure

  // award_drought: 0 awards in 5 yrs → 1.0; 10+ → 0.
  const award_drought = 1 - Math.min(1, awardCount5yr / 10);

  // tenure_bonus: 5+ yrs without recent work → 1.0; newer → less.
  const drought_years = Math.max(0, yearsLicensed - (yearsLicensed - yearsSinceLastAward));
  // If we don't have license-issue date, assume the vendor has been around long
  // enough to be "overlooked" by default (most are decades-old shops).
  const inferred_drought_years = yearsLicensed === 0 ? 5 : drought_years;
  const tenure_bonus = Math.min(1, inferred_drought_years / 5);

  const underuse_factor = award_drought * tenure_bonus;
  const points = WEIGHTS.overlooked_but_qualified * underuse_factor;
  return { points, award_drought, tenure_bonus, underuse_factor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct-purchase eligibility — component 8 (binary).
//
// If complaint.estimatedCost > $1.5M, the rule doesn't apply and this
// component contributes zero. Otherwise, eligibility flag → full points.

function directPurchaseScore(complaint, vendor) {
  const estimatedCost = complaint.estimatedCost ?? 0;
  const ruleApplies = estimatedCost <= DIRECT_PURCHASE_THRESHOLD;
  if (!ruleApplies) {
    return { points: 0, eligible: false, rule_applies: false,
             reason: `estimated_cost_${estimatedCost}_exceeds_${DIRECT_PURCHASE_THRESHOLD}` };
  }
  const dpe = vendor.scoring_inputs?.direct_purchase_eligibility || {};
  const eligible = !!dpe.eligible;
  return {
    points: eligible ? WEIGHTS.direct_purchase_eligibility : 0,
    eligible,
    rule_applies: true,
    reasons: dpe.reasons || {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Demographic equity — component 2 (positive, capped at weight).
// The points are pre-capped at 15 by build-vendors.py.

function demographicScore(vendor) {
  const points = vendor.scoring_inputs?.demographic_points ?? 0;
  const tags = vendor.scoring_inputs?.demographic_tags ?? [];
  return { points: Math.min(points, WEIGHTS.demographic_equity), tags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proximity — component 4 (positive).

function proximityScore(distanceMiles) {
  if (distanceMiles == null || !Number.isFinite(distanceMiles)) {
    return { points: 0, miles: null };
  }
  // Quadratic-ish decay so within-radius vendors are meaningfully differentiated:
  // 0 mi → 1.00     1 mi → 0.90     2 mi → 0.69     3 mi → 0.50
  // 5 mi → 0.26     8 mi → 0.11    10 mi → 0.08
  const m = distanceMiles / 3;
  const factor = 1 / (1 + m * m);
  return { points: WEIGHTS.proximity * factor, miles: distanceMiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reliability — component 5 (binary-ish).

function reliabilityScore(vendor) {
  const r = vendor.scoring_inputs?.reliability_proxy || {};
  const active = !!r.licenseActive;
  const terminations = r.terminations || 0;
  // Active license = full points; each termination subtracts 2 pts.
  const points = active ? Math.max(0, WEIGHTS.reliability - 2 * terminations) : 0;
  return { points, license_active: active, terminations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline capability — component 6 (binary).

function capabilityScore(vendor) {
  const cap = !!vendor.scoring_inputs?.baseline_capability;
  return { points: cap ? WEIGHTS.baseline_capability : 0, capable: cap };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capacity headroom — component 7 (inverse on recent $ awarded).

function headroomScore(vendor) {
  const amount = vendor.scoring_inputs?.capacity_headroom_amount_12mo ?? 0;
  // Vendors with $500K+ recent awards → no headroom. $0 → full points.
  const factor = 1 - Math.min(1, amount / 500_000);
  const points = WEIGHTS.capacity_headroom * factor;
  return { points, recent_12mo_amount: amount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score a single vendor against a complaint.

export function scoreVendor(complaint, vendor, journal = [], options = {}) {
  const filterResult = hardFiltersPass(complaint, vendor, options);
  if (!filterResult.pass) {
    return {
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      eligible: false,
      reason_excluded: filterResult.fails,
      distance_miles: filterResult.distanceMiles,
      total: 0,
      components: {},
    };
  }

  const wb  = workloadBalanceScore(vendor, journal);
  const ov  = overlookedScore(vendor);
  const dp  = directPurchaseScore(complaint, vendor);
  const dem = demographicScore(vendor);
  const px  = proximityScore(filterResult.distanceMiles);
  const rel = reliabilityScore(vendor);
  const cap = capabilityScore(vendor);
  const hd  = headroomScore(vendor);

  const total =
    wb.points + ov.points + dp.points + dem.points +
    px.points + rel.points + cap.points + hd.points;

  // Build the badges array — what the UI surfaces as colored chips.
  const badges = [];
  const cert = (vendor.certifications?.certification || '').toUpperCase();
  if (cert.includes('MBE')) badges.push('MBE');
  if (cert.includes('WBE')) badges.push('WBE');
  if (cert.includes('LBE')) badges.push('LBE');
  if (cert.includes('EBE')) badges.push('EBE');
  const eth = (vendor.certifications?.ethnicity || '').toLowerCase();
  if (eth === 'black')      badges.push('Black-owned');
  else if (eth === 'hispanic') badges.push('Hispanic-owned');
  else if (eth === 'asian') badges.push('Asian-owned');
  else if (eth === 'native') badges.push('Native-owned');
  if (vendor.certifications?.passportEnrolled) badges.push('PASSPort');
  if (dp.eligible) badges.push('Direct-Purchase Eligible');
  if (vendor.track_record?.awardsTotalCount === 0) badges.push('Overlooked');

  return {
    vendor_id: vendor.id,
    vendor_name: vendor.name,
    eligible: true,
    distance_miles: filterResult.distanceMiles,
    total: Math.round(total * 10) / 10,
    components: {
      workload_balance: Math.round(wb.points * 10) / 10,
      overlooked_but_qualified: Math.round(ov.points * 10) / 10,
      direct_purchase_eligibility: Math.round(dp.points * 10) / 10,
      demographic_equity: Math.round(dem.points * 10) / 10,
      proximity: Math.round(px.points * 10) / 10,
      reliability: Math.round(rel.points * 10) / 10,
      baseline_capability: Math.round(cap.points * 10) / 10,
      capacity_headroom: Math.round(hd.points * 10) / 10,
    },
    details: { workload: wb, overlooked: ov, direct_purchase: dp,
               demographic: dem, proximity: px, reliability: rel,
               capability: cap, headroom: hd },
    badges,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor tiering — three-stage pool used by the default rankTop.
//   eligible  = passes all four PPB Rule 3-08 conditions (the 101)
//   almost    = has M/WBE certification + active license but fails one of
//               PASSPort / NAICS-match / cert-not-expired (~48)
//   other     = no M/WBE certification, or inactive license (~1,745)

export function vendorTier(vendor) {
  const dpe = vendor.scoring_inputs?.direct_purchase_eligibility;
  if (!dpe) return 'other';
  if (dpe.eligible) return 'eligible';
  const r = dpe.reasons || {};
  if (r.hasMwbeCertification && r.licenseActive) return 'almost';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// Borough-spread soft constraint applied to a sorted candidate list.

function applyBoroughSpread(scored, vendors, topN) {
  if (scored.length <= topN) return scored.slice(0, topN);
  const result = [];
  const boroughCount = {};
  const vendorById = new Map(vendors.map(v => [v.id, v]));
  const topScore = scored[0].total;
  const tolerance = BOROUGH_SPREAD_TOLERANCE;

  for (const s of scored) {
    if (result.length >= topN) break;
    const borough = vendorById.get(s.vendor_id)?.address?.borough || '(unknown)';
    const currentCount = boroughCount[borough] || 0;

    // If under the cap, take freely.
    if (currentCount < BOROUGH_SPREAD_CAP) {
      result.push(s);
      boroughCount[borough] = currentCount + 1;
      continue;
    }
    // Over the cap: only allow if this vendor is much better than alternatives.
    // We allow if the next available cross-borough candidate is more than `tolerance` behind.
    const nextCrossBorough = scored.find(x =>
      !result.includes(x)
      && x.vendor_id !== s.vendor_id
      && (vendorById.get(x.vendor_id)?.address?.borough || '') !== borough
    );
    if (!nextCrossBorough || s.total - nextCrossBorough.total > tolerance) {
      result.push(s);
      boroughCount[borough] = currentCount + 1;
    }
    // else skip — wait for a cross-borough candidate.
  }
  // If borough cap left us short, fill remaining slots by raw score.
  if (result.length < topN) {
    for (const s of scored) {
      if (result.includes(s)) continue;
      result.push(s);
      if (result.length >= topN) break;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rank a vendor pool against a complaint, return top-N with breakdowns.

// Three-stage selection:
//   1. Try just the eligible pool (the 101 under PPB Rule 3-08).
//   2. If fewer than topN within radius, expand to "almost eligible" (~48
//      with M/WBE cert but failing one criterion).
//   3. If still fewer, expand to the full pool (1,894).
// Each pick is tagged with its tier so the UI can show what changed.

export function rankTop(complaint, vendorPool, journal = [], options = {}) {
  const topN = options.topN ?? 5;
  const allowAlmost = options.allowAlmost !== false;
  const allowOther  = options.allowOther  !== false;

  // Score every vendor once, then tag each result with its tier.
  const all = vendorPool.map(v => {
    const result = scoreVendor(complaint, v, journal, options);
    result.tier = vendorTier(v);
    return result;
  });

  const tier1Eligible = all.filter(s => s.eligible && s.tier === 'eligible');
  const tier2Almost   = all.filter(s => s.eligible && s.tier === 'almost');
  const tier3Other    = all.filter(s => s.eligible && s.tier === 'other');

  let candidates = [...tier1Eligible].sort((a, b) => b.total - a.total);
  let poolUsed = 'eligible-only';

  if (candidates.length < topN && allowAlmost) {
    candidates = [...tier1Eligible, ...tier2Almost].sort((a, b) => b.total - a.total);
    poolUsed = 'eligible-plus-almost';
  }
  if (candidates.length < topN && allowOther) {
    candidates = [...tier1Eligible, ...tier2Almost, ...tier3Other].sort((a, b) => b.total - a.total);
    poolUsed = 'full-pool';
  }

  const selected = options.skipBoroughSpread
    ? candidates.slice(0, topN)
    : applyBoroughSpread(candidates, vendorPool, topN);

  selected.sort((a, b) => b.total - a.total);

  return {
    picks: selected.map((s, i) => ({ ...s, rank: i + 1 })),
    poolUsed,
    poolStats: {
      tier1Eligible: tier1Eligible.length,
      tier2Almost:   tier2Almost.length,
      tier3Other:    tier3Other.length,
      withinRadius:  candidates.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser global fallback for non-module script tags.

if (typeof window !== 'undefined') {
  window.VendorScorer = { scoreVendor, rankTop, WEIGHTS };
}
