# Project Handoff — NYC Streetlight Complaint Hub

**Status as of 2026-05-13**
**Audience:** Mithran (partner) — what changed since the microgrant draft, why, and what's next.

---

## 1. Where we are

The microgrant request has been submitted to E&I Hub. The live NYC dashboard is shipping the narrative-arc layout (hourglass background, side-rail TOC, intake form → work-order → analysis flow). The repo is on `main` at GitHub — Vercel auto-deploys on every push.

**Live site:** https://nyc-streelight.com/
**Repo:** https://github.com/ndivecha03/NYC_311_Unresolved
**Local working dir:** `C:\Users\nishd\OneDrive\Desktop\NYC Street Lights\`

---

## 2. Changes made after the microgrant draft

In commit order (most recent first):

| Commit | Change | Why |
|---|---|---|
| `0203258` | Fixed label overlap on boxplot ticks and sparkline endpoint values | "min" / "Q1" were colliding when distributions were tight; first/last point labels in the volume trend were running into the y-axis numbers. Boxplot now drops `min` if it sits within 36px of `Q1` (same for `max`/`Q3`). Sparkline anchors first label `start` and last label `end` so they shift inward away from y-axis. |
| `a6aea53` | Revenue chart in the "Why" section now scopes to the 4,096 stuck tickets, not the full 33,835 annual volume | The chart was implying revenue across all annual complaints; the actual unlock is the backlog clearing. New range: $0.82M – $2.05M. Copy updated to match. |
| `7503e40` | Added sequential workflow diagram (7-step pipeline from complaint submission → vendor dispatch) | Visualizes which steps the tool compresses (steps 2–5 collapse from ~1 week of paperwork to under 2 minutes). Lives in a new `#workflow` section between Why and Beyond-Streetlights; added a TOC entry. |
| earlier | Borough revenue stack + time-compression bars in Why section | Two charts (R2 + H1) supporting the "Why" claims with on-dark styling. |

All of these are deployed.

---

## 3. The big new thing: vendor selection matrix

After the microgrant submission, we sketched out how to upgrade vendor selection from "5 closest electricians" to a multi-factor scorer that prioritizes equity.

### Why we're changing it

Picking the closest vendor over and over creates a feedback loop where the same handful of contractors win every job, locking out qualified vendors who never made it into the city's standard rotation. The point of this platform — what would make it different from existing 311 routing — is that we can use public data to surface "the needles in the haystack": vendors with active licenses and credentials who have been overlooked because they don't have personal relationships at City Hall.

So the matrix is a deliberate policy statement: distribute work to qualified-but-overlooked vendors first, with proximity and historical track record as secondary signals.

### How it works

**Stage 1 — Hard filters (binary, must pass all):**
- Active Master / Special Electrician license
- License unexpired at the time of the complaint
- Within radius cap (default raised to 15 mi so outer-borough underdogs reach Manhattan/Brooklyn jobs)
- Not on city debarment list (when accessible)

A vendor that fails any of these never appears, regardless of score.

**Stage 2 — Weighted score (100 points total):**

| # | Component | Weight | Direction | What it rewards |
|---|---|---|---|---|
| 1 | Workload balance | **25** | inverse | Few dispatches from *our platform* in last 60 days (60-day half-life decay) |
| 2 | Owner-demographic equity | **20** | positive | MBE / WBE / Black / Latino / Asian / Native ownership — stackable up to a cap |
| 3 | Overlooked-but-qualified | **20** | inverse | Vendor has the license + trade keywords but few or zero DOT/DDC awards |
| 4 | Proximity | **15** | positive | Haversine distance to complaint, 1 / (1 + miles) |
| 5 | Reliability proxy | **10** | positive | Active license, no terminations or amendments in CROL |
| 6 | Baseline capability | **5** | positive | License type matches + at least *some* signal they can do the work (floor, not a kingmaker) |
| 7 | Capacity headroom | **5** | inverse | Recent award $ volume below threshold = has room |

### The two halves of "frequency"

The trickiest design call was: do we reward vendors who get a lot of business (trust signal) or punish them (locking out others)? Answer: split it into **two separate signals from two different sources**.

- **Capability** (component 6, only 5 pts) counts *city-wide historical awards*. Many DOT awards = trusted contractor. Small positive signal.
- **Workload balance** (component 1, 25 pts) counts *our platform's own recent dispatches*. Many dispatches from us in the last 60 days = we've sent them enough; spread it around. Large negative signal.

