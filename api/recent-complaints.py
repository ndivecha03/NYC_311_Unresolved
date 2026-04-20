"""
Vercel serverless function: GET /api/recent-complaints?zip=10025&borough=Manhattan&limit=50
---------------------------------------------------------------------------
Proxies NYC OpenData's 311 Socrata feed for Street Light Condition
complaints recently filed in a given ZIP (falling back to borough).

Returns a normalized JSON array matching the shape used by the baked-in
dataset, so the browser can merge results into its similarity search and
map display.

Optional environment variables:
  NYC_OPENDATA_APP_TOKEN  Free token from https://data.cityofnewyork.gov/profile/edit/developer_settings
                          Without a token Socrata allows ~1K anon req/hr per IP.
                          With a token: up to 100K/hr.
  ALLOWED_ORIGIN          Same as the other function (optional).

Short in-memory cache (5 min) keeps repeat lookups for the same ZIP off
the OpenData endpoint while a lambda stays warm.
"""

import json
import os
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import date
from http.server import BaseHTTPRequestHandler

# ----------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------
SOCRATA_URL      = "https://data.cityofnewyork.gov/resource/erm2-nwe9.json"
COMPLAINT_TYPE   = "Street Light Condition"
CACHE_TTL_SEC    = 300            # 5 min
DEFAULT_LIMIT    = 50
MAX_LIMIT        = 100
HTTP_TIMEOUT_SEC = 10
ALLOWED_ORIGIN   = os.environ.get("ALLOWED_ORIGIN", "*")

_cache = {}  # key -> (ts, data)

# Map Socrata `descriptor` values to the 7 canonical types this dashboard
# already models. Anything unknown falls back to "Street Light Out".
DESCRIPTOR_TO_TYPE = {
    "street light out":          "Street Light Out",
    "multiple streetlights out": "Multiple Lights Out",
    "multiple lights out":       "Multiple Lights Out",
    "street light dayburning":   "Street Light Dayburning",
    "street light cycling":      "Street Light Cycling",
    "dim street light":          "Dim Lamp",
    "street light dim":          "Dim Lamp",
    "dim lamp":                  "Dim Lamp",
    "damaged luminaire":         "Fixture/Glassware Issue",
    "missing luminaire":         "Fixture/Glassware Issue",
    "broken globe":              "Fixture/Glassware Issue",
    "fixture/glassware issue":   "Fixture/Glassware Issue",
    "damaged pole":              "Lamppost Damage",
    "knocked down pole":         "Lamppost Damage",
    "missing pole":              "Lamppost Damage",
    "lamppost damage":           "Lamppost Damage",
}


def _canonical_type(descriptor: str) -> str:
    if not descriptor:
        return "Street Light Out"
    key = descriptor.strip().lower()
    if key in DESCRIPTOR_TO_TYPE:
        return DESCRIPTOR_TO_TYPE[key]
    # Partial match (descriptors are sometimes verbose)
    for k, v in DESCRIPTOR_TO_TYPE.items():
        if k in key:
            return v
    return "Street Light Out"


def _fetch(zip_code: str, borough: str, limit: int):
    # Build $where clause - ZIP is more specific, prefer it; else borough.
    where = ["complaint_type='" + COMPLAINT_TYPE + "'"]
    if zip_code:
        where.append("incident_zip='" + zip_code + "'")
    elif borough:
        where.append("borough='" + borough.upper() + "'")

    params = {
        "$where":  " AND ".join(where),
        "$limit":  str(min(max(1, limit), MAX_LIMIT)),
        "$order":  "created_date DESC",
        "$select": (
            "unique_key,created_date,closed_date,complaint_type,descriptor,"
            "status,incident_address,street_name,incident_zip,borough,"
            "latitude,longitude"
        ),
    }
    url = SOCRATA_URL + "?" + urllib.parse.urlencode(params)

    headers = {"Accept": "application/json", "User-Agent": "NYC-Street-Lights-Dashboard/1.0"}
    token = os.environ.get("NYC_OPENDATA_APP_TOKEN")
    if token:
        headers["X-App-Token"] = token

    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _to_float(x):
    try:
        return float(x) if x not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _normalize(rows):
    out = []
    for r in rows:
        lat = _to_float(r.get("latitude"))
        lng = _to_float(r.get("longitude"))
        # Skip records without coordinates - they can't be mapped or scored.
        if lat is None or lng is None:
            continue

        created = (r.get("created_date") or "")[:10]
        closed  = (r.get("closed_date")  or "")[:10]
        status  = (r.get("status") or "Open").strip()
        resolution = None
        if status.lower() == "closed" and created and closed:
            try:
                resolution = max(0, (date.fromisoformat(closed) - date.fromisoformat(created)).days)
            except Exception:
                resolution = None

        descriptor = (r.get("descriptor") or "").strip()
        out.append({
            "id":         r.get("unique_key") or "",
            "date":       created,
            "type":       _canonical_type(descriptor),
            "raw_type":   descriptor,
            "status":     status,
            "resolution": resolution,
            "address":    (r.get("incident_address") or r.get("street_name") or "Unknown").strip(),
            "street":     (r.get("street_name") or "").strip(),
            "zip":        (r.get("incident_zip") or "").strip(),
            "borough":    (r.get("borough") or "").title().strip(),
            "lat":        round(lat, 6),
            "lng":        round(lng, 6),
            "live":       True,   # flag so UI can tag fresh records
        })
    return out


# ----------------------------------------------------------------------
# Handler
# ----------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def _send(self, status: int, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control",  "public, max-age=60")
        self.send_header("Access-Control-Allow-Origin",  ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        try:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            zip_code = (qs.get("zip",     [""])[0] or "").strip()
            borough  = (qs.get("borough", [""])[0] or "").strip()
            try:
                limit = int(qs.get("limit", [str(DEFAULT_LIMIT)])[0])
            except ValueError:
                limit = DEFAULT_LIMIT

            cache_key = zip_code + "|" + borough + "|" + str(limit)
            now = time.time()
            hit = _cache.get(cache_key)
            if hit and (now - hit[0]) < CACHE_TTL_SEC:
                return self._send(200, {"records": hit[1], "cached": True})

            raw  = _fetch(zip_code, borough, limit)
            data = _normalize(raw)
            _cache[cache_key] = (now, data)
            return self._send(200, {"records": data, "cached": False})

        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")[:200]
            except Exception:
                pass
            return self._send(502, {"error": "OpenData error " + str(e.code), "detail": detail, "records": []})
        except urllib.error.URLError as e:
            return self._send(504, {"error": "OpenData unreachable: " + str(e.reason), "records": []})
        except Exception as e:
            return self._send(500, {"error": type(e).__name__ + ": " + str(e), "records": []})
