function downloadPpbMemo(triggerLabel){
  const wo     = window._workOrder;
  const vendor = window._selectedVendor;
  if(!wo){ return; }

  const memoStatus = document.getElementById('woMemoStatus');
  if(memoStatus) memoStatus.textContent = 'Building memo…';

  try {
    const { jsPDF } = window.jspdf;
    const doc  = new jsPDF({ unit:'pt', format:'letter' });
    const W    = doc.internal.pageSize.getWidth();
    const mar  = 54;
    const col  = W - mar*2;
    const NYC_BLUE  = [0, 57, 166];
    const TEAL      = [0, 122, 140];
    const DARK      = [51, 51, 51];
    const MID_GRAY  = [180, 180, 180];
    const LT_GRAY   = [245, 245, 245];
    const WHITE     = [255, 255, 255];

    let y = 48;

    function setFont(style, size, color){
      doc.setFont('helvetica', style || 'normal');
      doc.setFontSize(size || 9);
      doc.setTextColor(...(color || DARK));
    }
    function rule(yPos, thick, color){
      doc.setLineWidth(thick || 0.5);
      doc.setDrawColor(...(color || MID_GRAY));
      doc.line(mar, yPos, W - mar, yPos);
    }
    function sectionBar(title, yPos){
      doc.setFillColor(...NYC_BLUE);
      doc.rect(mar, yPos, col, 18, 'F');
      setFont('bold', 9, WHITE);
      doc.text(title, mar + 8, yPos + 12.5);
      return yPos + 18 + 6;
    }
    function fieldRow(label, value, yPos, bold){
      doc.setFillColor(...LT_GRAY);
      doc.rect(mar, yPos, 130, 18, 'F');
      setFont('bold', 7.5, DARK);
      doc.text(label, mar + 6, yPos + 12);
      setFont(bold ? 'bold' : 'normal', 9, [0,0,0]);
      const wrapped = doc.splitTextToSize(String(value || '—'), col - 140);
      doc.text(wrapped, mar + 138, yPos + 12);
      const rowH = Math.max(18, wrapped.length * 11 + 7);
      rule(yPos + rowH, 0.3, MID_GRAY);
      return yPos + rowH;
    }
    function bodyText(text, yPos, opts){
      setFont('normal', 8.5, DARK);
      const wrapped = doc.splitTextToSize(text, col);
      doc.text(wrapped, mar, yPos, opts || {});
      return yPos + wrapped.length * 12 + 4;
    }
    function checkRow(text, yPos){
      doc.setDrawColor(...TEAL);
      doc.setLineWidth(0.8);
      doc.rect(mar + 2, yPos + 2, 9, 9);
      setFont('normal', 8.5, DARK);
      const wrapped = doc.splitTextToSize(text, col - 20);
      doc.text(wrapped, mar + 20, yPos + 9);
      const h = Math.max(16, wrapped.length * 11 + 5);
      rule(yPos + h, 0.3, MID_GRAY);
      return yPos + h;
    }
    function sigBlock(label, value, xPos, yPos, w){
      setFont('bold', 7.5, DARK);
      doc.text(label, xPos, yPos);
      setFont('normal', 9, [0,0,0]);
      doc.text(value || '____________________________', xPos, yPos + 14);
      rule(yPos + 16, 0.5, DARK);
      return yPos + 28;
    }
    function ensureSpace(needed){
      if(y + needed > doc.internal.pageSize.getHeight() - 54){
        doc.addPage();
        y = 48;
      }
    }

    const vName    = (vendor && vendor.name)    || wo._vendorName    || 'See work order';
    const vLicense = (vendor && vendor.license) || wo._vendorLicense || '—';
    const vPhone   = (vendor && vendor.phone)   || '—';
    const vAddr    = (vendor && vendor.address) || '____________________________';
    const certId   = (vendor && vendor.cert_id) || 'See SBS PASSPort record';
    const mwbeType = (vendor && vendor.mwbe)    || 'M/WBE';
    const memoRef  = 'PPB308-' + (wo.defnum || 'DRAFT').replace('SL-','');
    const memoDate = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
    const addr     = [wo.housenum, wo.onprimname, wo.borough_full].filter(Boolean).join(' ') + ', NY';
    const desc     = wo.instructions || wo.complaint_type || 'Streetlight repair per attached work order.';
    const pin      = wo.pin || ('DOT-' + (wo.defnum || 'DRAFT'));

    // 1. Letterhead
    setFont('bold', 11, NYC_BLUE);
    doc.text('City of New York', mar, y);
    setFont('normal', 9, NYC_BLUE);
    doc.text('NYC Department of Transportation — Division of Street Lighting', mar, y + 14);
    setFont('normal', 8, DARK);
    doc.text('Memo Ref: ' + memoRef, W - mar, y, {align:'right'});
    doc.text('Date: ' + memoDate,    W - mar, y + 11, {align:'right'});
    y += 22;
    rule(y, 1.5, NYC_BLUE);
    y += 10;

    setFont('bold', 14, NYC_BLUE);
    doc.text('M/WBE NONCOMPETITIVE SMALL PURCHASE AUTHORIZATION', mar, y);
    y += 16;
    setFont('normal', 8.5, [100,100,100]);
    doc.text('Pursuant to NYC Procurement Policy Board Rule 3-08(c)(1)(iv) — M/WBE Noncompetitive Small Purchase', mar, y);
    y += 8;
    rule(y, 0.5, MID_GRAY);
    y += 10;

    // 2. Procurement Summary
    y = sectionBar('SECTION 1 — PROCUREMENT SUMMARY', y);
    y = fieldRow('PIN',             pin, y, true);
    y = fieldRow('Work Order #',    wo.defnum || '—', y, true);
    y = fieldRow('Complaint Type',  wo.complaint_type || '—', y);
    y = fieldRow('Complaint Code',  (wo.complaint_code || '—') + '   (NIGP: 91514 · NAICS: 238210)', y);
    y = fieldRow('Site Address',    addr, y);
    y = fieldRow('Location Detail', wo.specloc || '—', y);
    y = fieldRow('Priority',        wo.priority_code || '—', y);
    y = fieldRow('Est. Completion', (wo.estimated_days_to_complete || '—') + ' calendar days from dispatch', y);
    y += 6;
    setFont('bold', 9, DARK);
    doc.text('Work Description:', mar, y);
    y += 12;
    y = bodyText(desc, y);
    y += 6;

    // 3. Policy Authority
    ensureSpace(80);
    y = sectionBar('SECTION 2 — POLICY AUTHORITY', y);
    setFont('normal', 8, TEAL);
    const citation = 'NYC Procurement Policy Board Rule 3-08(c)(1)(iv) — M/WBE Noncompetitive Small Purchases: No competition is required for the procurement of goods, services, and construction from M/WBE vendors, provided that the Contracting Officer obtains at least three price quotes from M/WBE vendors or documents their inability to do so, and provided the purchase does not exceed the maximum amount authorized pursuant to NYC Charter §311(i)(1) (currently $1,500,000).';
    const citLines = doc.splitTextToSize(citation, col - 12);
    doc.text(citLines, mar + 10, y);
    y += citLines.length * 11 + 8;
    y = bodyText('This procurement is authorized under the above rule. Formal competitive solicitation is not required because the selected vendor holds active M/WBE certification from NYC Small Business Services (SBS) and the estimated purchase amount is within the $1,500,000 threshold. The Contracting Officer has obtained price quotes as documented in Section 3 below, confirmed the price is reasonable, and verified vendor responsibility per the checklist in Section 5.', y);
    y += 6;

    // 4. Price Quotes
    ensureSpace(160);
    y = sectionBar('SECTION 3 — PRICE QUOTES (PPB Rule 3-08(c)(1)(iv))', y);
    y = bodyText('Per Rule 3-08(c)(1)(iv), the Contracting Officer must attempt to obtain at least three price quotes from M/WBE vendors or document the inability to do so. Complete one of the two options below.', y);
    y += 6;
    setFont('bold', 8.5, NYC_BLUE);
    doc.text('OPTION A — Three quotes obtained:', mar, y);
    y += 14;
    for(const qh of ['Quote #1', 'Quote #2', 'Quote #3']){
      doc.setFillColor(...LT_GRAY);
      doc.rect(mar, y, col, 22, 'F');
      setFont('bold', 7.5, DARK);
      doc.text(qh, mar + 6, y + 9);
      setFont('normal', 8, DARK);
      doc.text('Vendor Name: ____________________________   Amount: $______________   Date: ____________', mar + 55, y + 9);
      rule(y + 22, 0.3, MID_GRAY);
      y += 22;
    }
    y += 8;
    setFont('bold', 8.5, NYC_BLUE);
    doc.text('OPTION B — Unable to obtain three quotes (explain below):', mar, y);
    y += 14;
    doc.setFillColor(...LT_GRAY);
    doc.rect(mar, y, col, 36, 'F');
    rule(y + 36, 0.3, MID_GRAY);
    y += 44;
    setFont('bold', 8.5, DARK);
    doc.text('Price Reasonableness Determination  [REQUIRED]', mar, y);
    y += 12;
    y = bodyText('The Contracting Officer attests that the price selected is fair and reasonable based on (check all that apply):', y);
    const priceOpts = ['Market research', 'Prior contracts', 'Independent cost estimate', 'Other (describe below)'];
    const optW = col / 2;
    for(let oi = 0; oi < priceOpts.length; oi++){
      const ox = mar + (oi % 2) * optW;
      const oy = y + Math.floor(oi / 2) * 16;
      doc.setDrawColor(...TEAL);
      doc.setLineWidth(0.8);
      doc.rect(ox + 2, oy, 8, 8);
      setFont('normal', 8.5, DARK);
      doc.text(priceOpts[oi], ox + 14, oy + 7);
    }
    y += Math.ceil(priceOpts.length / 2) * 16 + 4;
    doc.setFillColor(...LT_GRAY);
    doc.rect(mar, y, col, 28, 'F');
    rule(y + 28, 0.3, MID_GRAY);
    y += 36;

    // 5. Selected Vendor
    ensureSpace(120);
    y = sectionBar('SECTION 4 — SELECTED VENDOR', y);
    y = fieldRow('Legal Business Name',  vName,    y, true);
    y = fieldRow('Vendor Address',       vAddr,    y);
    y = fieldRow('SBS Certification ID', certId,   y);
    y = fieldRow('Certification Type',   mwbeType, y);
    y = fieldRow('NYC License #',        vLicense, y);
    y = fieldRow('Phone',                vPhone,   y);
    y += 6;

    // 6. Responsibility Checklist
    ensureSpace(180);
    y = sectionBar('SECTION 5 — RESPONSIBILITY DETERMINATION CHECKLIST', y);
    y = bodyText('The procuring agency attests that it has verified each item below prior to authorizing this purchase.', y);
    y += 4;
    const checks = [
      'Vendor is certified M/WBE by NYC SBS  [REQUIRED]',
      'Certification is active and not expired  [REQUIRED]',
      'Vendor holds required NYC contractor license  [REQUIRED]',
      'No debarment, suspension, or integrity flag on file  [REQUIRED]',
      'Prior performance satisfactory (if prior contracts exist)  [RECOMMENDED]',
      'Estimated cost does not exceed $1,500,000  [REQUIRED]',
      'No single vendor has received more than $3M from agency YTD  [REQUIRED]',
      'Work falls within vendor\'s stated license classification  [REQUIRED]',
    ];
    for(const item of checks){
      ensureSpace(20);
      y = checkRow(item, y);
    }
    y += 6;

    // 7. Signature Block
    ensureSpace(160);
    y = sectionBar('SECTION 6 — AUTHORIZATION & SIGNATURE', y);
    y = bodyText('I, the undersigned authorized official, certify that: (a) the vendor named above is a currently certified M/WBE in good standing with NYC SBS; (b) at least three price quotes were obtained or the inability to do so has been documented per Section 3; (c) the price has been determined to be fair and reasonable; (d) the responsibility determination checklist in Section 5 has been completed; (e) this procurement does not exceed $1,500,000; and (f) all requirements of PPB Rule 3-08(c)(1)(iv) have been met.', y);
    y += 16;
    const halfW = (col - 20) / 2;
    sigBlock('Authorizing Official',   '', mar,              y, halfW);
    sigBlock('Date',                   '', mar + halfW + 20, y, halfW);
    y += 36;
    sigBlock('Title',                  '', mar,              y, halfW);
    sigBlock('Agency',  'NYC Dept. of Transportation', mar + halfW + 20, y, halfW);
    y += 36;
    sigBlock('Vendor Representative (acknowledgment)', '', mar, y, halfW);
    sigBlock('Date',                   '', mar + halfW + 20, y, halfW);
    y += 36;

    // 8. Footer
    const pageCount = doc.internal.getNumberOfPages();
    for(let i = 1; i <= pageCount; i++){
      doc.setPage(i);
      rule(doc.internal.pageSize.getHeight() - 36, 0.5, MID_GRAY);
      setFont('normal', 7, [150,150,150]);
      doc.text(
        'Generated by NYC Street Lights Equity Vendor Matrix  \u00b7  ' + memoDate + '  \u00b7  Ref ' + memoRef + '  \u00b7  Retain in agency procurement file per NYC Charter \u00a7315',
        W/2, doc.internal.pageSize.getHeight() - 24, {align:'center'}
      );
    }

    doc.save('PPB308-Memo-' + (wo.defnum || 'DRAFT') + '.pdf');
    if(memoStatus) memoStatus.textContent = '\u2713 Memo downloaded';

  } catch(e) {
    console.error('PPB memo generation failed:', e);
    if(memoStatus) memoStatus.textContent = '\u26a0 Memo error: ' + e.message;
  }
}
