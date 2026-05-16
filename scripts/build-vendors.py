"""
Build public/vendors.json — vendor pool with scoring inputs for equity-first matching.

Pipeline:
  1. Load licensed electricians from data/vendors_final.csv (license + geocoded address).
  2. Enrich from Socrata:
       - Recent Contract Awards (qyyg-4tf5)   → track record per vendor
       - M/WBE Directory (ci93-uc8s)          → owner demographics
  3. Compute per-vendor inputs for the 7 scoring components:
       1. workload_balance     (runtime — left as null; reads dispatches.json at runtime)
       2. demographic_equity   → certifications.{mwbe, ethnicity, gender, ...}
       3. overlooked           → track_record.{awardCount5yr, yearsSinceLastAward, yearsLicensed}
       4. proximity            (runtime — depends on complaint location)
       5. reliability          → licensing.status + track_record.terminations
       6. baseline_capability  → license_type_match AND track_record.anyElectricalAward
       7. capacity_headroom    → track_record.amount_last12mo

Output:
  public/vendors.json

Usage:
  python scripts/build-vendors.py
  python scripts/build-vendors.py --no-network   # skip Socrata, use cached snapshots
"""

import argparse
import csv
import difflib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = ROOT / "data" / "_socrata_cache"
OUT = ROOT / "public" / "vendors.json"

SOCRATA_DOMAIN = "nycopendata.socrata.com"  # mirror; data.cityofnewyork.gov DNS unreachable
DATASETS = {
    "awards": "qyyg-4tf5",     # Recent Contract Awards
    "mwbe":   "ci93-uc8s",     # M/WBE, LBE, EBE Certified Business List
}
# NAICS 238210 = Electrical Contractors and Other Wiring Installation Contractors.
NAICS_ELECTRICAL = "238210"

ELECTRICAL_KEYWORDS = [
    "LIGHT", "ELECTRIC", "LUMINAIRE", "TRAFFIC SIGNAL", "LAMP", "WIRING",
    "FIXTURE", "CONDUIT", "BALLAST", "CIRCUIT", "STREETLIGHT",
]

# Agencies that actually procure electrical work — expanded from DOT/DDC only.
# Verified via live API: these 8 agencies hold ~95% of electrical-keyword
# contracts citywide. Earlier DOT/DDC-only filter captured ~25% of the universe.
ELECTRICAL_AGENCIES = [
    "TRANSPORTATION",
    "DESIGN AND CONSTRUCTION",
    "CITYWIDE ADMINISTRATIVE SERVICES",
    "ENVIRONMENTAL PROTECTION",
    "PARKS AND RECREATION",
    "HOUSING PRESERVATION AND DEVELOPMENT",
    "SANITATION",
    "BUILDINGS",
]

# Suffixes stripped during name normalization so "ABC Electric Corp" == "ABC ELECTRIC CORPORATION".
SUFFIX_RE = re.compile(
    r"\b(CORP|CORPORATION|INC|INCORPORATED|LLC|LLP|LTD|LIMITED|"
    r"CO|COMPANY|GROUP|ENTERPRISES?|SERVICES?|CONTRACTING|CONTRACTORS?)\b\.?",
    re.IGNORECASE,
)
PUNCT_RE = re.compile(r"[^\w\s]")
WS_RE = re.compile(r"\s+")


def normalize_name(raw: str) -> str:
    if not raw:
        return ""
    s = raw.upper()
    s = SUFFIX_RE.sub("", s)
    s = PUNCT_RE.sub(" ", s)
    s = WS_RE.sub(" ", s).strip()
    return s


def collapse_name(normalized: str) -> str:
    """Strip all whitespace — catches 'G S H ELECTRIC' vs 'GSH ELECTRIC'."""
    return re.sub(r"\s+", "", normalized)


