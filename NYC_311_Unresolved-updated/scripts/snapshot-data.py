"""
Snapshot live NYC OpenData → public/baked-data.json

Run this script from any machine with working DNS / network access to
data.cityofnewyork.gov. It pulls every metric the dashboard's "About"
section + analytics tab needs, then writes a fresh public/baked-data.json
that ships with the deployed site.

Usage:
    python scripts/snapshot-data.py            # pulls last full year (auto)
    python scripts/snapshot-data.py 2025       # pulls a specific year
    python scripts/snapshot-data.py --check    # smoke-test only, no write

The dashboard always loads baked-data.json first as a baseline, then
overlays live Socrata data when the user's network can reach it. This
script is what produces that baseline.

Required: Python 3.8+. Uses only stdlib (no pip install).
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

DATASET = "https://data.cityofnewyork.gov/resource/erm2-nwe9.json"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "public" / "baked-data.json"

BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]


def soda(query, timeout=15):
    """Issue a SoQL query and return parsed JSON. Raises on HTTP error."""
    url = DATASET + "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def base_filter(year):
    return (
        f"complaint_type='Street Light Condition' "
        f"AND created_date>='{year}-01-01T00:00:00' "
        f"AND created_date<'{year+1}-01-01T00:00:00'"
    )


def pull_count(where):
    rows = soda({"$select": "count(*)", "$where": where})
    return int(rows[0].get("count_1") or rows[0].get("count") or 0)


def pull_borough_summary(year, borough):
    """All metrics needed for one borough."""
    bf = base_filter(year)
    bw = f"{bf} AND borough='{borough.upper()}'"
    closed_w = f"{bw} AND closed_date IS NOT NULL"

    print(f"  · {borough:<14}", end=" ", flush=True)

    volume = pull_count(bw)
    closed_total = pull_count(closed_w)
    closed_7  = pull_count(f"{closed_w} AND date_diff_d(closed_date, created_date) <= 7")
    closed_30 = pull_count(f"{closed_w} AND date_diff_d(closed_date, created_date) <= 30")
    closed_90 = pull_count(f"{closed_w} AND date_diff_d(closed_date, created_date) <= 90")

    duplicates = pull_count(
        f"{bw} AND (resolution_description LIKE '%uplicate%' "
        f"OR resolution_description LIKE '%erged%')"
    )

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

    pct = lambda n, d: round((n / d) * 100, 1) if d else 0.0
    out = {
        "volume": volume,
        "medianDays": median_days,
        "closure7":  pct(closed_7, closed_total),
        "closure30": pct(closed_30, closed_total),
        "closure90": pct(closed_90, closed_total),
        "duplicates": pct(duplicates, volume),
        "seasonality": season,
        "descriptor": descriptor,
        "histogram": histogram,
    }
    print(f"vol={volume:>6}  closure30={out['closure30']:>5}%  median={median_days}d")
    return out


def pull_city_totals(year):
    bf = base_filter(year)
    total = pull_count(bf)
    median_rows = soda({
        "$select": "median(date_diff_d(closed_date, created_date)) AS m",
        "$where": f"{bf} AND closed_date IS NOT NULL",
    })
    median_days = int(round(float(median_rows[0].get("m") or 0))) if median_rows else 0
    return {"totalVolume": total, "medianDays": median_days}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    flags = [a for a in sys.argv[1:] if a.startswith("-")]

    if args:
        year = int(args[0])
    else:
        # Default = most recent FULLY-CLOSED calendar year
        today = datetime.utcnow()
        year = today.year - 1 if today.month > 1 else today.year - 2

    print(f"Snapshotting NYC 311 streetlight data for year {year}")
    print(f"Source: {DATASET}")
    print()

    print("→ smoke test")
    try:
        smoke = pull_count(f"{base_filter(year)} AND borough='MANHATTAN'")
    except Exception as e:
        print(f"  ✗ Cannot reach Socrata: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"  ✓ Manhattan {year} count = {smoke}")
    print()

    if "--check" in flags:
        print("Smoke test only (--check). Exiting.")
        return

    print("→ city totals")
    city = pull_city_totals(year)
    print(f"  total: {city['totalVolume']}, median: {city['medianDays']}d")
    print()

    print("→ borough summaries")
    boroughs = {}
    for b in BOROUGHS:
        boroughs[b] = pull_borough_summary(year, b)
        time.sleep(0.3)  # gentle to Socrata
    print()

    out = {
        "_meta": {
            "purpose": "Static dataset bundled with the dashboard. The page loads this first as a baseline, then overlays live Socrata results when the user's network can reach data.cityofnewyork.gov.",
            "year": year,
            "snapshot_at": datetime.utcnow().isoformat() + "Z",
            "dataset": "erm2-nwe9 (NYC 311 Service Requests)",
            "source": DATASET,
            "filter": "complaint_type = 'Street Light Condition'",
            "regenerate_with": "python scripts/snapshot-data.py [year]",
        },
        "city": city,
        "boroughs": boroughs,
    }

    OUT.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"✓ wrote {OUT}")
    print(f"  ({len(json.dumps(out))} bytes)")


if __name__ == "__main__":
    main()
