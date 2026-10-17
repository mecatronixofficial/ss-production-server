import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { ColumnType, ReportColumn, ReportResult } from './report-types';

const INK = '#1b3c55';
const GOLD = '#a77a24';

type CellValue = string | number | null | undefined;

const words = (value: string) =>
  value
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/** Date only, in the company's time zone. */
function dateText(isoValue: string, timezone: string) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric' }).format(
    new Date(isoValue),
  );
}

/** Human description of the selected period; `to` is exclusive. */
export function periodText(report: Pick<ReportResult, 'from' | 'to' | 'dateLabel' | 'company'>) {
  const tz = report.company.timezone;
  if (report.dateLabel === null) return `As of ${dateText(new Date().toISOString(), tz)}`;
  const from = report.from ? dateText(report.from, tz) : null;
  const to = report.to ? dateText(new Date(new Date(report.to).getTime() - 1).toISOString(), tz) : null;
  const span = from && to ? `${from} – ${to}` : from ? `From ${from}` : to ? `Up to ${to}` : 'All dates';
  return `${report.dateLabel}: ${span}`;
}

/**
 * Plain-text value for PDF output. PDF core fonts have no ₹ glyph, hence "Rs"; table cells leave it out
 * (the page header says "Amounts in Rs") so large amounts fit their column.
 */