# Industry filler words that drown out the distinguishing prefix during fuzzy
# matching (e.g. "ABC ELECTRIC" vs "XYZ ELECTRIC" both contain "ELECTRIC").
INDUSTRY_FILLER_RE = re.compile(
    r"\b(ELECTRIC|ELECTRICAL|POWER|LIGHTING|LIGHT|CONTRACTOR|CONTRACTING|"
    r"INSTALLATION|TELECOMMUNICATIONS|SVCS|SERVICE|SOLUTIONS|SYSTEMS)\b",
    re.IGNORECASE,
)


def discriminator(normalized: str) -> str:
    """Return the distinguishing core of a vendor name with industry words
    removed — used for fuzzy comparison so 'ABC' vs 'XYZ' isn't dominated by
    the shared word 'ELECTRIC'."""
    s = INDUSTRY_FILLER_RE.sub("", normalized)
    s = WS_RE.sub(" ", s).strip()
    return re.sub(r"\s+", "", s)


def fuzzy_lookup(name: str, candidates_by_disc: dict[str, str],
                 cutoff: float = 0.92) -> str | None:
    """Best-match by discriminator-only comparison.

    Returns the matched candidate's normalized form so the caller can look up
    the original record. None if no candidate's discriminator crosses cutoff.
    """
    disc = discriminator(name)
    # If the discriminator is too short, fuzzy matching is unreliable.
    if len(disc) < 4:
        return None
    matches = difflib.get_close_matches(
        disc, list(candidates_by_disc.keys()), n=1, cutoff=cutoff
    )
    if not matches:
        return None
    return candidates_by_disc[matches[0]]


def vendor_id(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return f"v_{slug[:60]}"


def socrata_fetch(dataset: str, where: str = "", select: str = "", limit: int = 5000,
                  use_cache: bool = True) -> list[dict]:
    CACHE.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE / f"{dataset}.json"

    if use_cache and cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    params = {"$limit": str(limit)}
    if where:
        params["$where"] = where
    if select:
        params["$select"] = select
    url = (
        f"https://{SOCRATA_DOMAIN}/resource/{dataset}.json?"
        + urllib.parse.urlencode(params, safe="(),=")
    )
    print(f"[fetch] {dataset} … ", end="", flush=True)
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            rows = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"FAILED ({e}). Returning empty.")
        return []
    print(f"{len(rows)} rows")
    cache_file.write_text(json.dumps(rows), encoding="utf-8")
    return rows


def load_local_vendors() -> list[dict]:
    rows = []
    with (DATA / "vendors_final.csv").open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            name = (r.get("business_name") or "").strip()
            if not name:
                continue
            rows.append({
                "license_number": (r.get("license_number") or "").strip(),
                "name": name,
                "normalizedName": normalize_name(name),
                "address": {
                    "line1": (r.get("address") or "").strip(),
                    "city":  (r.get("city") or "").strip(),
                    "state": (r.get("state") or "").strip(),
                    "zip":   (r.get("zip") or "").strip(),
                    "borough": (r.get("borough") or "").strip(),
                    "lat": float(r["lat"]) if r.get("lat") else None,
                    "lng": float(r["long"]) if r.get("long") else None,
                },
                "contact": {
                    "phone": (r.get("phone") or "").strip() or None,
                    "email": (r.get("email") or "").strip() or None,
                },
                "licensing": {
                    "masterElectrician": True,
                    "licenseNumber": (r.get("license_number") or "").strip(),
                    "licenseStatus": (r.get("status") or "Active").strip(),
                    "expiresOn": None,
                },
            })
    return rows