So a vendor with 50 lifetime DOT awards but 0 dispatches from us scores high on both. A vendor we sent 8 jobs to this week scores fine on capability but takes a big hit on workload balance.

### Borough spread

Per-vendor workload balance handles "don't over-pick the same vendor." For "don't over-pick the same borough's vendor pool," there's a soft constraint at result-assembly time: **no more than 2 of the top 5 from the same borough**, as long as cross-borough candidates score within 15 points of the borough-local winner.

### The honest gap: vendor ratings

NYC does not publish per-vendor job-quality ratings as structured open data. Component 5 (reliability) currently relies on:
- License status (Active vs Suspended) — strong, free
- No recent CROL terminations or amendments — moderate (requires parsing)
- *Future:* our own dispatch outcome data once we have ≥ a few hundred dispatches

We ship v1 labeling this component "reliability proxy (no public quality data)" so reviewers see the caveat.

---

## 4. The build script

Lives at [scripts/build-vendors.py](../scripts/build-vendors.py).

**What it does:**
1. Loads 1,894 licensed electricians from `data/vendors_final.csv` (already has geocoded lat/lng).
2. Pulls Recent Contract Awards (`qyyg-4tf5`) from NYC Socrata, filtered to DOT/DDC × electrical keywords.
3. Pulls M/WBE Directory (`ci93-uc8s`) filtered to electrical/lighting trades.
4. Joins by normalized vendor name (strips CORP/INC/LLC/punctuation, uppercases).
5. Computes per-vendor scoring inputs for components 2, 3, 5, 6, 7 (components 1 + 4 are runtime — workload depends on dispatch journal, proximity depends on complaint location).
6. Writes `public/vendors.json` with the full vendor pool + scoring weights baked into the file for transparency.

**Run it:**
```bash
python scripts/build-vendors.py              # full network refresh
python scripts/build-vendors.py --no-network # use cached snapshots in data/_socrata_cache/
```

**Verify before relying on output:**
- The two Socrata dataset IDs (`qyyg-4tf5`, `ci93-uc8s`) need to be confirmed on data.cityofnewyork.gov — column names occasionally drift after republishing.
- After a full run, check `joinStats.matchedAwards` and `matchedMwbe` in the output. If matches are below ~10% of vendors (~190), the normalized-name join is too strict and we'll need to add fuzzy matching (token-set ratio ≥ 0.85).

---

## 5. Next steps

In priority order:

1. **Verify the Socrata dataset IDs** and run the build script with live network. Check the join rate.
2. **Add the runtime scorer** — a function `scoreVendor(complaint, vendor, dispatchJournal)` that takes a complaint location + the static vendor record + a running dispatch journal and returns the 0–100 score plus the per-component breakdown for UI display.
3. **Wire the scorer into the existing intake → work-order flow** in `public/index.html`. Replace the current "5 closest" logic with the matrix output. Surface the per-component breakdown in the vendor card so dispatchers (and reviewers) can see *why* each vendor was picked.
4. **Start the dispatch journal** — a small JSON file (committed or hosted) that records every vendor pick from our platform, with timestamp and complaint ID. Component 1 (workload balance) reads from this at runtime.
5. **SF port (the microgrant scope)** — re-run the same pipeline against DataSF, swap dataset IDs, swap the NYC geocoder boundary check for an SF one.

The handoff after this point: pick up at step 2 (runtime scorer) or step 4 (dispatch journal) depending on which feels more useful to wire up first. Step 2 has zero dependencies; step 4 unblocks component 1 from being a placeholder.

---

## 6. Quick orientation for working on the codebase

- **Static frontend** is `public/` — `index.html`, `styles.css`, `charts.js`, `data-loader.js`. No build step.
- **Cloudflare Worker** at `workers/socrata-proxy.js` proxies NYC OpenData (since Vercel runtime can't resolve `data.cityofnewyork.gov` for some reason). Hosted at `nyc-streetlight-proxy.nddivecha.workers.dev`.
- **Python scripts** under `scripts/` are run on demand — they bake CSVs into the JSON the frontend loads. Output lives in `public/` and is committed.
- **Vercel** auto-deploys every push to `main`. Preview URLs are generated for every PR.

To run locally:
```bash
cd "NYC Street Lights"
python -m http.server 8765 --directory public
# open http://localhost:8765
```

To add to vendors:
```bash
python scripts/build-vendors.py
git add public/vendors.json
git commit -m "Refresh vendor snapshot"
git push
```
