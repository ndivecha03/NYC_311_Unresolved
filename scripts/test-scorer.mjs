// Test harness for public/scorer.js — runs the equity-first matrix against
// vendors.json with five representative complaints (one per borough) and
// prints the top-5 with full component breakdowns.
//
// Usage:  node scripts/test-scorer.mjs
//         node scripts/test-scorer.mjs --direct-purchase-only
//         node scripts/test-scorer.mjs --cost 2000000   (above $1.5M threshold)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { rankTop, scoreVendor, WEIGHTS } from '../public/scorer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const directPurchaseOnly = flag('--direct-purchase-only');
const estimatedCost = Number(value('--cost', '5000'));

const vendorsData = JSON.parse(
  readFileSync(resolve(ROOT, 'public/vendors.json'), 'utf8')
);
const journal = [];  // empty dispatch journal for now

// Five test complaints — rough borough centroids.
const complaints = [
  { id: 'TEST-BX', borough: 'Bronx',         lat: 40.8448, lng: -73.8648, estimatedCost },
  { id: 'TEST-BK', borough: 'Brooklyn',      lat: 40.6782, lng: -73.9442, estimatedCost },
  { id: 'TEST-MN', borough: 'Manhattan',     lat: 40.7831, lng: -73.9712, estimatedCost },
  { id: 'TEST-QN', borough: 'Queens',        lat: 40.7282, lng: -73.7949, estimatedCost },
  { id: 'TEST-SI', borough: 'Staten Island', lat: 40.5795, lng: -74.1502, estimatedCost },
];

console.log('═'.repeat(90));
console.log('VENDOR SCORER TEST HARNESS');
console.log('═'.repeat(90));
console.log(`Pool: ${vendorsData.vendors.length} vendors  ·  `
          + `direct_purchase_only=${directPurchaseOnly}  ·  estimated_cost=$${estimatedCost.toLocaleString()}`);
console.log(`Weights: ${JSON.stringify(WEIGHTS)}`);

for (const c of complaints) {
  console.log('\n' + '─'.repeat(90));
  console.log(`Complaint ${c.id}  ·  ${c.borough}  ·  (${c.lat}, ${c.lng})`);
  console.log('─'.repeat(90));

  const result = rankTop(c, vendorsData.vendors, journal, {
    topN: 5,
    directPurchaseOnly,
  });
  const top = result.picks;

  console.log(`  pool used: ${result.poolUsed}  ·  `
            + `tier1=${result.poolStats.tier1Eligible}  `
            + `tier2=${result.poolStats.tier2Almost}  `
            + `tier3=${result.poolStats.tier3Other}  `
            + `(within ${10}mi radius)`);

  if (top.length === 0) {
    console.log('  (no vendors passed hard filters)');
    continue;
  }

  for (const pick of top) {
    const dist = pick.distance_miles?.toFixed(1) ?? '?';
    console.log(`\n  #${pick.rank}  ${pick.vendor_name}    score=${pick.total}   dist=${dist} mi   tier=${pick.tier}`);
    const c = pick.components;
    const parts = [
      `wkld:${c.workload_balance}`,
      `overlk:${c.overlooked_but_qualified}`,
      `dirPurch:${c.direct_purchase_eligibility}`,
      `demo:${c.demographic_equity}`,
      `prox:${c.proximity}`,
      `rel:${c.reliability}`,
      `cap:${c.baseline_capability}`,
      `headrm:${c.capacity_headroom}`,
    ];
    console.log(`        ${parts.join('  ')}`);
    if (pick.badges.length) {
      console.log(`        badges: [ ${pick.badges.join(' · ')} ]`);
    }
  }
}

console.log('\n' + '═'.repeat(90));
console.log('DONE');
