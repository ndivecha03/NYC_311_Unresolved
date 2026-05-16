"""Quick diagnostic: list vendors that have any contract awards
   and a sample of M/WBE matches for spot-checking fuzzy joins."""
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
data = json.load((ROOT / "public" / "vendors.json").open(encoding="utf-8"))

print("=" * 80)
print("VENDORS WITH AT LEAST 1 CITY AWARD (the 'incumbents')")
print("=" * 80)
matched = [v for v in data["vendors"] if v["track_record"]["awardsTotalCount"] > 0]
print(f"{len(matched)} / {len(data['vendors'])} vendors\n")
for v in sorted(matched, key=lambda x: -x["track_record"]["awardsTotalAmount"])[:20]:
    tr = v["track_record"]
    print(f"{v['name']:48s}  awards={tr['awardsTotalCount']:3d}  total=${tr['awardsTotalAmount']:>14,.0f}  borough={v['address']['borough']}")

print("\n" + "=" * 80)
print("DIRECT-PURCHASE ELIGIBLE VENDORS — 2019 M/WBE rule, $1.5M per purchase")
print("=" * 80)
dpe = [v for v in data["vendors"]
       if v["scoring_inputs"]["direct_purchase_eligibility"]["eligible"]]
print(f"{len(dpe)} / {len(data['vendors'])} vendors eligible\n")
# Breakdown by ethnicity to confirm equity coverage
from collections import Counter
eth_counter = Counter()
borough_counter = Counter()
for v in dpe:
    eth_counter[v["certifications"].get("ethnicity") or "(none)"] += 1
    borough_counter[v["address"].get("borough") or "(none)"] += 1
print("By owner ethnicity:")
for eth, n in eth_counter.most_common():
    print(f"  {eth:25s}  {n}")
print("\nBy borough:")
for b, n in borough_counter.most_common():
    print(f"  {b:20s}  {n}")
print("\nFirst 10 eligible vendors:")
for v in dpe[:10]:
    c = v["certifications"]
    print(f"  {v['name']:48s}  cert={c.get('certification'):10s}  eth={c.get('ethnicity') or '-':12s}  borough={v['address']['borough']}")

print("\n" + "=" * 80)
print("RANDOM SAMPLE OF M/WBE MATCHES (spot-check fuzzy join quality)")
print("=" * 80)
mwbe_matched = [v for v in data["vendors"] if v["certifications"].get("certification")]
print(f"{len(mwbe_matched)} / {len(data['vendors'])} vendors with M/WBE certification\n")
random.seed(42)
sample = random.sample(mwbe_matched, min(15, len(mwbe_matched)))
for v in sample:
    c = v["certifications"]
    desc = (c.get("businessDescription") or "")[:90].replace("\n", " ")
    print(f"VENDOR: {v['name']}")
    print(f"  cert={c.get('certification')}  ethnicity={c.get('ethnicity')}  "
          f"naics={c.get('naicsCode')}  passport={c.get('passportEnrolled')}")
    print(f"  business: {desc}")
    print()
