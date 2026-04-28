"""
Bake fresh public/baked-data.json + public/baked-complaints.json
by querying the deployed Cloudflare Worker proxy.

Use this when:
  - Your machine can't reach data.cityofnewyork.gov directly (firewall,
    DNS filter, etc.) but CAN reach your Worker URL.
  - You want the dashboard's "first paint" cached numbers and the
    "Similar Resolved Complaints" panel to reflect a recent year.

Run:
    python scripts/bake-from-worker.py            # last full year (auto)
    python scripts/bake-from-worker.py 2025       # specific year
    python scripts/bake-from-worker.py 2025 --skip-complaints   # aggregates only

Outputs:
    public/baked-data.json         (~5 KB — aggregates per borough)
    public/baked-complaints.json   (~2 MB — 10K records for similar-match)

After running, commit + push and Vercel redeploys automatically.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

WORKER_URL = "https://nyc-streetlight-proxy.nddivecha.workers.dev"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PUBLIC = ROOT / "public"

BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]


def soda(query, timeout=20):
    """GET against the Worker proxy. Returns parsed JSON. Raises on error."""
    url = WORKER_URL + "/?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def base_filter(year):
    return (
        f"complaint_type='Street Light Condition' "
        f"AND created_date>='{year}-01-01T00:00:00' "
        f"AND created_date<'{year+1}-01-01T00:00:00'"
    )


def count(where):
    rows = soda({"$select": "count(*)", "$where": where})
    return int(rows[0].get("count_1") or rows[0].get("count") or 0)


def pct(num, den):
    return round((num / den) * 100, 1) if den else 0.0


def bake_borough(year, borough):
    bf = base_filter(year)
    bw = f"{bf} AND borough='{borough.upper()}'"
    closed_w = f"{bw} AND closed_date IS NOT NULL"

    print(f"  - {borough:<14}", end=" ", flush=True)

    volume = count(bw)
    closed_total = count(closed_w)
    c7  = count(f"{closed_w} AND date_diff_d(closed_date, created_date) <= 7")
    c30 = count(f"{closed_w} AND date_diff_d(closed_date, created_date) <= 30")
    c90 = count(f"{closed_w} AND date_diff_d(closed_date, created_date) <= 90")
    dups = count(f"{bw} AND (resolution_description LIKE '%uplicate%' "
                 f"OR resolution_description LIKE '%erged%')")

    median_rows = soda({
        "$select": "median(date_diff_d(closed_date, created_date)) AS m",
        "$where": closed_w,
    })
    median_days = int(round(float(median_rows[0].get("m") or 0))) if median_rows else 0

    season_rows = soda({
        "$select": "date_trunc_ym(created_date) AS month, count(*)",
        "$where": bw,
        "$group": "month",
        "$order": "month",
    })
    season = [0] * 12
    for row in season_rows:
        m = (row.get("month") or "")[5:7]
        if m.isdigit():
            idx = int(m) - 1
            if 0 <= idx < 12:
                season[idx] = int(row.get("count_1") or row.get("count") or 0)

    desc_rows = soda({
        "$select": "descriptor, count(*)",
        "$where": bw,
        "$group": "descriptor",
        "$order": "count(*) DESC",
        "$limit": "20",
    })
    descriptor = {
        (r.get("descriptor") or "Unknown").strip(): int(r.get("count_1") or r.get("count") or 0)
        for r in desc_rows
    }

    histogram_rows = soda({
        "$select": (
            "case("
            "date_diff_d(closed_date,created_date) <= 3, '0-3', "
            "date_diff_d(closed_date,created_date) <= 7, '4-7', "
            "date_diff_d(closed_date,created_date) <= 14, '8-14', "
            "date_diff_d(closed_date,created_date) <= 21, '15-21', "
            "date_diff_d(closed_date,created_date) <= 30, '22-30', "
            "date_diff_d(closed_date,created_date) <= 60, '31-60', "
            "true, '61+') AS bucket, count(*)"
        ),
        "$where": closed_w,
        "$group": "bucket",
    })
    order = ["0-3", "4-7", "8-14", "15-21", "22-30", "31-60", "61+"]
    h_map = {r["bucket"]: int(r.get("count_1") or r.get("count") or 0) for r in histogram_rows}
    histogram = [{"label": k, "count": h_map.get(k, 0)} for k in order]

    out = {
        "volume": volume,
        "medianDays": median_days,
        "closure7":  pct(c7,  volume),
        "closure30": pct(c30, volume),
        "closure90": pct(c90, volume),
        "duplicates": pct(dups, volume),
        "seasonality": season,
        "descriptor": descriptor,
        "histogram": histogram,
    }
    print(f"vol={volume:>5}  closure30={out['closure30']:>5}%  median={median_days}d")
    return out


def bake_data(year):
    print(f"\nBaking aggregates for {year}...")
    bf = base_filter(year)
    print(f"  - city totals", end=" ", flush=True)
    city_total = count(bf)
    median_rows = soda({
        "$select": "median(date_diff_d(closed_date, created_date)) AS m",
        "$where": f"{bf} AND closed_date IS NOT NULL",
    })
    city_median = int(round(float(median_rows[0].get("m") or 0))) if median_rows else 0
    print(f"vol={city_total}  median={city_median}d")

    boroughs = {}
    for b in BOROUGHS:
        boroughs[b] = bake_borough(year, b)
        time.sleep(0.2)  # gentle on Socrata

    out = {
        "_meta": {
            "purpose": "Static dataset bundled with the dashboard. Page loads this first; live Socrata results overlay when reachable.",
            "year": year,
            "snapshot_at": datetime.utcnow().isoformat() + "Z",
            "dataset": "erm2-nwe9 (NYC 311 Service Requests)",
            "source": f"Live snapshot via Cloudflare Worker proxy ({WORKER_URL})",
            "filter": "complaint_type = 'Street Light Condition'",
            "regenerate_with": "python scripts/bake-from-worker.py",
        },
        "city": {"totalVolume": city_total, "medianDays": city_median},
        "boroughs": boroughs,
    }
    out_path = PUBLIC / "baked-data.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"\nOK wrote {out_path.relative_to(ROOT)}  ({len(json.dumps(out))} bytes)")


def bake_complaints(year):
    """
    Fetch ~2K most-recent records per borough for the similar-match pool.
    The dashboard uses these for the "Similar Resolved Complaints" side panel.
    """
    print(f"\nBaking complaint pool for {year} (this takes ~30s)...")
    bf = base_filter(year)
    pool = []

    for borough in BOROUGHS:
        bw = f"{bf} AND borough='{borough.upper()}'"
        # Fetch a sample sorted by most-recent
        rows = soda({
            "$select": (
                "unique_key, descriptor, created_date, closed_date, status, "
                "incident_address, incident_zip, latitude, longitude, "
                "resolution_description"
            ),
            "$where": f"{bw} AND latitude IS NOT NULL AND longitude IS NOT NULL",
            "$order": "created_date DESC",
            "$limit": "2000",
        }, timeout=45)

        # Map raw fields to the schema the dashboard expects
        for r in rows:
            try:
                lat = round(float(r.get("latitude")), 6) if r.get("latitude") else None
                lng = round(float(r.get("longitude")), 6) if r.get("longitude") else None
            except (TypeError, ValueError):
                lat = lng = None
            if lat is None or lng is None:
                continue
            descriptor = (r.get("descriptor") or "").strip()
            ptype = canonical_type(descriptor)
            days = None
            if r.get("closed_date") and r.get("created_date"):
                try:
                    c = datetime.fromisoformat(r["closed_date"].replace("Z", ""))
                    s = datetime.fromisoformat(r["created_date"].replace("Z", ""))
                    days = max(1, (c - s).days)
                except Exception:
                    pass
            pool.append({
                "id":       r.get("unique_key", ""),
                "type":     ptype,
                "raw":      descriptor,
                "date":     (r.get("created_date") or "")[:10],
                "status":   r.get("status", "Open"),
                "days":     days,
                "address":  (r.get("incident_address") or "").strip(),
                "zip":      (r.get("incident_zip") or "").strip(),
                "borough":  borough,
                "priority": priority_for(ptype),
                "lat":      lat,
                "lng":      lng,
            })
        print(f"  - {borough:<14} {len(rows):>4} records")
        time.sleep(0.3)

    out_path = PUBLIC / "baked-complaints.json"
    out_path.write_text(json.dumps(pool, separators=(",", ":")), encoding="utf-8")
    sz = out_path.stat().st_size
    print(f"\nOK wrote {out_path.relative_to(ROOT)}  ({len(pool)} records, {sz//1024} KB)")


# Mapping shared with build.py / bake-static.py
PROBLEM_TYPE_MAP = {
    "Street Light Out": "Street Light Out",
    "Street Light Lamp Missing": "Street Light Out",
    "Multiple Street Lights Out": "Multiple Lights Out",
    "Street Light Cycling": "Cycling",
    "Street Light Lamp Dim": "Dim Lamp",
    "Street Light Dayburning": "Dayburning",
    "Time Clock Maladjusted": "Dayburning",
    "Fixture/Luminaire Door Open": "Fixture/Glassware",
    "Fixture/Luminaire Hanging": "Fixture/Glassware",
    "Glassware Missing": "Fixture/Glassware",
    "Glassware Broken": "Fixture/Glassware",
    "Glassware Hanging": "Fixture/Glassware",
    "Fixture/Luminaire Damaged": "Lamppost Damage",
    "Fixture/Luminaire Missing": "Lamppost Damage",
    "Lamppost Damaged": "Lamppost Damage",
    "Lamppost Leaning": "Lamppost Damage",
    "Lamppost Knocked Down": "Lamppost Damage",
    "Lamppost Wire Exposed": "Lamppost Damage",
    "Lamppost Base Door/Cover Open": "Lamppost Damage",
    "Lamppost Base Door/Cover Damaged": "Lamppost Damage",
    "Lamppost Base Door/Cover Missing": "Lamppost Damage",
}
PRIORITY_MAP = {
    "Street Light Out": "Medium", "Multiple Lights Out": "High", "Cycling": "Low",
    "Dim Lamp": "Low", "Dayburning": "Low", "Fixture/Glassware": "Medium",
    "Lamppost Damage": "High",
}

def canonical_type(descriptor):
    return PROBLEM_TYPE_MAP.get(descriptor, "Street Light Out")

def priority_for(ptype):
    return PRIORITY_MAP.get(ptype, "Medium")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    flags = [a for a in sys.argv[1:] if a.startswith("-")]

    if args:
        year = int(args[0])
    else:
        today = datetime.utcnow()
        year = today.year - 1 if today.month > 1 else today.year - 2

    print(f"Baking via {WORKER_URL}")
    print(f"Target year: {year}")

    # Smoke-test the Worker
    print("\n-> Smoke test")
    try:
        smoke = count(f"{base_filter(year)} AND borough='MANHATTAN'")
    except Exception as e:
        print(f"  X Cannot reach Worker: {e}", file=sys.stderr)
        print(f"  Make sure {WORKER_URL}/health works in your browser.", file=sys.stderr)
        sys.exit(1)
    print(f"  OK Manhattan {year} = {smoke}")

    bake_data(year)

    if "--skip-complaints" not in flags:
        bake_complaints(year)
    else:
        print("\n(skipped baked-complaints.json — pass without --skip-complaints to refresh it)")

    print("\nDone. Don't forget to:  git add public/ && git commit -m 'Refresh baked snapshots' && git push")


if __name__ == "__main__":
    main()
