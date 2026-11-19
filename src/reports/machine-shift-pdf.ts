import { ReportResult } from './report-types';

/** Shift activity can contain several jobs. Preserve it in full instead of shortening it to one table line. */
export async function machineShiftPdf(report: ReportResult) {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true, info: { Title: report.title, Author: report.company.name } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const width = doc.page.width - 72;
  const words = (v: string | number | null | undefined) =>
    String(v ?? '—')
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
  const number = (v: unknown) =>
    v === null || v === undefined ? 'Not entered' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
  const room = (height: number) => {
    if (doc.y + height > doc.page.height - 56) doc.addPage();
  };
  doc.font('Helvetica-Bold').fontSize(17).fillColor('#183b32').text(report.company.name);
  if (report.company.address) doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(report.company.address);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(14).fillColor('#183b32').text(report.title);
  doc
    .font('Helvetica')
    .fontSize(10)
    .text(`Production day: ${report.from?.slice(0, 10) ?? ''} | Day 9 AM - 9 PM IST; Night 9 PM - 9 AM next day`);
  doc
    .fontSize(8)
    .fillColor('#64748b')
    .text(`Generated ${new Date(report.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  doc.moveDown();
  for (const item of report.summary) {
    room(18);
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#284c38')
      .text(`${item.label}: ${item.value}${item.type === 'kg' ? ' kg' : ''}${item.hint ? ` (${item.hint})` : ''}`, { width });
  }
  doc.moveDown();
  if (!report.rows.length) doc.font('Helvetica').fontSize(10).text('No machines for this selection.');
  for (const row of report.rows) {
    room(150);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#183b32').text(String(row.machine));
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#334155')
      .text(`Snapshot: ${words(row.status)} | Machine condition now: ${words(row.currentCondition)}`);
    doc.text(
      `Production: ${row.productionEntry} | Fabric: ${number(row.fabricKg)} kg | Yarn: ${number(row.yarnKg)} kg | Rolls: ${number(row.rolls)}`,
    );
    doc.text(`Knitting charges: ${row.charges === null ? 'Not entered' : `Rs ${number(row.charges)}`}`);
    for (const [title, status, activity] of [
      ['Day shift: 9 AM - 9 PM', row.dayStatus, row.dayWork],
      ['Night shift: 9 PM - 9 AM next day', row.nightStatus, row.nightWork],
    ]) {
      room(70);
      doc
        .moveDown(0.5)
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#236b59')
        .text(`${title} | ${words(status)}`);
      doc.font('Helvetica').fontSize(9).fillColor('#334155').text(String(activity), { width, lineGap: 2 });
    }
    for (const [title, value] of [
      ['Starts this day', row.started],
      ['Stops this day', row.stopped],
    ]) {
      room(40);
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(9).text(`${title}:`);
      doc.font('Helvetica').text(String(value), { width, lineGap: 2 });
    }
    doc.moveDown();
    if (doc.y < doc.page.height - 60)
      doc
        .moveTo(36, doc.y)
        .lineTo(36 + width, doc.y)
        .strokeColor('#dce8e0')
        .stroke();
    doc.moveDown();
  }
  if (report.note) {
    room(80);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b').text(report.note, { width, lineGap: 2 });
  }
  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#94a3b8')
      .text(`${report.company.name} | ${report.from?.slice(0, 10)} | Page ${i + 1} of ${pages.count}`, 36, doc.page.height - 28, {
        width,
        lineBreak: false,
      });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
