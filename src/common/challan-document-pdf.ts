import PDFDocument from 'pdfkit';

const INK = '#1b3c55';
const GOLD = '#a77a24';
const MUTED = '#64748b';
const LINE = '#d7dee6';

/** A challan to draw: delivery (sale), received (goods receipt) or a warehouse received / export challan. */
export type ChallanDocument = {
  /** e.g. "DELIVERY CHALLAN". */
  title: string;
  number: string;
  date: Date | string;
  company: Record<string, string | undefined>;
  cancelled?: boolean;
  /** The two boxes under the letterhead: who it is from / to, and the warehouse / transport. */
  blocks: [ChallanBlock, ChallanBlock];
  /** Documents it refers to, e.g. "Sale bill: SAL-2026-000017". */
  references: Array<{ label: string; value: string }>;
  /** Column 1 is the item (bold, with the row's `sub` under it); `weight` shares out the page width. */
  columns: Array<{ label: string; weight: number; align?: 'left' | 'right' }>;
  rows: Array<{ cells: string[]; sub?: string }>;
  /** Total lines under the table, e.g. [["Total · 3 lines", "286.050 kg"], ["Bill value", "Rs 12,000.00"]]. */
  totals?: Array<[string, string]>;
  notes?: string | null;
  /** "Issued 16-Oct-2026 by Admin · computer-generated challan". */
  issued: string;
  signatures: string[];
};
export type ChallanBlock = { label: string; lines: Array<[string, boolean?]> };

/** Date (and time) in the company's time zone. */
export function pdfDate(value: Date | string, timezone = 'Asia/Kolkata', withTime = false) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(value));
}

/**
 * "200.300 kg (200 kg 300 g)" for weights, "500 g" for grams, "40.000 CONE" otherwise. `compact` drops the trailing
 * zeros and the kg / g reading ("1,000 kg", "250.5 kg") for tables with many columns.
 */
export function pdfQuantity(value: number, unit: string, compact = false) {
  const u = unit.trim().toUpperCase();
  const fixed = value.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  if (u === 'G') return `${Math.round(value).toLocaleString('en-IN')} g`;
  if (compact) return `${value.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${u === 'KG' ? 'kg' : unit}`;
  if (u !== 'KG') return `${fixed} ${unit}`;
  const grams = Math.round(value * 1000);
  const kg = Math.floor(Math.abs(grams) / 1000);
  const g = Math.abs(grams) % 1000;
  return `${fixed} kg${g && kg ? ` (${kg} kg ${g} g)` : ''}`;
}

