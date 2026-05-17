"""
Vercel serverless function: POST /api/generate-work-order
---------------------------------------------------------
Generates an NYC DOT-format work order JSON for a streetlight complaint
using Claude Sonnet 4.5.

The output schema matches NYC DOT's actual work-order format (verified
against 12 sample orders from the user). Frontend renders the JSON into
a styled official document.

Environment variables required in Vercel:
  ANTHROPIC_API_KEY

Optional:
  ALLOWED_ORIGIN
  ANTHROPIC_MODEL    (default: claude-sonnet-4-5)
"""

import json
import os
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ANTHROPIC_URL       = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL       = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")
MAX_TOKENS          = 2200
MAX_BODY_BYTES      = 32 * 1024
MAX_DETAILS_CHARS   = 1500
MAX_EXAMPLES        = 5
RATE_LIMIT_PER_HOUR = 10
ALLOWED_ORIGIN      = os.environ.get("ALLOWED_ORIGIN", "*")

_rate_bucket = {}


# ---------------------------------------------------------------------------
# System prompt — encodes the NYC DOT work-order schema + priority rules
# derived from the 12 verified samples.
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You are the NYC Department of Transportation (DOT) work-order generator for the Division of Street Lighting.

Given an incoming streetlight complaint plus up to 5 similar resolved past orders as references, output a single JSON object that matches the official NYC DOT work-order schema EXACTLY. Field names, value formats, and enumerations are strict — DOT systems will reject anything else.

──────────────────────────────────────────────────────────────────────
SCHEMA (all fields required unless marked optional)

{
  "defnum":                       string,  // format "SL-YYYY-NNNNNN" — year + 6-digit serial
  "initby":                       "CSC",
  "source":                       "CTZ",
  "reported_by":                  "NYC 311",
  "housenum":                     string,  // street number; empty string if not provided
  "onfacename":                   string,  // abbreviated street ("E 161 ST", "ATLANTIC AV")
  "onprimname":                   string,  // full street ("EAST 161ST STREET", "ATLANTIC AVENUE")
  "frmprimnam":                   string,  // cross-street from
  "toprimname":                   string,  // cross-street to
  "specloc":                      string,  // location detail ("NB SIDE I/F/O ADDRESS NR LAMPPOST")
  "boro":                         "M" | "B" | "X" | "Q" | "SI",
  "borough_full":                 "MANHATTAN" | "BROOKLYN" | "BRONX" | "QUEENS" | "STATEN ISLAND",
  "rptdate":                      string,  // ISO datetime "YYYY-MM-DDT00:00:00.000"
  "rptclosed":                    null,
  "response_requirement":         string,  // see PRIORITY RULES below
  "complaint_type":               string,  // canonical DOT category — see CODE TABLE
  "complaint_code":               string,  // SLO-/SLC-/SLG-/SLF-/SLB-/SLD- prefix per CODE TABLE
  "priority_code":                "PRIORITY 1 — EMERGENCY" | "PRIORITY 2 — NON-EMERGENCY" | "PRIORITY 3 — ROUTINE",
  "priority_reason":              string,  // 1 sentence justifying priority assignment
  "pole_number":                  string,  // format "{BORO2}-{STREET3}-{HOUSENUM4}", uppercase
  "estimated_days_to_complete":   integer, // 1-14
  "materials_needed":             string,  // specific part numbers per CODE TABLE, or "None — adjustment only"
  "work_steps":                   string[], // numbered, 5-8 items, EACH starting with "N. "
  "instructions":                 string,  // 2-4 sentences summarizing dispatch action
  "safety_notes":                 string,  // PPE + traffic + electrical hazards (see SAFETY RULES)
  "inspector_approval_required":  boolean, // true for PRIORITY 1 OR structural damage
  "permit_required":              boolean, // true only if street excavation needed (rare)
  "status":                       "Open",
  "assigned_agency":              "NYC DOT — Division of Street Lighting"
}

──────────────────────────────────────────────────────────────────────
COMPLAINT CODE TABLE — pick the code that best matches the user input

Light Out / Cycling / Dim:
  SLO-01 "Street Light Out"                    P2 (10-day)
  SLO-02 "Multiple Street Lights Out"          P2 (10-day)
  SLC-01 "Street Light Cycling"                P3 (routine)
  SLC-02 "Time Clock Maladjusted"              P3 (routine)
  SLD-01 "Street Light Dim"                    P3 (routine)
  SLD-02 "Street Light Dayburning"             P3 (routine)

Glassware:
  SLG-01 "Glassware Missing"                   P2 (10-day)
  SLG-02 "Glassware Broken"                    P2 (10-day)
  SLG-03 "Glassware Hanging"                   P1 (4-hour) if over roadway, P2 otherwise

Fixture / Luminaire:
  SLF-01 "Fixture/Luminaire Missing"           P2 (10-day)
  SLF-03 "Fixture/Luminaire Damaged"           P2 (10-day)
  SLF-04 "Fixture/Luminaire Hanging"           P1 (4-hour) — falling hazard
  SLF-05 "Fixture/Luminaire Door Open"         P3 (routine)