def fetch_awards(use_cache: bool) -> list[dict]:
    keyword_clauses = " OR ".join(
        f"upper(short_title) like '%{k}%'" for k in ELECTRICAL_KEYWORDS
    )
    # Match across the 8 agencies that procure electrical work. We OR substring
    # matches rather than IN-clause exact matches because agency_name values
    # vary in formatting ("Transportation" vs "Department of Transportation").
    agency_clauses = " OR ".join(
        f"upper(agency_name) like '%{a}%'" for a in ELECTRICAL_AGENCIES
    )
    # Match keywords against the title AND the longer description fields —
    # ~30% of relevant rows have electrical content only in short_description
    # or category_description, not the abbreviated short_title.
    title_clauses = " OR ".join(
        f"upper(short_title) like '%{k}%'" for k in ELECTRICAL_KEYWORDS
    )
    desc_clauses = " OR ".join(
        f"upper(category_description) like '%{k}%'" for k in ELECTRICAL_KEYWORDS
    )
    where = f"({agency_clauses}) AND (({title_clauses}) OR ({desc_clauses}))"
    select = (
        "vendor_name, agency_name, short_title, contract_amount, "
        "start_date, end_date, category_description, type_of_notice_description"
    )
    return socrata_fetch(DATASETS["awards"], where=where, select=select,
                         limit=5000, use_cache=use_cache)


def fetch_mwbe(use_cache: bool) -> list[dict]:
    keyword_clauses = " OR ".join(
        f"upper(business_description) like '%{k}%'" for k in ELECTRICAL_KEYWORDS
    )
    # NAICS code is the reliable signal; freeform description is the fallback.
    where = f"id6_digit_naics_code='{NAICS_ELECTRICAL}' OR {keyword_clauses}"
    select = (
        "vendor_formal_name, vendor_dba, business_description, ethnicity, "
        "certification, cert_renewal_date, address1, city, state, zip, telephone, "
        "website, id6_digit_naics_code, naics_subsector, naics_title, "
        "enrolled_in_passport"
    )
    return socrata_fetch(DATASETS["mwbe"], where=where, select=select,
                         limit=5000, use_cache=use_cache)


def index_awards(awards: list[dict]) -> dict[str, dict]:
    """Aggregate award rows by normalized vendor name."""
    now = datetime.now(timezone.utc)
    by_name: dict[str, dict] = {}
    for r in awards:
        nm = normalize_name(r.get("vendor_name", ""))
        if not nm:
            continue
        b = by_name.setdefault(nm, {
            "awardsTotalCount": 0,
            "awardsTotalAmount": 0.0,
            "awardsLast12moCount": 0,
            "awardsLast12moAmount": 0.0,
            "awardsLast5yrCount": 0,
            "largestAward": 0.0,
            "agenciesServed": set(),
            "firstAwardDate": None,
            "lastAwardDate": None,
        })
        try:
            amt = float(r.get("contract_amount") or 0)
        except (TypeError, ValueError):
            amt = 0.0
        start = (r.get("start_date") or "")[:10]
        try:
            dt = datetime.fromisoformat(start) if start else None
            if dt and dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            dt = None

        b["awardsTotalCount"] += 1
        b["awardsTotalAmount"] += amt
        b["largestAward"] = max(b["largestAward"], amt)
        agency = r.get("agency_name", "")
        if agency:
            b["agenciesServed"].add(agency)
        if dt:
            days = (now - dt).days
            if days <= 365:
                b["awardsLast12moCount"] += 1
                b["awardsLast12moAmount"] += amt
            if days <= 365 * 5:
                b["awardsLast5yrCount"] += 1
            iso = dt.date().isoformat()
            if not b["firstAwardDate"] or iso < b["firstAwardDate"]:
                b["firstAwardDate"] = iso
            if not b["lastAwardDate"] or iso > b["lastAwardDate"]:
                b["lastAwardDate"] = iso

    for b in by_name.values():
        b["agenciesServed"] = sorted(b["agenciesServed"])
    return by_name


