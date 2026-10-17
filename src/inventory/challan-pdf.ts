import { pdfDate, pdfMoney, pdfQuantity, pdfWords, renderChallanPdf, type ChallanBlock } from '../common/challan-document-pdf';
import { lineSpecs, specsText } from '../common/item-specs';
import type { Challan } from './stock-bills.service';

const TITLE = { RECEIVED: 'Material Received Challan', EXPORT: 'Material Export Challan' } as const;

/** A warehouse's received / export challan as a PDF, to share or print. */
export function challanPdf(challan: Challan): Promise<Buffer> {
  const c = challan.company;
  const timezone = c.timezone || 'Asia/Kolkata';
  const received = challan.kind === 'RECEIVED';
  const s = challan.source;
  const party: ChallanBlock = { label: received ? 'Received from' : 'Sent to', lines: [[challan.partyName || '—', true]] };
  if (s.partyAddress) party.lines.push([s.partyAddress]);
  if (s.partyGst) party.lines.push([`GSTIN ${s.partyGst}`]);
  if (s.partyPhone) party.lines.push([`Phone ${s.partyPhone}`]);
  party.lines.push([s.label]);
  const w = challan.warehouse;
  const site: ChallanBlock = { label: received ? 'Received into' : 'Sent from', lines: [[`${w.code} · ${w.name}`, true]] };
  if (w.location) site.lines.push([w.location]);
  site.lines.push([`Vehicle ${challan.vehicleNo || '—'}${s.transporter ? `  ·  ${s.transporter}` : ''}`]);
  if (s.driverName) site.lines.push([`Driver ${s.driverName}`]);
  if (s.lrNo) site.lines.push([`LR no ${s.lrNo}`]);

  // Rates and values only when shown to this user (admins) and the source has them.
  const priced = challan.value !== null;
  const totals = new Map<string, number>();
  for (const line of challan.lines) totals.set(line.unit, (totals.get(line.unit) ?? 0) + line.quantity);
  return renderChallanPdf({
    title: TITLE[challan.kind],
    number: challan.billNo,
    date: challan.createdAt,
    company: c,
    cancelled: !!challan.cancelledAt,
    blocks: [party, site],
    references: s.references,
    columns: [
      { label: '#', weight: 4 },
      { label: 'Item', weight: priced ? 32 : 40 },
      { label: 'Code / lot', weight: priced ? 17 : 20 },
      { label: 'Material', weight: priced ? 11 : 14 },
      { label: 'Quantity', weight: priced ? 14 : 22, align: 'right' },
      ...(priced
        ? [
            { label: 'Rate', weight: 10, align: 'right' as const },
            { label: 'Value', weight: 14, align: 'right' as const },
          ]
        : []),
    ],
    rows: challan.lines.map((line, index) => ({
      cells: [
        String(index + 1),
        line.itemName,
        `${line.itemCode}${line.lotNo ? `\nLot ${line.lotNo}` : ''}`,
        pdfWords(line.category),
        pdfQuantity(line.quantity, line.unit, priced),
        ...(priced ? [line.rate === null ? '—' : pdfMoney(line.rate), line.amount === null ? '—' : pdfMoney(line.amount)] : []),
      ],
      // The item's full details under its name: fabric type, dia, GSM, GG, LL, colour, rolls… (the lot has its own cell).
      sub: [`${pdfWords(line.txnType)} · ${pdfDate(line.createdAt, timezone, true)}`, specsText(lineSpecs(line.specs, line.itemCode))]
        .filter(Boolean)
        .join('\n'),
    })),
    totals: [
      ...(totals.size
        ? [
            [
              `Total · ${challan.lines.length} line${challan.lines.length === 1 ? '' : 's'}`,
              [...totals.entries()].map(([unit, q]) => pdfQuantity(q, unit)).join('   ·   '),
            ] as [string, string],
          ]
        : []),
      ...(priced ? [['Value', pdfMoney(challan.value ?? 0)] as [string, string]] : []),
    ],
    notes: challan.notes,
    issued: `Issued ${pdfDate(challan.createdAt, timezone, true)}${challan.createdBy ? ` by ${challan.createdBy}` : ''} · computer-generated challan`,
    signatures: [
      received ? 'Delivered by' : 'Received by',
      'Checked by',
      `For ${c.legalName || c.name || 'SS Clothing Mills'}\nWarehouse in-charge`,
    ],
  });
}
