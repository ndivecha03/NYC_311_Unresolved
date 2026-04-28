"""
Vercel serverless function: GET /api/health
-------------------------------------------
Canary endpoint. Returns ok=true if the deployed site can validate that
NYC OpenData (erm2-nwe9) still returns the expected 2024 Manhattan total.

  ok      : bool   — true if Manhattan 2024 count is within 10% of 4,962
  value   : int    — the count returned by Socrata
  detail  : str    — human-readable status

Note: the *browser* can call Socrata directly (see public/data-loader.js
healthCheck()), so this serverside check is mainly useful for external
uptime monitors (StatusCake, BetterStack) that want a single URL to ping.

Vercel's Python sandbox has had DNS issues with data.cityofnewyork.gov
in the past; if the request fails, the response is still HTTP 200 with
ok=false and a detail explaining why — so the browser-side check stays
authoritative.
"""

import json
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler

DATASET = "https://data.cityofnewyork.gov/resource/erm2-nwe9.json"
EXPECTED_MANHATTAN_2024 = 4962
TOLERANCE = 0.10  # ±10%

QUERY = {
    "$select": "count(*)",
    "$where": (
        "complaint_type='Street Light Condition' "
        "AND created_date>='2024-01-01T00:00:00' "
        "AND created_date<'2025-01-01T00:00:00' "
        "AND borough='MANHATTAN'"
    ),
}


class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = DATASET + "?" + urllib.parse.urlencode(QUERY)
        try:
            with urllib.request.urlopen(url, timeout=8) as resp:
                rows = json.loads(resp.read().decode("utf-8"))
            n = int(rows[0].get("count_1") or rows[0].get("count") or 0)
            drift = abs(n - EXPECTED_MANHATTAN_2024) / EXPECTED_MANHATTAN_2024
            ok = drift < TOLERANCE
            return self._send(200, {
                "ok": ok,
                "value": n,
                "expected": EXPECTED_MANHATTAN_2024,
                "drift_pct": round(drift * 100, 2),
                "detail": (
                    f"Manhattan 2024 count = {n} "
                    f"(expected ~{EXPECTED_MANHATTAN_2024}, drift {drift*100:.1f}%)"
                ),
            })
        except urllib.error.URLError as e:
            return self._send(200, {"ok": False, "value": None,
                                    "detail": f"Socrata unreachable from server: {e.reason}"})
        except Exception as e:
            return self._send(200, {"ok": False, "value": None,
                                    "detail": f"{type(e).__name__}: {e}"})