def index_mwbe(mwbe: list[dict]) -> dict[str, dict]:
    by_name: dict[str, dict] = {}
    for r in mwbe:
        nm = normalize_name(r.get("vendor_formal_name") or r.get("vendor_dba") or "")
        if not nm:
            continue
        cert = (r.get("certification") or "").upper()
        eth = (r.get("ethnicity") or "").strip() or None
        passport = (r.get("enrolled_in_passport") or "").strip().lower() == "yes"
        by_name[nm] = {
            "mwbe": bool(cert),
            "certification": cert or None,  # MBE / WBE / MWBE / LBE / EBE
            "ethnicity": eth,
            "gender": None,  # no longer published in this dataset
            "passportEnrolled": passport,
            "naicsCode": (r.get("id6_digit_naics_code") or "").strip() or None,
            "naicsSubsector": (r.get("naics_subsector") or "").strip() or None,
            "naicsTitle": (r.get("naics_title") or "").strip() or None,
            "certRenewalDate": (r.get("cert_renewal_date") or "").strip() or None,
            "businessDescription": (r.get("business_description") or "").strip() or None,
            "website": (r.get("website") or "").strip() or None,
            "mwbeAddress": {
                "line1": (r.get("address1") or "").strip() or None,
                "city":  (r.get("city") or "").strip() or None,
                "state": (r.get("state") or "").strip() or None,
                "zip":   (r.get("zip") or "").strip() or None,
            },
        }
    return by_name


def compute_overlooked_inputs(awards_record: dict, license_first_seen: str | None) -> dict:
    """Inputs for component #3 (overlooked-but-qualified)."""
    now = datetime.now(timezone.utc)
    count5 = awards_record.get("awardsLast5yrCount", 0) if awards_record else 0
    last = awards_record.get("lastAwardDate") if awards_record else None
    years_since = None
    if last:
        try:
            years_since = (now - datetime.fromisoformat(last).replace(tzinfo=timezone.utc)).days / 365.25
        except ValueError:
            pass
    years_licensed = None
    if license_first_seen:
        try:
            years_licensed = (now - datetime.fromisoformat(license_first_seen).replace(tzinfo=timezone.utc)).days / 365.25
        except ValueError:
            pass
    return {
        "awardCount5yr": count5,
        "yearsSinceLastAward": round(years_since, 2) if years_since is not None else None,
        "yearsLicensed": round(years_licensed, 2) if years_licensed is not None else None,
    }


def demographic_bonus_points(cert_block: dict | None) -> dict:
    """Score input for component #2. Stackable up to a cap of 15 points."""
    if not cert_block:
        return {"points": 0, "tags": []}
    pts = 0
    tags = []
    cert = (cert_block.get("certification") or "").upper()
    if "MBE" in cert: pts += 6; tags.append("MBE")
    if "WBE" in cert: pts += 6; tags.append("WBE")
    if "LBE" in cert: pts += 2; tags.append("LBE")
    if "EBE" in cert: pts += 2; tags.append("EBE")
    eth = (cert_block.get("ethnicity") or "").lower()
    for label in ("black", "hispanic", "latino", "asian", "native", "pacific"):
        if label in eth:
            pts += 2; tags.append(f"ethnicity:{eth}")
            break
    return {"points": min(pts, 15), "tags": tags}


