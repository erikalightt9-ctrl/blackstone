// A dependency-free PDF writer, kept deliberately small: a content-stream builder plus the
// one document layout this system prints. Two versions of that layout exist -- the Standard
// Request Copy, and the Accounting / Internal Copy which adds the expense classifications.
const A4 = { width: 595, height: 842 };
const MARGIN = 40;
const BRAND = { r: 0.80, g: 0.09, b: 0.13 };
const STEEL = { r: 0.62, g: 0.64, b: 0.67 };
const LOGO_WIDTH = 215; // points; the header keeps the logo's own aspect ratio

// Approximate Helvetica advance widths, enough to align columns and wrap text predictably.
const NARROW = new Set([...' .,:;!|i\'`l()[]{}/\\jft-']);
const WIDE = new Set([...'MWmw@']);
const charWidth = (char, bold) => (NARROW.has(char) ? 0.30 : WIDE.has(char) ? 0.86 : char >= 'A' && char <= 'Z' ? 0.70 : 0.55) + (bold ? 0.03 : 0);
const widthOf = (text, size, bold = false) => [...String(text)].reduce((sum, char) => sum + charWidth(char, bold), 0) * size;

// Only WinAnsi-safe characters survive; the peso sign is spelled out as PHP everywhere.
const escape = text => String(text ?? '')
  .replaceAll('₱', 'PHP ').replaceAll('–', '-').replaceAll('—', '-')
  .replaceAll('‘', "'").replaceAll('’', "'").replaceAll('“', '"').replaceAll('”', '"')
  .replace(/[^\x20-\x7e]/g, '?')
  .replace(/[\\()]/g, '\\$&');