function text(value: CellValue, type: ColumnType, timezone: string, currency = true) {
  if (value === null || value === undefined || value === '') return type === 'text' || type === 'status' || type === 'date' ? '—' : '0';
  const n = Number(value);
  switch (type) {
    case 'date':
      return dateText(String(value), timezone);
    case 'status':
      return words(String(value));
    case 'money':
      return `${currency ? 'Rs ' : ''}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'kg':
      return `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg`;
    case 'qty':
      return n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
    case 'pct':
      return `${n.toFixed(1)}%`;
    case 'number':
      return n.toLocaleString('en-IN', { maximumFractionDigits: 1 });
    default:
      return String(value);
  }
}

const numeric = (type: ColumnType) => ['kg', 'qty', 'money', 'number', 'pct'].includes(type);

// ───────────────────────────── Excel ─────────────────────────────

const EXCEL_FORMAT: Partial<Record<ColumnType, string>> = {
  money: '#,##0.00',
  kg: '#,##0.000',
  qty: '#,##0.000',
  pct: '0.0%',
  date: 'dd-mmm-yyyy',
};
const EXCEL_WIDTH: Record<ColumnType, number> = { text: 22, status: 16, date: 13, money: 16, kg: 14, qty: 13, number: 11, pct: 10 };

/** Excel dates have no time zone; store the company-local calendar date. */
function excelDate(isoValue: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    new Date(isoValue),
  );
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

function excelValue(value: CellValue, column: ReportColumn, timezone: string) {
  if (value === null || value === undefined || value === '') return null;
  if (column.type === 'date') return excelDate(String(value), timezone);
  if (column.type === 'status') return words(String(value));
  if (column.type === 'pct') return Number(value) / 100;
  return numeric(column.type) ? Number(value) : String(value);
}

export async function toExcel(report: ReportResult) {
  const tz = report.company.timezone;
  const wb = new ExcelJS.Workbook();
  wb.creator = report.company.name;
  wb.created = new Date(report.generatedAt);
  const ws = wb.addWorksheet(report.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 6 }] });

  ws.addRow([report.company.name]).font = { bold: true, size: 14, color: { argb: 'FF1B3C55' } };
  ws.addRow([report.title]).font = { bold: true, size: 12 };
  ws.addRow([periodText(report)]).font = { color: { argb: 'FF64748B' } };
  ws.addRow([
    `Generated ${new Date(report.generatedAt).toLocaleString('en-IN', { timeZone: tz })}${report.truncated ? ' · first rows only' : ''}`,
  ]).font = {
    color: { argb: 'FF64748B' },
    size: 9,
  };
  ws.addRow([]);

  const header = ws.addRow(report.columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3C55' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  header.height = 30;

  for (const row of report.rows) ws.addRow(report.columns.map((c) => excelValue(row[c.key], c, tz)));

  if (report.columns.some((c) => c.total)) {
    const totals = ws.addRow(
      report.columns.map((c, i) => (i === 0 ? 'Total' : c.total ? excelValue(report.totals[c.key] ?? 0, c, tz) : null)),
    );
    totals.font = { bold: true };
    totals.eachCell((cell) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FF1B3C55' } } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    });
  }
  if (report.note) {
    ws.addRow([]);
    ws.addRow([report.note]).font = { italic: true, color: { argb: 'FF64748B' }, size: 9 };
  }

  report.columns.forEach((c, i) => {
    const column = ws.getColumn(i + 1);
    column.width = EXCEL_WIDTH[c.type];
    if (EXCEL_FORMAT[c.type]) column.numFmt = EXCEL_FORMAT[c.type]!;
  });
  ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: report.columns.length } };

  const summary = wb.addWorksheet('Summary');
  summary.addRow([report.title]).font = { bold: true, size: 12 };
  summary.addRow([periodText(report)]).font = { color: { argb: 'FF64748B' } };
  summary.addRow([]);
  for (const item of report.summary) {
    const row = summary.addRow([
      item.label,
      typeof item.value === 'number' && item.type === 'pct' ? item.value / 100 : item.value,
      item.hint ?? '',
    ]);
    if (EXCEL_FORMAT[item.type]) row.getCell(2).numFmt = EXCEL_FORMAT[item.type]!;
    row.getCell(1).font = { bold: true };
  }
  summary.getColumn(1).width = 30;
  summary.getColumn(2).width = 20;
  summary.getColumn(3).width = 36;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────────────────────── PDF ─────────────────────────────

/** Longest a single column may grow before its text is cut with an ellipsis. */
const PDF_MAX_COLUMN = 170;
const PDF_CELL_PADDING = 8;

export function toPdf(report: ReportResult) {
  const tz = report.company.timezone;
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 32,
    bufferPages: true,
    info: { Title: report.title, Author: report.company.name },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const fontSize = report.columns.length > 11 ? 6.8 : report.columns.length > 8 ? 7.5 : 8.5;
  const rowHeight = fontSize + 8;
  // Size columns from their content: numbers and dates keep the width they need and only
  // text columns shrink (with an ellipsis) when the page is too narrow for everything.
  const cells = report.rows.map((row) => report.columns.map((c) => text(row[c.key], c.type, tz, false)));
  const totalCells = report.columns.map((c, i) => (i === 0 ? 'Total' : c.total ? text(report.totals[c.key] ?? 0, c.type, tz, false) : ''));
  const measure = (value: string, bold = false) =>
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(fontSize)
      .widthOfString(value);
  const desired = report.columns.map((c, i) => {
    const longestWord = Math.max(...c.label.split(/\s+/).map((word) => measure(word, true)));
    const content = Math.max(measure(totalCells[i], true), ...cells.slice(0, 300).map((row) => measure(row[i])));
    return Math.min(PDF_MAX_COLUMN, Math.max(longestWord, content, 24) + PDF_CELL_PADDING);
  });
  const needed = desired.reduce((sum, w) => sum + w, 0);
  const flexible = report.columns.map((c) => c.type === 'text' || c.type === 'status');
  let widths: number[];
  if (needed <= width) {
    widths = desired.map((w) => w + ((width - needed) * w) / needed);
  } else {
    const fixed = desired.reduce((sum, w, i) => sum + (flexible[i] ? 0 : w), 0);
    const flexNeeded = needed - fixed;
    const room = Math.max(width - fixed, width * 0.25);
    widths = desired.map((w, i) => (flexible[i] ? (w / flexNeeded) * room : w));
    const scale = width / widths.reduce((sum, w) => sum + w, 0);
    widths = widths.map((w) => w * scale);
  }

  /** Single line, cut with an ellipsis to fit the cell. */
  const fit = (value: string, cellWidth: number) => {
    let out = value;
    if (doc.widthOfString(out) <= cellWidth) return out;
    while (out.length > 1 && doc.widthOfString(`${out}…`) > cellWidth) out = out.slice(0, -1);
    return `${out}…`;
  };
  const drawRow = (values: string[], y: number, opts: { header?: boolean; bold?: boolean; fill?: string }) => {
    if (opts.fill) doc.rect(left, y, width, rowHeight).fill(opts.fill);
    doc
      .font(opts.header || opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(fontSize)
      .fillColor(opts.header ? '#ffffff' : '#1f2937');
    let x = left;
    values.forEach((value, i) => {
      const cellWidth = widths[i] - 6;
      const align = !opts.header && numeric(report.columns[i].type) ? 'right' : 'left';
      // A little slack so text that measures as fitting isn't wrapped by rounding.
      doc.text(fit(value, cellWidth - 2), x + 3, y + 4, { width: cellWidth, align, lineBreak: false });
      x += widths[i];
    });
  };
  // Column headings may wrap onto two lines instead of being cut short.
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const headerHeight = Math.max(
    rowHeight,
    ...report.columns.map((c, i) => Math.min(doc.heightOfString(c.label, { width: widths[i] - 6 }), fontSize * 2.6) + 8),
  );
  const drawHeader = (y: number) => {
    doc.rect(left, y, width, headerHeight).fill(INK);
    doc.font('Helvetica-Bold').fontSize(fontSize).fillColor('#ffffff');
    let x = left;
    report.columns.forEach((c, i) => {
      const cellWidth = widths[i] - 6;
      doc.text(c.label, x + 3, y + 4, {
        width: cellWidth,
        height: headerHeight - 6,
        ellipsis: true,
        align: numeric(c.type) ? 'right' : 'left',
      });
      x += widths[i];
    });
    return y + headerHeight;
  };

  // Letterhead
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(report.company.name, left, doc.y);
  const sub = [report.company.gst ? `GSTIN ${report.company.gst}` : '', report.company.address ?? ''].filter(Boolean).join('  ·  ');
  if (sub) doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(sub);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111827').text(report.title);
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#64748b')
    .text(
      `${periodText(report)}${report.columns.some((c) => c.type === 'money') ? '   ·   Amounts in Rs' : ''}   ·   Generated ${new Date(report.generatedAt).toLocaleString('en-IN', { timeZone: tz })}${report.truncated ? '   ·   first rows only' : ''}`,
    );
  doc.moveDown(0.6);

  // Summary tiles
  if (report.summary.length) {
    const tileGap = 8;
    const tileWidth = (width - tileGap * (report.summary.length - 1)) / report.summary.length;
    const top = doc.y;
    report.summary.forEach((item, i) => {
      const x = left + i * (tileWidth + tileGap);
      doc.roundedRect(x, top, tileWidth, 38, 5).fill('#f1f5f9');
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(GOLD)
        .text(item.label.toUpperCase(), x + 8, top + 6, { width: tileWidth - 16, lineBreak: false });
      doc
        .font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(INK)
        .text(typeof item.value === 'number' ? text(item.value, item.type, tz) : item.value, x + 8, top + 17, {
          width: tileWidth - 16,
          lineBreak: false,
        });
    });
    doc.y = top + 50;
  }

  let y = drawHeader(doc.y);
  if (!report.rows.length) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#64748b')
      .text('No records for the selected period.', left, y + 8);
    y += 28;
  }
  report.rows.forEach((_row, index) => {
    if (y + rowHeight > bottom) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }
    drawRow(cells[index], y, { fill: index % 2 ? '#f8fafc' : undefined });
    y += rowHeight;
  });
  if (report.rows.length && report.columns.some((c) => c.total)) {
    if (y + rowHeight > bottom) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }
    doc
      .moveTo(left, y)
      .lineTo(left + width, y)
      .lineWidth(0.8)
      .strokeColor(INK)
      .stroke();
    drawRow(totalCells, y, { bold: true, fill: '#e2e8f0' });
    y += rowHeight;
  }
  if (report.note) {
    if (y + 30 > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc
      .font('Helvetica-Oblique')
      .fontSize(7.5)
      .fillColor('#64748b')
      .text(report.note, left, y + 8, { width });
  }

  // Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would make pdfkit start a new page, so lift it for the footer.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const footY = doc.page.height - margin + 8;
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#94a3b8')
      .text(`${report.company.name} · ${report.title}`, left, footY, { width: width / 2, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, left + width / 2, footY, { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}
