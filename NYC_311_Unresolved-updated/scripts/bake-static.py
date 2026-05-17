"""
Bake the local CSVs into compact JSON files the new dashboard can fetch.

Outputs:
  public/baked-vendors.json     — filtered licensed electrician contractors
  public/baked-complaints.json  — historical complaint pool for similar-matching
                                    (sampled for size: 10K most recent across boroughs)

Run when CSVs are updated. Output ships with the deployed site.
"""

import csv
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "public"

# Filter universities, hospitals, city agencies, NYCHA, building mgmt cos.
NON_CONTRACTOR = re.compile(
    r'(?:\b(?:UNIVERSIT|UNIV\b|COLLEGE|SCHOOL|ACADEM|HOSPITAL|MEDICAL CENTER|MEDICAL CTR|'
    r'MED CTR|MED\.? CENTER|CLINIC|CHURCH|SYNAGOGUE|MOSQUE|TEMPLE|'
    r'CONDOMINIUM|COOPERATIVE|CO-OP|HOUSING|AUTHORITY|AGENC|'
    r'\bDEPT\b|\bDEPT\.|DEPARTMENT|HOTEL|RESORT|MUSEUM|GALLER|LIBRAR|'
    r'PROPERTIES|REALTY|REAL ESTATE|MANAGEMENT|TRANSIT|AIRPORT|PORT AUTHORITY|'
    r'SUPERMARKET|RESTAURANT|\bBANK\b|RESEARCH|FOUNDATION|INSTITUTE|THEATER|THEATRE|'
    r'POLICE|SANIT|TRANSP))',
    re.IGNORECASE,
)

PROBLEM_TYPE_MAP = {
    'Street Light Out': 'Street Light Out',
    'Street Light Lamp Missing': 'Street Light Out',
    'Multiple Street Lights Out': 'Multiple Lights Out',
    'Street Light Cycling': 'Cycling',
    'Street Light Lamp Dim': 'Dim Lamp',
    'Street Light Dayburning': 'Dayburning',
    'Time Clock Maladjusted': 'Dayburning',
    'Fixture/Luminaire Door Open': 'Fixture/Glassware',
    'Fixture/Luminaire Hanging': 'Fixture/Glassware',
    'Glassware Missing': 'Fixture/Glassware',
    'Glassware Broken': 'Fixture/Glassware',
    'Glassware Hanging': 'Fixture/Glassware',
    'Fixture/Luminaire Damaged': 'Lamppost Damage',
    'Fixture/Luminaire Missing': 'Lamppost Damage',
    'Lamppost Damaged': 'Lamppost Damage',
    'Lamppost Leaning': 'Lamppost Damage',
    'Lamppost Knocked Down': 'Lamppost Damage',
    'Lamppost Wire Exposed': 'Lamppost Damage',
    'Lamppost Base Door/Cover Open': 'Lamppost Damage',
    'Lamppost Base Door/Cover Damaged': 'Lamppost Damage',
    'Lamppost Base Door/Cover Missing': 'Lamppost Damage',
}

PRIORITY_MAP = {
    'Street Light Out': 'Medium', 'Multiple Lights Out': 'High', 'Cycling': 'Low',
    'Dim Lamp': 'Low', 'Dayburning': 'Low', 'Fixture/Glassware': 'Medium',
    'Lamppost Damage': 'High',
}

BOROUGH_FILES = [
    ('Manhattan', 'Manhattan.csv'),
    ('Brooklyn',  'Brooklyn.csv'),
    ('Queens',    'Queens.csv'),
    ('Bronx',     'Bronx.csv'),
    ('Staten Island', 'Staten_Island.csv'),
]


def bake_vendors():
    rows = []
    excluded = []
    with open(DATA / "vendors_final.csv", encoding="utf-8") as f:
        for v in csv.DictReader(f):
            name = v["business_name"].strip()
            if NON_CONTRACTOR.search(name):
                excluded.append(name); continue
            try:
                lat = round(float(v["lat"]), 6) if v["lat"].strip() else None
                lng = round(float(v["long"]), 6) if v["long"].strip() else None
            except: lat, lng = None, None
            if lat is None or lng is None: continue
            phone = v["phone"].strip()
            if phone.isdigit() and len(phone) == 10:
                phone = f"({phone[:3]}) {phone[3:6]}-{phone[6:]}"
            rows.append({
                "name":    name.title(),
                "phone":   phone,
                "license": v["license_number"].strip(),
                "borough": v["borough"].strip(),
                "zip":     v["zip"].strip(),
                "lat":     lat,
                "lng":     lng,
            })
    out = OUT / "baked-vendors.json"
    out.write_text(json.dumps(rows, separators=(',', ':')), encoding="utf-8")
    print(f"  OK{out.name}  · {len(rows)} vendors  · excluded {len(excluded)} institutions")
    return rows


def bake_complaints():
    """Sample ~2K most-recent records per borough for the similar-match pool."""
    pool = []
    for borough, fn in BOROUGH_FILES:
        path = DATA / fn
        rows = []
        with open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                pd_raw = r["PROBLEM_DETAIL"].strip()
                ptype = PROBLEM_TYPE_MAP.get(pd_raw, "Street Light Out")
                try:
                    lat = round(float(r["LATITUDE"]), 6) if r["LATITUDE"].strip() else None
                    lng = round(float(r["LONGITUDE"]), 6) if r["LONGITUDE"].strip() else None
                except: lat, lng = None, None
                if lat is None or lng is None: continue
                days = None
                if r["STATUS"].strip() == "Closed" and r["DAYS_TO_CLOSE"].strip():
                    try: days = max(1, int(float(r["DAYS_TO_CLOSE"])))
                    except: pass
                rows.append({
                    "id":      r["UNIQUE_KEY"].strip(),
                    "type":    ptype,
                    "raw":     pd_raw,
                    "date":    r["CREATED_DATE"].strip()[:10],
                    "status":  r["STATUS"].strip(),
                    "days":    days,
                    "address": r["INCIDENT_ADDRESS"].strip(),
                    "zip":     r["INCIDENT_ZIP"].strip(),
                    "borough": borough,
                    "priority": PRIORITY_MAP.get(ptype, "Medium"),
                    "lat":     lat,
                    "lng":     lng,
                })
        rows.sort(key=lambda x: x["date"], reverse=True)
        pool.extend(rows[:2000])
        print(f"    {borough:<14} · sampled {min(len(rows), 2000):>4} of {len(rows)} records")
    out = OUT / "baked-complaints.json"
    out.write_text(json.dumps(pool, separators=(',', ':')), encoding="utf-8")
    print(f"  OK{out.name}  · {len(pool)} records  · {out.stat().st_size//1024} KB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("Baking vendors…")
    bake_vendors()
    print("Baking complaints…")
    bake_complaints()
    print("Done.")


if __name__ == "__main__":
    main()