Lamppost / Pole / Base:
  SLB-05 "Lamppost Base Door/Cover Open"       P3 (routine)
  SLB-06 "Lamppost Base Door/Cover Damaged"    P2 (10-day)
  SLB-07 "Lamppost Base Door/Cover Missing"    P1 (4-hour) — exposed wiring
  SLP-01 "Lamppost Damaged"                    P2 (10-day)
  SLP-02 "Lamppost Leaning"                    P1 (4-hour) if severe, P2 otherwise
  SLP-03 "Lamppost Knocked Down"               P1 (4-hour)
  SLW-01 "Wires Exposed"                       P1 (4-hour)

──────────────────────────────────────────────────────────────────────
PRIORITY RULES

PRIORITY 1 — EMERGENCY     → response_requirement: "RESPONSE REQUIRED WITHIN: 4 HOURS — EMERGENCY RESPONSE"
   Triggered by: hanging luminaire, hanging globe over roadway, missing base cover with exposed wiring,
   knocked-down pole, severely leaning pole, exposed wires, any visible arcing or sparks.
   ALWAYS sets inspector_approval_required = true.

PRIORITY 2 — NON-EMERGENCY → response_requirement: "RESPONSE REQUIRED WITHIN: 10 CALENDAR DAYS"
   Triggered by: light out, broken glassware, damaged fixture, missing fixture, damaged base cover,
   damaged pole, multiple lights out.

PRIORITY 3 — ROUTINE       → response_requirement: "RESPONSE REQUIRED WITHIN: 10 CALENDAR DAYS"
   Triggered by: cycling, time clock issues, dim lamp, dayburning, base door open with no exposed wiring,
   fixture door open with no internal damage.

If user input includes a `priority_hint`, weight it but override if the complaint_type clearly indicates otherwise.

──────────────────────────────────────────────────────────────────────
POLE NUMBER FORMAT

"{BORO2}-{STREET3}-{HOUSENUM4}", all uppercase, zero-padded housenum to 4 digits.
  BORO2: MN, BK, BX, QN, SI
  STREET3: 3-letter abbreviation of primary street name
           (drop "STREET", "AVENUE", direction prefix; take first 3 letters).
           Examples: "EAST 161ST STREET" → "161"; "ATLANTIC AVENUE" → "ATL"; "MAIN STREET" → "MAI"
  HOUSENUM4: zero-pad to 4 digits ("225" → "0225"). If no housenum, use "0000".

Examples from real orders: BX-161-0044, BK-ATL-0509, MN-COL-0721, QN-MAIN-7240

──────────────────────────────────────────────────────────────────────
MATERIALS LIBRARY — use these exact part numbers when applicable

  Globes:        Type A 16" borosilicate (NYC-GL-16A), retaining ring RR-2
  Luminaire:     LU-3 LED assembly (NYC-LU-3-LED), mounting arm bracket MAB-2
  Mounting:      Hardware kit MH-7B, M10 stainless hex bolts, silicone weatherseal NYC-SS-SIL
  Base cover:    Plate BP-4, hinge pin HP-1, tamper-resistant hex bolts NYC-TB-M8
  Door latch:    Latch assembly DL-1, tamper-resistant screws NYC-TS-10
  Bulbs:         150W HPS bulb (NYC-HPS-150), photocell PEC NYC-PC-2A, ballast NYC-BL-150
  Time clock:    No materials — calibration tool set + DOT seasonal schedule card DOT-LC-Q[N]-[YEAR]
  Housing:       Repair kit HK-2 for minor damage; replace luminaire entirely if cracked

──────────────────────────────────────────────────────────────────────
SAFETY NOTES — always start with "REQUIRED PPE:" and include relevant items below

  Always:               insulated gloves, safety glasses, high-visibility vest
  P1 / structural:      add hard hat, face shield, steel-toed boots
  Glass work:           add heavy-duty puncture-resistant gloves, face shield
  Roadway-adjacent:     "Contact DOT Traffic Operations at (212) 839-6900 before proceeding."
  Electrical work:      "Lockout/tagout required before handling any wiring."
  Hazard escalation:    "If burning smell, arcing, or visible flame is present, do not proceed — call Con Edison at 1-800-75-CONED and DOT Emergency Line at (718) 433-3000."
  Class 0 vs Class 00:  Class 0 for live circuit work, Class 00 for controller / sensor work

──────────────────────────────────────────────────────────────────────
WORK STEPS

Always 5-8 numbered steps. Each starts with "N. " (number, dot, space).
Step 1: confirm pole number and report arrival to DOT dispatch.
Step 2: site setup (PPE, exclusion zone, traffic control if needed).
Steps 3-N: diagnosis → repair → verification.
Final step: photograph completed work and submit field report.

For P1 emergencies, step 1 must reference DOT Emergency Dispatch at (718) 433-3000 and step N must specify report submission within 2 hours of closure.

──────────────────────────────────────────────────────────────────────
OUTPUT

Return ONLY the JSON object. No markdown fences, no preamble, no commentary. Minified or pretty — both are accepted by DOT systems."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now(): return int(time.time())


