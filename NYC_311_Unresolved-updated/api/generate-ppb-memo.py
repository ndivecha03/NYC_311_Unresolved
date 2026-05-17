"""
Vercel serverless function: POST /api/generate-ppb-memo
--------------------------------------------------------
Generates a PPB Rule 3-08 Sole-Source Procurement Authorization Memo as a PDF.
The memo pre-fills all required fields from the work order + vendor data so the
agency staffer only needs to sign.

PPB Rule 3-08 (NYC Procurement Policy Board, effective 2019) allows any city
agency to purchase goods or services directly from a certified M/WBE vendor up
to $1.5M per purchase without competitive solicitation.

Input (JSON body):
  {
    "vendor": {
      "name":          string,   // formal legal name on MBE/WBE cert
      "license":       string,   // NYC electrical contractor license #
      "mwbe_cert_id":  string,   // SBS certification ID (ci93-uc8s)
      "mwbe_type":     string,   // "MBE" | "WBE" | "MBE/WBE"
      "address":       string,   // vendor HQ address
      "phone":         string
    },
    "work_order": {
      "defnum":             string,   // WO reference number
      "complaint_type":     string,
      "complaint_code":     string,
      "onprimname":         string,   // street
      "housenum":           string,
      "borough_full":       string,
      "specloc":            string,
      "instructions":       string,
      "materials_needed":   string,
      "estimated_days_to_complete": integer,
      "priority_code":      string
    },
    "agency": {
      "name":       string,   // e.g. "NYC Department of Transportation"
      "division":   string,   // e.g. "Division of Street Lighting"
      "contact":    string,   // name of authorizing official
      "title":      string
    },
    "estimated_cost": number   // optional — dollar amount for the work order
  }

Output: application/pdf blob

Environment variables required: none (pure PDF generation, no external calls)
"""

import io
import json
import math
import os
import time
from http.server import BaseHTTPRequestHandler
from datetime import datetime

# ---------------------------------------------------------------------------
# reportlab imports
# ---------------------------------------------------------------------------
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ALLOWED_ORIGIN      = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_BODY_BYTES      = 32 * 1024

NYC_BLUE            = colors.HexColor("#0039A6")   # NYC official blue
NYC_ORANGE          = colors.HexColor("#FF6319")   # NYC official orange
RULE_TEAL           = colors.HexColor("#007A8C")   # equity-tool teal
LIGHT_GRAY          = colors.HexColor("#F5F5F5")
MID_GRAY            = colors.HexColor("#CCCCCC")
DARK_GRAY           = colors.HexColor("#333333")
GREEN_CHECK         = colors.HexColor("#1A6B2A")

NIGP_CODE           = "91514"   # Street Lighting Maintenance — NIGP commodity code
NAICS_CODE          = "238210"  # Electrical Contractors (NAICS 2022)

PPB_RULE_CITATION   = (
    "NYC Procurement Policy Board Rule 3-08(c)(1)(i) — M/WBE Noncompetitive "
    "Small Purchases: Any agency may purchase goods, services, or construction "
    "from a certified M/WBE vendor without competitive solicitation, provided "
    "the purchase does not exceed $1,500,000 per transaction."
)

RESP_DET_ITEMS = [
    ("Vendor is certified M/WBE by NYC SBS",                       "required"),
    ("Certification is active and not expired",                     "required"),
    ("Vendor holds required NYC contractor license",                "required"),
    ("No debarment, suspension, or integrity flag on file",         "required"),
    ("Prior performance satisfactory (if prior contracts exist)",   "recommended"),
    ("Estimated cost does not exceed $1,500,000",                   "required"),
    ("No single vendor has received more than $3M from agency YTD", "required"),
    ("Work falls within vendor's stated license classification",    "required"),
]

# ---------------------------------------------------------------------------
# PDF builder
# ---------------------------------------------------------------------------