/** Money for the PDF; the core fonts have no rupee sign. */
export const pdfMoney = (value: number) => `Rs ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const pdfWords = (value: string) =>
  value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/**
 * Draws a challan as an A4 PDF for sharing (WhatsApp, email) and printing: letterhead, title, number, date and time,
 * the from / to boxes, the documents it refers to, the lines (the table header repeats on every page), the total,
 * notes, who issued it and signatures. A cancelled one says so across every page.
 */
export function renderChallanPdf(challan: ChallanDocument): Promise<Buffer> {
  const c = challan.company;
  const timezone = c.timezone || 'Asia/Kolkata';
  const company = c.name || 'SS Clothing Mills';
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    bufferPages: true,
    info: { Title: `${challan.number} ${challan.title}`, Author: company },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const right = left + width;

  // Letterhead
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text(company, left, 40, { width: width * 0.6 });
  const place = [c.address, c.city, [c.state, c.pincode].filter(Boolean).join(' - ')].filter(Boolean).join(', ');
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  if (place) doc.text(place, { width: width * 0.6 });
  const contact = [c.phone, c.email].filter(Boolean).join('  ·  ');
  if (contact) doc.text(contact, { width: width * 0.6 });
  if (c.gst)
    doc
      .font('Helvetica-Bold')
      .fillColor('#334155')
      .text(`GSTIN ${c.gst}`, { width: width * 0.6 });
  const headBottom = doc.y;

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(GOLD)
    .text(challan.title.toUpperCase(), left + width * 0.5, 40, { width: width * 0.5, align: 'right' });
  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(INK)
    .text(challan.number, { width: width * 0.5, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(`Date ${pdfDate(challan.date, timezone)}`, { width: width * 0.5, align: 'right' });
  doc.text(
    `Time ${new Intl.DateTimeFormat('en-IN', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(challan.date))}`,
    {
      width: width * 0.5,
      align: 'right',
    },
  );

  let y = Math.max(headBottom, doc.y) + 10;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1.5).strokeColor(INK).stroke();
  y += 10;

  // The two boxes
  const boxW = (width - 12) / 2;
  const box = (x: number, block: ChallanBlock) => {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(GOLD)
      .text(block.label.toUpperCase(), x + 10, y + 8, { width: boxW - 20, characterSpacing: 0.6 });
    for (const [text, bold] of block.lines)
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 10.5 : 8.5)
        .fillColor(bold ? '#0f172a' : '#334155')
        .text(text, { width: boxW - 20 });
    return doc.y + 8;
  };
  const leftEnd = box(left, challan.blocks[0]);
  const rightEnd = box(left + boxW + 12, challan.blocks[1]);
  const boxH = Math.max(leftEnd, rightEnd) - y;
  doc.roundedRect(left, y, boxW, boxH, 6).lineWidth(0.8).strokeColor(LINE).stroke();
  doc
    .roundedRect(left + boxW + 12, y, boxW, boxH, 6)
    .lineWidth(0.8)
    .strokeColor(LINE)
    .stroke();
  y += boxH + 10;

  if (challan.references.length) {
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#334155')
      .text(challan.references.map((r) => `${r.label}: ${r.value}`).join('     '), left, y, { width });
    y = doc.y + 8;
  }

  // Lines
  const weights = challan.columns.reduce((sum, col) => sum + col.weight, 0);
  const cols = challan.columns.map((col) => ({ ...col, w: (col.weight / weights) * width }));
  // Many columns: a smaller font, so figures stay on one line.
  const size = cols.length > 7 ? 7.5 : 8.5;
  doc.font('Helvetica-Bold').fontSize(size - 0.5);
  const headerH = Math.max(...cols.map((col) => doc.heightOfString(col.label, { width: col.w - 10 }))) + 12;
  const header = () => {
    doc.rect(left, y, width, headerH).fill(INK);
    let x = left;
    doc
      .font('Helvetica-Bold')
      .fontSize(size - 0.5)
      .fillColor('#ffffff');
    for (const col of cols) {
      doc.text(col.label, x + 5, y + 6, { width: col.w - 10, align: col.align ?? 'left' });
      x += col.w;
    }
    y += headerH;
  };
  header();
  const bottom = doc.page.height - doc.page.margins.bottom - 110;
  challan.rows.forEach((row, index) => {
    doc.font('Helvetica').fontSize(size);
    const heights = row.cells.map((cell, i) => doc.heightOfString(cell, { width: cols[i].w - 10 }));
    if (row.sub) heights[1] = (heights[1] ?? 0) + doc.fontSize(7).heightOfString(row.sub, { width: cols[1].w - 10 }) + 2;
    const rowH = Math.max(...heights) + 10;
    if (y + rowH > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      header();
    }
    if (index % 2 === 1) doc.rect(left, y, width, rowH).fill('#f8fafc');
    let x = left;
    row.cells.forEach((cell, i) => {
      doc
        .font(i === 1 ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(size)
        .fillColor('#0f172a')
        .text(cell, x + 5, y + 5, { width: cols[i].w - 10, align: cols[i].align ?? 'left' });
      if (i === 1 && row.sub)
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(MUTED)
          .text(row.sub, x + 5, doc.y + 1, { width: cols[i].w - 10 });
      x += cols[i].w;
    });
    y += rowH;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(LINE).stroke();
  });
  if (!challan.rows.length) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text('No lines.', left, y + 8, { width, align: 'center' });
    y = doc.y + 8;
  }

  for (const [label, value] of challan.totals ?? []) {
    if (y + 24 > bottom + 60) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.rect(left, y, width, 22).fill('#eef3f7');
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(label, left + 8, y + 7, { width: width / 2 });
    doc.text(value, left + width / 2, y + 7, { width: width / 2 - 8, align: 'right' });
    y += 24;
  }
  if (challan.totals?.length) y += 6;

  if (challan.notes) {
    doc.font('Helvetica').fontSize(8).fillColor('#334155').text(`Notes: ${challan.notes}`, left, y, { width });
    y = doc.y + 4;
  }
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(challan.issued, left, y, { width });

  // Signatures at the foot of the last page
  const signY = doc.page.height - doc.page.margins.bottom - 60;
  const gap = 20;
  const signW = (width - gap * (challan.signatures.length - 1)) / challan.signatures.length;
  challan.signatures.forEach((label, i) => {
    const x = left + i * (signW + gap);
    doc
      .moveTo(x, signY + 28)
      .lineTo(x + signW, signY + 28)
      .lineWidth(0.8)
      .strokeColor('#94a3b8')
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#334155')
      .text(label, x, signY + 32, { width: signW, align: 'center' });
  });

  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    if (challan.cancelled) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc
        .font('Helvetica-Bold')
        .fontSize(64)
        .fillColor('#dc2626')
        .opacity(0.12)
        .text('CANCELLED', 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center' });
      doc.restore();
      doc.opacity(1);
    }
    // The footer sits in the bottom margin; without lifting it PDFKit would start a new page for it.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(MUTED)
      .text(`${challan.number} · page ${i - pages.start + 1} of ${pages.count}`, left, doc.page.height - 28, {
        width,
        align: 'right',
        lineBreak: false,
      });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}