def _rate_limit_check(ip: str) -> bool:
    cutoff = _now() - 3600
    hits = [t for t in _rate_bucket.get(ip, []) if t > cutoff]
    if len(hits) >= RATE_LIMIT_PER_HOUR:
        _rate_bucket[ip] = hits
        return False
    hits.append(_now())
    _rate_bucket[ip] = hits
    return True


def _validate_payload(payload: dict):
    if not isinstance(payload, dict):
        raise ValueError("Body must be a JSON object.")
    c = payload.get("complaint")
    if not isinstance(c, dict):
        raise ValueError("Missing `complaint` object.")
    for f in ("complaint_id", "complaint_type", "address", "borough", "reported_date"):
        if not c.get(f):
            raise ValueError(f"complaint.{f} is required.")
    details = c.get("details") or ""
    if len(details) > MAX_DETAILS_CHARS:
        c["details"] = details[:MAX_DETAILS_CHARS]
    examples = payload.get("similar_past_orders") or []
    if not isinstance(examples, list):
        raise ValueError("`similar_past_orders` must be an array.")
    payload["similar_past_orders"] = examples[:MAX_EXAMPLES]
    return payload


def _build_user_message(payload: dict) -> str:
    c = payload["complaint"]
    examples = payload["similar_past_orders"]
    vendor   = payload.get("vendor") or {}

    ex_block = ""
    if examples:
        ex_block = (
            "REFERENCE — similar past resolved orders (use to estimate "
            "duration, materials, and workflow):\n\n"
            f"{json.dumps(examples, indent=2, default=str)}\n\n"
        )

    vendor_block = ""
    if vendor.get("name"):
        vendor_block = (
            "Assigned vendor (licensed NYC electrical contractor):\n"
            f"  name:    {vendor.get('name','')}\n"
            f"  license: {vendor.get('license','')}\n\n"
        )

    return (
        f"{ex_block}"
        f"{vendor_block}"
        "Generate the work-order JSON for this incoming OPEN complaint:\n\n"
        f"  complaint_id:   {c.get('complaint_id')}\n"
        f"  complaint_type: {c.get('complaint_type')}\n"
        f"  address:        {c.get('address')}\n"
        f"  borough:        {c.get('borough')}\n"
        f"  zip:            {c.get('zip','')}\n"
        f"  reported_date:  {c.get('reported_date')}\n"
        f"  duration:       {c.get('duration','')}\n"
        f"  priority_hint:  {c.get('priority','')}\n"
        f"  user_details:   {c.get('details','(none provided)')}\n\n"
        "Return ONLY the JSON object matching the schema in your system prompt."
    )


def _call_anthropic(api_key: str, user_msg: str, model: str) -> dict:
    body = json.dumps({
        "model":      model,
        "max_tokens": MAX_TOKENS,
        "system":     SYSTEM_PROMPT,
        "messages":   [{"role": "user", "content": user_msg}],
    }).encode("utf-8")

    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         api_key,
            "anthropic-version": "2023-06-01",
        },
    )

    last_err = None
    raw = None
    for backoff in [1, 3, 7, 0]:
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 502, 503, 504, 529) and backoff:
                time.sleep(backoff)
                continue
            raise
    if raw is None and last_err is not None:
        raise last_err

    data = json.loads(raw)
    text = data.get("content", [{}])[0].get("text", "").strip()

    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip("` \n")
    return json.loads(text)


# ---------------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _reply(self, status: int, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_POST(self):
        ip = (
            self.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or self.client_address[0]
            or "unknown"
        )
        if not _rate_limit_check(ip):
            return self._reply(429, {"error": "Rate limit exceeded. Try again in an hour."})

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._reply(413, {"error": f"Request body must be 1-{MAX_BODY_BYTES} bytes."})

        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self._reply(400, {"error": f"Invalid JSON body: {e}"})

        try:
            payload = _validate_payload(payload)
        except ValueError as e:
            return self._reply(400, {"error": str(e)})

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            return self._reply(500, {
                "error": "Server is missing ANTHROPIC_API_KEY. Set it in the Vercel dashboard."
            })

        user_msg = _build_user_message(payload)
        try:
            work_order = _call_anthropic(api_key, user_msg, DEFAULT_MODEL)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:400]
            if e.code == 529:
                return self._reply(503, {"error": "Claude is temporarily overloaded. Try again shortly.", "detail": detail})
            if e.code == 401:
                return self._reply(500, {"error": "Invalid ANTHROPIC_API_KEY on the server.", "detail": detail})
            return self._reply(502, {"error": f"Anthropic API error {e.code}", "detail": detail})
        except urllib.error.URLError as e:
            return self._reply(504, {"error": f"Anthropic API unreachable: {e.reason}"})
        except json.JSONDecodeError:
            return self._reply(502, {"error": "Claude returned a non-JSON response."})
        except Exception as e:
            return self._reply(500, {"error": f"Unexpected error: {type(e).__name__}: {e}"})

        return self._reply(200, work_order)