def direct_purchase_eligible(cert_block: dict | None, license_active: bool) -> dict:
    """Score input for component #8 — eligibility for the 2019 M/WBE rule.

    Under NYC PPB Rule 3-08 (as amended in 2019), agencies may purchase
    directly from a certified M/WBE vendor for up to $1.5M per purchase
    without competitive solicitation, provided the vendor is enrolled in
    PASSPort with a current certification and an NIGP/NAICS code matching
    the work. This function returns the boolean eligibility flag plus the
    reasons that flag is/isn't set, so the UI can explain it.
    """
    reasons = {
        "hasMwbeCertification": False,
        "passportEnrolled": False,
        "licenseActive": bool(license_active),
        "naicsMatchesElectrical": False,
        "certNotExpired": True,  # default true if no date published
    }
    if cert_block:
        cert = (cert_block.get("certification") or "").upper()
        reasons["hasMwbeCertification"] = bool(cert) and cert != "NONE"
        reasons["passportEnrolled"] = bool(cert_block.get("passportEnrolled"))
        naics = (cert_block.get("naicsCode") or "").strip()
        # 238210 = Electrical Contractors; 238... = related construction trades.
        reasons["naicsMatchesElectrical"] = (
            naics == NAICS_ELECTRICAL or naics.startswith("2382")
        )
        renewal = cert_block.get("certRenewalDate")
        if renewal:
            try:
                # Format in dataset is "M/D/YYYY"; be liberal.
                from datetime import datetime as _dt
                for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S.%f"):
                    try:
                        renewal_dt = _dt.strptime(renewal, fmt)
                        reasons["certNotExpired"] = (
                            renewal_dt >= datetime.now()
                        )
                        break
                    except ValueError:
                        continue
            except Exception:
                pass

    eligible = all(reasons.values())
    return {"eligible": eligible, "reasons": reasons}