export function wrap(text, size, maxWidth, bold = false) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);
      line = word;
      while (widthOf(line, size, bold) > maxWidth && line.length > 1) {
        let cut = line.length;
        while (cut > 1 && widthOf(line.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

class Page {
  constructor() { this.ops = []; }
  text(x, y, value, { size = 9, bold = false, color = null, align = 'left', width = 0 } = {}) {
    const content = escape(value);
    let left = x;
    if (align === 'right') left = x - widthOf(value, size, bold);
    if (align === 'center') left = x + (width - widthOf(value, size, bold)) / 2;
    if (color) this.ops.push(`${color.r} ${color.g} ${color.b} rg`);
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${left.toFixed(2)} ${y.toFixed(2)} Td (${content}) Tj ET`);
    if (color) this.ops.push('0 0 0 rg');
    return this;
  }
  rect(x, y, width, height, color, stroke = false) {
    this.ops.push(`${color.r} ${color.g} ${color.b} ${stroke ? 'RG' : 'rg'} ${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re ${stroke ? 'S' : 'f'}`);
    this.ops.push('0 0 0 rg');
    return this;
  }
  line(x1, y1, x2, y2, color = { r: 0.8, g: 0.8, b: 0.8 }, thickness = 0.6) {
    this.ops.push(`${color.r} ${color.g} ${color.b} RG ${thickness} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S 0 0 0 RG 1 w`);
    return this;
  }
  image(name, x, y, width, height) {
    this.ops.push(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`);
    return this;
  }
  stream() { return this.ops.join('\n'); }
}

// Objects are assembled as buffers because an embedded image stream is binary, not text.
function serialize(pages, logo) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
  let logoResource = '';
  if (logo) {
    const image = (dictionary, data) => Buffer.concat([Buffer.from(`${dictionary}\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
    let maskId = 0;
    if (logo.alphaStream) {
      maskId = objects.length + 1;
      objects.push(image(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${logo.alphaStream.length} >>`, logo.alphaStream));
    }
    const logoId = objects.length + 1;
    objects.push(image(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${maskId ? ` /SMask ${maskId} 0 R` : ''} /Length ${logo.rgbStream.length} >>`, logo.rgbStream));
    logoResource = ` /XObject << /Logo ${logoId} 0 R >>`;
  }
  const ids = [];
  for (const page of pages) {
    const id = objects.length + 1; ids.push(id);
    const stream = page.stream();
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${logoResource} >> /Contents ${id + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const body = Buffer.isBuffer(object) ? object : Buffer.from(object, 'latin1');
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk); length += chunk.length;
  });
  const xref = length;
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, 'latin1'));
  return Buffer.concat(parts);
}

const peso = value => `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });

export function requestPdf(request, config, { accounting = false, logo = null } = {}) {
  const pages = [];
  const right = A4.width - MARGIN;
  const columns = accounting
    ? [{ key: 'particulars', label: 'Particulars', width: 178 }, { key: 'category', label: 'Accounting Category', width: 110 },
      { key: 'quantity', label: 'Qty.', width: 42, align: 'right' }, { key: 'unit', label: 'Unit Amount', width: 85, align: 'right' },
      { key: 'amount', label: 'Amount', width: 100, align: 'right' }]
    : [{ key: 'particulars', label: 'Particulars', width: 288 },
      { key: 'quantity', label: 'Qty.', width: 42, align: 'right' }, { key: 'unit', label: 'Unit Amount', width: 85, align: 'right' },
      { key: 'amount', label: 'Amount', width: 100, align: 'right' }];

  let page, y;
  // The letterhead is light so the company logo sits on its own white ground, with the
  // document type and reference number balanced on the right.
  const headerHeight = logo ? Math.max(76, LOGO_WIDTH * (logo.height / logo.width) + 30) : 70;
  const startPage = () => {
    page = new Page(); pages.push(page);
    const top = A4.height - headerHeight;
    if (logo) page.image('Logo', MARGIN, top + 16, LOGO_WIDTH, LOGO_WIDTH * (logo.height / logo.width));
    else page.text(MARGIN, top + 34, config.companyName, { size: 15, bold: true, color: BRAND });
    page.text(right, A4.height - 34, request.kindLabel.toUpperCase(), { size: 11, bold: true, align: 'right', color: { r: 0.15, g: 0.15, b: 0.15 } });
    page.text(right, A4.height - 50, request.number, { size: 15, bold: true, align: 'right', color: BRAND });
    page.text(right, A4.height - 64, `Date: ${request.dateRequested}`, { size: 8.5, align: 'right', color: { r: 0.42, g: 0.42, b: 0.42 } });
    if (accounting) page.text(right, A4.height - 78, 'ACCOUNTING / INTERNAL COPY', { size: 7.5, bold: true, align: 'right', color: BRAND });
    page.rect(MARGIN, top + 6, right - MARGIN, 3, BRAND);
    page.rect(MARGIN, top + 2, (right - MARGIN) * 0.45, 2, STEEL);
    y = top - 22;
    if (request.cancelled) {
      page.rect(MARGIN, y - 6, right - MARGIN, 24, { r: 0.99, g: 0.92, b: 0.92 });
      page.text(MARGIN + 10, y + 2, `CANCELLED - ${request.cancelReason}`, { size: 10, bold: true, color: BRAND });
      y -= 40;
    }
  };
  // Returns true when the content had to start a new page, so callers can repeat headings.
  const room = needed => { if (y - needed >= 120) return false; startPage(); return true; };

  startPage();

  // Request information
  // Deliberately no approver here: the approver's name belongs in the authorization
  // section at the foot of the form, and nowhere else on it.
  const facts = [
    ['Requested By', request.requestedBy],
    ['Payee', request.payee || request.requestedBy],
    ['Status', request.statusLabel],
    ['Prepared By (Maker)', request.maker.name],
  ];
  page.text(MARGIN, y, 'REQUEST INFORMATION', { size: 8, bold: true, color: { r: 0.42, g: 0.42, b: 0.42 } });
  y -= 16;
  for (let i = 0; i < facts.length; i += 2) {
    for (const [offset, [label, value]] of [[0, facts[i]], [1, facts[i + 1]]].filter(([, pair]) => pair)) {
      const x = MARGIN + offset * 258;
      page.text(x, y, label, { size: 7.5, color: { r: 0.45, g: 0.45, b: 0.45 } });
      page.text(x, y - 12, wrap(value, 9.5, 240, true)[0], { size: 9.5, bold: true });
    }
    y -= 30;
  }
  if (request.purpose) {
    page.text(MARGIN, y, 'PURPOSE / REMARKS', { size: 7.5, color: { r: 0.45, g: 0.45, b: 0.45 } });
    y -= 12;
    for (const line of wrap(request.purpose, 9.5, right - MARGIN, false).slice(0, 4)) { page.text(MARGIN, y, line, { size: 9.5 }); y -= 12; }
  }
  y -= 12;

  // Expense table
  const drawHead = () => {
    page.rect(MARGIN, y - 4, right - MARGIN, 20, { r: 0.96, g: 0.96, b: 0.96 });
    let x = MARGIN + 8;
    for (const column of columns) {
      page.text(column.align === 'right' ? x + column.width - 16 : x, y + 2, column.label.toUpperCase(), { size: 7.5, bold: true, align: column.align === 'right' ? 'right' : 'left', color: { r: 0.35, g: 0.35, b: 0.35 } });
      x += column.width;
    }
    y -= 22;
  };
  drawHead();
  for (const line of request.lines) {
    const values = {
      particulars: line.particulars, category: `${line.categoryName}`,
      quantity: qty(line.quantity), unit: peso(line.unitAmount), amount: peso(line.amount),
    };
    const wrapped = columns.map(column => wrap(values[column.key], 9, column.width - 16, false).slice(0, 3));
    const height = Math.max(...wrapped.map(lines => lines.length)) * 11 + 8;
    if (room(height + 40)) drawHead();
    let x = MARGIN + 8;
    columns.forEach((column, index) => {
      wrapped[index].forEach((text, row) => {
        page.text(column.align === 'right' ? x + column.width - 16 : x, y - row * 11, text, { size: 9, align: column.align === 'right' ? 'right' : 'left' });
      });
      x += column.width;
    });
    y -= height;
    // The rule sits in the gap: below the previous row's descender, above the next row's cap.
    page.line(MARGIN, y + 11, right, y + 11);
  }

  room(70);
  page.rect(right - 240, y - 22, 240, 28, { r: 0.95, g: 0.96, b: 0.97 });
  page.rect(right - 240, y - 22, 3, 28, BRAND);
  page.text(right - 230, y - 12, 'TOTAL AMOUNT', { size: 9, bold: true });
  page.text(right - 12, y - 13, peso(request.total), { size: 13, bold: true, align: 'right', color: BRAND });
  y -= 46;

  if (request.payment) {
    room(96);
    const p = request.payment;
    page.text(MARGIN, y, 'PAYMENT / CHECK DETAILS', { size: 8, bold: true, color: { r: 0.42, g: 0.42, b: 0.42 } });
    y -= 16;
    const details = [['Payment Method', p.method], ['Bank', p.bank || '-'], ['Check No.', p.checkNumber || '-'], ['Check Date', p.checkDate || '-'],
      ['Check Amount', peso(p.amount)], ['Date Prepared', p.datePrepared], ['Date Released', p.dateReleased || 'Not yet released'], ['Received By', p.receivedBy || '-']];
    for (let i = 0; i < details.length; i += 4) {
      details.slice(i, i + 4).forEach(([label, value], offset) => {
        const x = MARGIN + offset * 129;
        page.text(x, y, label, { size: 7.5, color: { r: 0.45, g: 0.45, b: 0.45 } });
        page.text(x, y - 11, wrap(value, 9, 120, true)[0], { size: 9, bold: true });
      });
      y -= 28;
    }
    y -= 6;
  }

  // Signature blocks. The final approver's name is printed from the selected approver.
  room(140);
  // Request -> Approval -> Release, read left to right, each signed by hand.
  const releasedBy = request.payment?.releasedBy || (request.ledger || []).find(entry => entry.type === 'disbursement')?.actor || '';
  const blocks = [
    ['Requested By', request.requestedBy],
    ['Approved By', request.finalApprover],
    [request.kind === 'petty_cash' ? 'Disbursed By' : 'Released By', releasedBy],
  ];
  const blockWidth = (right - MARGIN) / 3;
  const baseline = y - 56; // Clear space above each rule so the document can be signed by hand.
  page.text(MARGIN, y - 4, 'AUTHORIZATION', { size: 8, bold: true, color: { r: 0.42, g: 0.42, b: 0.42 } });
  blocks.forEach(([label, name], index) => {
    const x = MARGIN + index * blockWidth;
    page.line(x + 6, baseline, x + blockWidth - 18, baseline, { r: 0.35, g: 0.35, b: 0.35 }, 0.8);
    page.text(x + 6, baseline - 13, name.toUpperCase() || '—', { size: 9, bold: true });
    page.text(x + 6, baseline - 25, label, { size: 7.5, color: { r: 0.45, g: 0.45, b: 0.45 } });
    page.text(x + 6, baseline - 36, 'Signature over printed name', { size: 6.5, color: { r: 0.62, g: 0.62, b: 0.62 } });
  });

  pages.forEach((current, index) => {
    current.line(MARGIN, 58, right, 58, STEEL, 0.8);
    current.text(MARGIN, 44, `${request.number} - ${request.kindLabel}${accounting ? ' - ACCOUNTING / INTERNAL COPY' : ''}`, { size: 7.5, color: { r: 0.45, g: 0.45, b: 0.45 } });
    current.text(right, 44, `Page ${index + 1} of ${pages.length}`, { size: 7.5, align: 'right', color: { r: 0.45, g: 0.45, b: 0.45 } });
    if (!accounting) current.text(MARGIN, 32, 'System-generated document. Accounting classifications are maintained internally.', { size: 6.5, color: { r: 0.6, g: 0.6, b: 0.6 } });
    else current.text(MARGIN, 32, 'Internal use only. Contains accounting classifications.', { size: 6.5, color: BRAND });
  });
  return serialize(pages, logo);
}
