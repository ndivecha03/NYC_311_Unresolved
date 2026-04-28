"""
Vercel serverless function: GET /api/socrata-proxy?<soql params>

Server-side proxy for NYC OpenData Socrata. The browser hits this endpoint
on the same origin as the deployed site, and the Vercel serverless runtime
makes the actual call to data.cityofnewyork.gov. This bypasses any
client-side firewall, DNS filter, or corporate proxy that blocks the NYC
domain — the user's machine only ever talks to *.vercel.app.

Side benefit: a free Socrata app token can be attached server-side via the
SOCRATA_APP_TOKEN env var, which lifts the rate limit from ~1k/hour
(unauthenticated) to effectively unlimited. The token never touches the
browser.

Usage from the browser:
    fetch('/api/socrata-proxy?$select=count(*)&$where=...')

Defaults to the streetlight dataset (erm2-nwe9). Override with `_dataset`
query param if needed (e.g. `_dataset=abc-1234`).
"""

import json
import os
import urllib.parse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

DEFAULT_DATASET   = "erm2-nwe9"   # NYC 311 Service Requests
SOCRATA_HOST      = "https://data.cityofnewyork.gov"
APP_TOKEN         = os.environ.get("SOCRATA_APP_TOKEN", "")
ALLOWED_ORIGIN    = os.environ.get("ALLOWED_ORIGIN", "*")
TIMEOUT_SECONDS   = 12
MAX_QUERY_LENGTH  = 4096

# Allow only Socrata SoQL parameters and our own _dataset / _format escape.
ALLOWED_PARAMS = {
    "$select", "$where", "$group", "$order", "$having",
    "$limit", "$offset", "$q", "$query",
    "_dataset",
}


class handler(BaseHTTPRequestHandler):
    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _reply(self, status, body, content_type="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Cache successful aggregate responses for 5 min — Socrata aggregations
        # don't change second-to-second and this dramatically reduces upstream
        # load. Users still see fresh-enough data.
        if status == 200:
            self.send_header("Cache-Control", "public, max-age=300, s-maxage=300")
        else:
            self.send_header("Cache-Control", "no-store")
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        # Parse + sanitize the query string
        parsed = urllib.parse.urlparse(self.path)
        if len(parsed.query) > MAX_QUERY_LENGTH:
            return self._reply(414, {"error": "Query too long."})

        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        # Reject unknown params (defense-in-depth against open-proxy abuse)
        for k in params:
            if k not in ALLOWED_PARAMS:
                return self._reply(400, {"error": f"Unsupported parameter: {k}"})

        dataset = (params.pop("_dataset", [DEFAULT_DATASET])[0] or DEFAULT_DATASET)
        # Allow only kebab-case Socrata identifiers
        if not all(c.isalnum() or c == "-" for c in dataset) or len(dataset) > 16:
            return self._reply(400, {"error": "Invalid dataset id."})

        # Build forward URL
        forward_qs = urllib.parse.urlencode(
            [(k, v) for k, vs in params.items() for v in vs]
        )
        forward_url = f"{SOCRATA_HOST}/resource/{dataset}.json?{forward_qs}"

        req = urllib.request.Request(forward_url, headers={"Accept": "application/json"})
        if APP_TOKEN:
            req.add_header("X-App-Token", APP_TOKEN)

        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                body = resp.read()
            return self._reply(200, body)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:400]
            return self._reply(e.code, {
                "error": f"Socrata HTTP {e.code}",
                "detail": detail,
                "url": forward_url,
            })
        except urllib.error.URLError as e:
            return self._reply(502, {
                "error": f"Cannot reach Socrata: {e.reason}",
                "url": forward_url,
            })
        except Exception as e:
            return self._reply(500, {
                "error": f"{type(e).__name__}: {e}",
            })