def _build_pdf(data: dict) -> bytes:
    vendor     = data.get("vendor") or {}
    wo         = data.get("work_order") or {}
    agency     = data.get("agency") or {}
    est_cost   = data.get("estimated_cost")
    memo_date  = datetime.utcnow().strftime("%B %d, %Y")
    memo_ref   = f"PPB308-{wo.get('defnum', 'DRAFT').replace('SL-','')}"

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.9 * inch,
        rightMargin=0.9 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title=f"PPB Rule 3-08 Memo — {memo_ref}",
        author=agency.get("name", "NYC Agency"),
    )

    styles = getSampleStyleSheet()
    normal = styles["Normal"]

    # Custom styles
    def S(name, **kw):
        base = kw.pop("base", "Normal")
        s = ParagraphStyle(name, parent=styles[base], **kw)
        return s

    s_agency_name  = S("AgencyName",  fontSize=11, fontName="Helvetica-Bold",
                       textColor=NYC_BLUE, spaceAfter=1)
    s_agency_div   = S("AgencyDiv",   fontSize=9,  textColor=DARK_GRAY, spaceAfter=2)
    s_doc_type     = S("DocType",     fontSize=15, fontName="Helvetica-Bold",
                       textColor=NYC_BLUE, spaceBefore=4, spaceAfter=2)
    s_doc_sub      = S("DocSub",      fontSize=9,  textColor=colors.grey, spaceAfter=6)
    s_section_hdr  = S("SectionHdr",  fontSize=9,  fontName="Helvetica-Bold",
                       textColor=colors.white, spaceAfter=0)
    s_field_label  = S("FieldLabel",  fontSize=8,  fontName="Helvetica-Bold",
                       textColor=DARK_GRAY, spaceAfter=1)
    s_field_value  = S("FieldValue",  fontSize=9,  textColor=colors.black, spaceAfter=4)
    s_body         = S("Body",        fontSize=9,  leading=13, textColor=DARK_GRAY,
                       spaceAfter=4, alignment=TA_JUSTIFY)
    s_citation     = S("Citation",    fontSize=8,  leading=12, textColor=RULE_TEAL,
                       spaceAfter=6, leftIndent=10, borderPad=4)
    s_check_item   = S("CheckItem",   fontSize=8.5, leading=13, textColor=DARK_GRAY,
                       spaceAfter=2)
    s_sig_label    = S("SigLabel",    fontSize=8,  fontName="Helvetica-Bold",
                       textColor=DARK_GRAY, spaceAfter=1)
    s_sig_value    = S("SigValue",    fontSize=9,  textColor=colors.black, spaceAfter=0)
    s_footer       = S("Footer",      fontSize=7,  textColor=colors.grey,
                       alignment=TA_CENTER)
    s_warning      = S("Warning",     fontSize=8,  textColor=colors.HexColor("#7A0000"),
                       spaceAfter=4, leftIndent=6)

    # ── Helpers ──────────────────────────────────────────────────────────────

    def section_bar(title):
        """Dark blue bar with white title — used as section header."""
        t = Table([[Paragraph(title, s_section_hdr)]],
                  colWidths=[6.8 * inch])
        t.setStyle(TableStyle([
            ("BACKGROUND",  (0, 0), (-1, -1), NYC_BLUE),
            ("TOPPADDING",  (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ]))
        return t

    def field_row(label, value, bold_value=False):
        """Two-cell label/value row inside a shaded table."""
        vStyle = S(f"FV_{label[:6]}", base="Normal",
                   fontSize=9, fontName="Helvetica-Bold" if bold_value else "Helvetica",
                   textColor=colors.black, spaceAfter=4)
        t = Table(
            [[Paragraph(label, s_field_label), Paragraph(str(value), vStyle)]],
            colWidths=[1.8 * inch, 5.0 * inch],
        )
        t.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (0, 0), LIGHT_GRAY),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING",    (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING",   (0, 0), (0, 0), 6),
            ("LEFTPADDING",   (1, 0), (1, 0), 8),
            ("LINEBELOW",     (0, 0), (-1, -1), 0.5, MID_GRAY),
        ]))
        return t

    def two_col_fields(pairs):
        """Side-by-side label/value pairs in a 2-column layout."""
        rows = []
        for i in range(0, len(pairs), 2):
            left  = pairs[i]
            right = pairs[i + 1] if i + 1 < len(pairs) else ("", "")
            row = [
                Paragraph(left[0],  s_field_label),
                Paragraph(str(left[1]),  s_field_value),
                Paragraph(right[0], s_field_label),
                Paragraph(str(right[1]), s_field_value),
            ]
            rows.append(row)
        t = Table(rows, colWidths=[1.5 * inch, 2.0 * inch, 1.5 * inch, 1.8 * inch])
        t.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (0, -1), LIGHT_GRAY),
            ("BACKGROUND",    (2, 0), (2, -1), LIGHT_GRAY),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING",    (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING",   (0, 0), (-1, -1), 6),
            ("LINEBELOW",     (0, 0), (-1, -1), 0.5, MID_GRAY),
        ]))
        return t

    # ── Document content ─────────────────────────────────────────────────────
    story = []

    # ── 1. Letterhead ────────────────────────────────────────────────────────
    logo_name = agency.get("name") or "NYC Department of Transportation"
    logo_div  = agency.get("division") or "Division of Street Lighting"

    header_data = [[
        Paragraph(f"<b>City of New York</b><br/>{logo_name}", s_agency_name),
        Paragraph(
            f"Memo Ref: <b>{memo_ref}</b><br/>Date: {memo_date}",
            S("HeaderRight", fontSize=8, textColor=DARK_GRAY, alignment=TA_RIGHT)
        ),
    ]]
    header_table = Table(header_data, colWidths=[4.0 * inch, 2.8 * inch])
    header_table.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW",     (0, 0), (-1, -1), 1.5, NYC_BLUE),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(header_table)
    story.append(Paragraph(logo_div, s_agency_div))
    story.append(Spacer(1, 6))

    # Doc title
    story.append(Paragraph("SOLE-SOURCE PROCUREMENT AUTHORIZATION", s_doc_type))
    story.append(Paragraph(
        "Pursuant to NYC Procurement Policy Board Rule 3-08 — M/WBE Noncompetitive Small Purchase",
        s_doc_sub
    ))
    story.append(HRFlowable(width="100%", thickness=0.5, color=MID_GRAY, spaceAfter=8))

    # ── 2. Procurement summary ────────────────────────────────────────────────
    story.append(section_bar("SECTION 1 — PROCUREMENT SUMMARY"))
    story.append(Spacer(1, 4))

    addr = f"{wo.get('housenum','')} {wo.get('onprimname','')}, {wo.get('borough_full','')}, NY".strip(", ")
    desc = wo.get("instructions") or wo.get("complaint_type") or "Streetlight repair as described in attached work order."

    story.append(field_row("Work Order #",       wo.get("defnum", "—"), bold_value=True))
    story.append(field_row("Complaint Type",      wo.get("complaint_type", "—")))
    story.append(field_row("Complaint Code",      f"{wo.get('complaint_code','—')}   (NIGP: {NIGP_CODE} · NAICS: {NAICS_CODE})"))
    story.append(field_row("Site Address",        addr or "—"))
    story.append(field_row("Location Detail",     wo.get("specloc", "—")))
    story.append(field_row("Priority",            wo.get("priority_code", "—")))

    cost_str = (
        f"${est_cost:,.2f}" if isinstance(est_cost, (int, float)) and est_cost > 0
        else "To be determined upon scope finalization"
    )
    story.append(field_row("Estimated Cost",      cost_str, bold_value=True))
    story.append(field_row("Est. Completion",
                            f"{wo.get('estimated_days_to_complete','—')} calendar days from dispatch"))
    story.append(Spacer(1, 8))

    # Work description
    story.append(Paragraph(
        "<b>Work Description:</b>",
        S("WDLabel", fontSize=9, fontName="Helvetica-Bold", spaceAfter=2)
    ))
    story.append(Paragraph(desc, s_body))
    story.append(Spacer(1, 6))

    # ── 3. Policy authority ───────────────────────────────────────────────────
    story.append(section_bar("SECTION 2 — POLICY AUTHORITY"))
    story.append(Spacer(1, 4))
    story.append(Paragraph(PPB_RULE_CITATION, s_citation))
    story.append(Paragraph(
        "This procurement is authorized under the above rule. Competitive solicitation is waived because "
        "the selected vendor holds active M/WBE certification from NYC Small Business Services (SBS), "
        "the estimated purchase amount is within the $1,500,000 threshold, and the vendor is responsible "
        "per the checklist in Section 4 below.",
        s_body
    ))
    story.append(Spacer(1, 8))

    # ── 4. Vendor information ─────────────────────────────────────────────────
    story.append(section_bar("SECTION 3 — SELECTED VENDOR"))
    story.append(Spacer(1, 4))

    cert_id   = vendor.get("mwbe_cert_id") or "See SBS PASSPort record"
    mwbe_type = vendor.get("mwbe_type") or "M/WBE"

    story.append(field_row("Legal Business Name", vendor.get("name", "—"), bold_value=True))
    story.append(field_row("SBS Certification ID", cert_id))
    story.append(field_row("Certification Type",   mwbe_type))
    story.append(field_row("NYC License #",        vendor.get("license", "—")))
    story.append(field_row("Vendor Address",       vendor.get("address", "—")))
    story.append(field_row("Phone",                vendor.get("phone", "—")))
    story.append(Spacer(1, 8))

    # ── 5. Responsibility determination ──────────────────────────────────────
    story.append(section_bar("SECTION 4 — RESPONSIBILITY DETERMINATION CHECKLIST"))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "The procuring agency attests that it has verified each item below prior to "
        "authorizing this purchase. Items marked REQUIRED must be confirmed; items marked "
        "RECOMMENDED represent best-practice due diligence.",
        s_body
    ))
    story.append(Spacer(1, 4))

    check_rows = []
    for item_text, item_type in RESP_DET_ITEMS:
        tag_color = "#006400" if item_type == "required" else "#8B6914"
        tag       = item_type.upper()
        check_rows.append([
            Paragraph("☐", S("Box", fontSize=13, textColor=RULE_TEAL)),
            Paragraph(
                f'{item_text}  '
                f'<font color="{tag_color}"><b>[{tag}]</b></font>',
                s_check_item
            ),
        ])

    check_table = Table(check_rows, colWidths=[0.3 * inch, 6.5 * inch])
    check_table.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",    (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LINEBELOW",     (0, 0), (-1, -1), 0.3, MID_GRAY),
    ]))
    story.append(check_table)
    story.append(Spacer(1, 8))

    # ── 6. Signature block ────────────────────────────────────────────────────
    story.append(KeepTogether([
        section_bar("SECTION 5 — AUTHORIZATION & SIGNATURE"),
        Spacer(1, 10),
        Paragraph(
            "I, the undersigned authorized official of the procuring agency, certify that: "
            "(a) the vendor named above is a currently certified M/WBE in good standing with NYC SBS; "
            "(b) the responsibility determination checklist in Section 4 has been completed; "
            "(c) this procurement does not exceed $1,500,000; and "
            "(d) all requirements of PPB Rule 3-08 have been met.",
            s_body
        ),
        Spacer(1, 14),
    ]))

    contact_name  = agency.get("contact") or "____________________________"
    contact_title = agency.get("title")   or "____________________________"
    agency_name   = agency.get("name")    or "____________________________"

    sig_data = [
        [
            Paragraph("Authorizing Official", s_sig_label),
            Paragraph("", s_sig_label),
            Paragraph("Date", s_sig_label),
        ],
        [
            Paragraph(f"<u>{contact_name}</u>", s_sig_value),
            Paragraph("", s_sig_value),
            Paragraph("________________", s_sig_value),
        ],
        [Paragraph("", s_sig_label)] * 3,
        [
            Paragraph("Title", s_sig_label),
            Paragraph("", s_sig_label),
            Paragraph("Agency", s_sig_label),
        ],
        [
            Paragraph(f"<u>{contact_title}</u>", s_sig_value),
            Paragraph("", s_sig_value),
            Paragraph(f"<u>{agency_name}</u>", s_sig_value),
        ],
        [Paragraph("", s_sig_label)] * 3,
        [
            Paragraph("Vendor Representative (acknowledgment)", s_sig_label),
            Paragraph("", s_sig_label),
            Paragraph("Date", s_sig_label),
        ],
        [
            Paragraph("____________________________", s_sig_value),
            Paragraph("", s_sig_value),
            Paragraph("________________", s_sig_value),
        ],
    ]

    sig_table = Table(sig_data, colWidths=[3.2 * inch, 0.4 * inch, 3.2 * inch])
    sig_table.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "BOTTOM"),
        ("TOPPADDING",    (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW",     (0, 0), (0, 1),   0.5, DARK_GRAY),
        ("LINEBELOW",     (2, 0), (2, 1),   0.5, DARK_GRAY),
        ("LINEBELOW",     (0, 3), (0, 4),   0.5, DARK_GRAY),
        ("LINEBELOW",     (2, 3), (2, 4),   0.5, DARK_GRAY),
        ("LINEBELOW",     (0, 6), (0, 7),   0.5, DARK_GRAY),
        ("LINEBELOW",     (2, 6), (2, 7),   0.5, DARK_GRAY),
    ]))
    story.append(sig_table)
    story.append(Spacer(1, 10))

    # ── 7. Footer ─────────────────────────────────────────────────────────────
    story.append(HRFlowable(width="100%", thickness=0.5, color=MID_GRAY, spaceBefore=4, spaceAfter=4))
    story.append(Paragraph(
        f"Generated by NYC Street Lights Equity Vendor Matrix  ·  {memo_date}  ·  "
        f"Ref {memo_ref}  ·  This document must be retained in the agency procurement file per "
        "NYC Charter §315 record-keeping requirements.",
        s_footer
    ))

    doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _reply_error(self, status: int, msg: str):
        payload = json.dumps({"error": msg}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(payload)

    def _reply_pdf(self, pdf_bytes: bytes, filename: str):
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf_bytes)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self._send_cors()
        self.end_headers()
        self.wfile.write(pdf_bytes)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._reply_error(413, f"Body must be 1–{MAX_BODY_BYTES} bytes.")

        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self._reply_error(400, f"Invalid JSON: {e}")

        if not isinstance(data, dict):
            return self._reply_error(400, "Body must be a JSON object.")

        try:
            pdf_bytes = _build_pdf(data)
        except Exception as e:
            return self._reply_error(500, f"PDF generation error: {type(e).__name__}: {e}")

        wo_ref   = (data.get("work_order") or {}).get("defnum", "DRAFT")
        filename = f"PPB308-Memo-{wo_ref}.pdf"
        self._reply_pdf(pdf_bytes, filename)