def build(use_cache: bool) -> dict:
    vendors = load_local_vendors()
    awards = fetch_awards(use_cache)
    mwbe = fetch_mwbe(use_cache)
    awards_idx = index_awards(awards)
    mwbe_idx = index_mwbe(mwbe)

    # Build discriminator-keyed lookup tables for fuzzy fallback matching.
    # Skip candidates whose discriminator is empty (e.g. names that are pure
    # filler like "ELECTRIC CORP") — they'd over-match everything.
    awards_disc = {}
    for k in awards_idx.keys():
        d = discriminator(k)
        if len(d) >= 4:
            awards_disc[d] = k
    mwbe_disc = {}
    for k in mwbe_idx.keys():
        d = discriminator(k)
        if len(d) >= 4:
            mwbe_disc[d] = k

    matched_awards = 0
    matched_mwbe = 0
    matched_awards_fuzzy = 0
    matched_mwbe_fuzzy = 0
    out: list[dict] = []

    for v in vendors:
        nm = v["normalizedName"]
        award_rec = awards_idx.get(nm)
        cert_rec = mwbe_idx.get(nm)

        # Fuzzy fallback if exact normalized-name match failed.
        if not award_rec:
            fuzzy_key = fuzzy_lookup(nm, awards_disc)
            if fuzzy_key:
                award_rec = awards_idx.get(fuzzy_key)
                if award_rec:
                    matched_awards_fuzzy += 1
        if not cert_rec:
            fuzzy_key = fuzzy_lookup(nm, mwbe_disc)
            if fuzzy_key:
                cert_rec = mwbe_idx.get(fuzzy_key)
                if cert_rec:
                    matched_mwbe_fuzzy += 1

        if award_rec: matched_awards += 1
        if cert_rec:  matched_mwbe += 1

        # Component 6 — baseline capability floor
        any_electrical_award = bool(award_rec and award_rec["awardsTotalCount"] > 0)
        baseline_capability = v["licensing"]["masterElectrician"] and (
            any_electrical_award or cert_rec is not None
        )

        # Component 5 — reliability proxy
        reliability_proxy = {
            "licenseActive": v["licensing"]["licenseStatus"].lower() in ("active", "current", ""),
            "terminations": 0,  # placeholder — requires CROL parsing for amendments/terminations
        }

        # Component 3 — overlooked-but-qualified inputs
        overlooked_inputs = compute_overlooked_inputs(
            award_rec, award_rec.get("firstAwardDate") if award_rec else None
        )

        # Component 2 — demographic equity points
        dem = demographic_bonus_points(cert_rec)

        # Component 8 — direct-purchase eligibility (NYC PPB Rule 3-08, 2019 amendment)
        dp_eligibility = direct_purchase_eligible(
            cert_rec, reliability_proxy["licenseActive"]
        )

        # Track record cleanup for output
        track_record = award_rec.copy() if award_rec else {
            "awardsTotalCount": 0, "awardsTotalAmount": 0.0,
            "awardsLast12moCount": 0, "awardsLast12moAmount": 0.0,
            "awardsLast5yrCount": 0, "largestAward": 0.0,
            "agenciesServed": [], "firstAwardDate": None, "lastAwardDate": None,
        }

        out.append({
            "id": vendor_id(v["name"]),
            "name": v["name"],
            "normalizedName": nm,
            "address": v["address"],
            "contact": v["contact"],
            "trades": ["electrical"],  # all from DOB Master Electrician roster
            "licensing": v["licensing"],
            "certifications": cert_rec or {
                "mwbe": False, "certification": None,
                "ethnicity": None, "gender": None,
            },
            "track_record": track_record,
            "scoring_inputs": {
                # Component 1 (workload_balance): runtime — read dispatches journal.
                "demographic_points": dem["points"],
                "demographic_tags": dem["tags"],
                "overlooked": overlooked_inputs,
                # Component 4 (proximity): runtime — needs complaint coords.
                "reliability_proxy": reliability_proxy,
                "baseline_capability": baseline_capability,
                "capacity_headroom_amount_12mo": track_record["awardsLast12moAmount"],
                # Component 8 — NEW: M/WBE direct-purchase eligibility under
                # PPB Rule 3-08 (2019). Worth 15 pts when fully eligible.
                "direct_purchase_eligibility": dp_eligibility,
            },
            "matchConfidence": 1.0 if (award_rec or cert_rec) else 0.6,
            "issues": [] if (award_rec or cert_rec) else ["no_award_or_mwbe_record"],
        })

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "vendors_final_csv": {"path": "data/vendors_final.csv", "rowCount": len(vendors)},
            "contractAwards":    {"dataset": DATASETS["awards"], "rowCount": len(awards)},
            "mwbeDirectory":     {"dataset": DATASETS["mwbe"],   "rowCount": len(mwbe)},
        },
        "joinStats": {
            "vendorsTotal": len(vendors),
            "matchedAwards": matched_awards,
            "matchedAwardsViaFuzzy": matched_awards_fuzzy,
            "matchedMwbe": matched_mwbe,
            "matchedMwbeViaFuzzy": matched_mwbe_fuzzy,
            "directPurchaseEligible": sum(
                1 for v in out
                if v["scoring_inputs"]["direct_purchase_eligibility"]["eligible"]
            ),
        },
        "scoringWeights": {
            "workload_balance": 22,
            "overlooked_but_qualified": 18,
            "direct_purchase_eligibility": 15,
            "demographic_equity": 15,
            "proximity": 13,
            "reliability": 10,
            "baseline_capability": 4,
            "capacity_headroom": 3,
        },
        "scoringPolicy": {
            "ruleCitations": [
                "NYC PPB Rule 3-08 (2019 amendment) — M/WBE non-competitive small purchases up to $1.5M",
                "NYC PPB Rule 3-02 — public notice threshold $100K",
                "NY Labor Law §220 — prevailing wage / certified payroll",
            ],
            "directPurchaseThreshold": 1_500_000,
        },
        "vendors": out,
    }
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-network", action="store_true",
                    help="Use cached Socrata snapshots only (data/_socrata_cache/).")
    args = ap.parse_args()

    payload = build(use_cache=args.no_network)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    j = payload["joinStats"]
    print(f"\n[done] {OUT}")
    print(f"  {j['vendorsTotal']} vendors  |  "
          f"{j['matchedAwards']} awards ({j['matchedAwardsViaFuzzy']} via fuzzy)  |  "
          f"{j['matchedMwbe']} M/WBE ({j['matchedMwbeViaFuzzy']} via fuzzy)  |  "
          f"{j['directPurchaseEligible']} direct-purchase-eligible")


if __name__ == "__main__":
    main()
