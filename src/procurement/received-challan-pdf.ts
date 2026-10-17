import { pdfDate, pdfMoney, pdfQuantity, pdfWords, renderChallanPdf, type ChallanBlock } from '../common/challan-document-pdf';
import { lineSpecs, specsText } from '../common/item-specs';
import type { ProcurementService } from './procurement.service';

type ReceivedChallan = Awaited<ReturnType<ProcurementService['receipt']>>;

/** "286.050 kg · 12.000 PCS" for lines in mixed units. */
function unitTotals(lines: Array<{ unit: string; value: number }>) {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.unit, (totals.get(line.unit) ?? 0) + line.value);
  return [...totals.entries()].map(([unit, q]) => pdfQuantity(q, unit)).join('   ·   ');
}

/** A goods receipt's received challan as a PDF, the same as the office copy: rates and values only for admins. */
export function receivedChallanPdf(challan: ReceivedChallan): Promise<Buffer> {
  const c = challan.company;
  const timezone = c.timezone || 'Asia/Kolkata';
  const s = challan.supplier;
  const prices = challan.pricesShown;
  const po = challan.purchaseOrder;
  const from: ChallanBlock = { label: 'Received from', lines: [[s.name, true]] };
  const who = [s.code, s.company, s.contactPerson, s.mobile].filter(Boolean).join(' · ');
  if (who) from.lines.push([who]);
  if (s.address) from.lines.push([s.address]);
  if (s.gst) from.lines.push([`GSTIN ${s.gst}`]);
  const w = challan.warehouse;
  const into: ChallanBlock = { label: 'Received into', lines: [[`${w.code} · ${w.name}`, true]] };
  if (w.location) into.lines.push([w.location]);
  into.lines.push([`Vehicle ${challan.vehicleNo || '—'}`]);
  if (challan.receivedBy) into.lines.push([`Received by ${challan.receivedBy}`]);

  const totals: Array<[string, string]> = [
    [
      `Total received · ${challan.lines.length} line${challan.lines.length === 1 ? '' : 's'}`,
      unitTotals(challan.lines.map((l) => ({ unit: l.unit, value: l.quantity }))),
    ],
  ];
  const balance = challan.lines.filter((l) => l.balance > 0.0005);
  if (balance.length) totals.push(['Still to come on the PO', unitTotals(balance.map((l) => ({ unit: l.unit, value: l.balance })))]);
  if (prices) totals.push(['Value received', pdfMoney(challan.total ?? 0)]);

  return renderChallanPdf({
    title: 'Material Received Challan',
    number: challan.receiptNo,
    date: challan.receivedAt,
    company: c,
    blocks: [from, into],
    references: [
      { label: 'Purchase order', value: po.poNo },
      { label: 'PO date', value: pdfDate(po.orderDate, timezone) },
      ...(challan.challanNo ? [{ label: 'Their challan / invoice', value: challan.challanNo }] : []),
      ...(challan.lotNo ? [{ label: 'Lot', value: challan.lotNo }] : []),
      { label: 'PO status now', value: pdfWords(po.status) },
    ],
    columns: [
      { label: '#', weight: 3 },
      { label: 'Item', weight: prices ? 19 : 26 },
      { label: 'Code', weight: prices ? 15 : 17 },
      { label: 'Ordered', weight: 11, align: 'right' },
      { label: 'Earlier', weight: 10, align: 'right' },
      { label: 'Received now', weight: 11, align: 'right' },
      { label: 'Balance', weight: 10, align: 'right' },
      ...(prices
        ? [
            { label: 'Rate', weight: 9, align: 'right' as const },
            { label: 'Amount', weight: 12, align: 'right' as const },
          ]
        : []),
    ],
    rows: challan.lines.map((line, index) => ({
      cells: [
        String(index + 1),
        line.itemName,
        line.itemCode ?? '—',
        pdfQuantity(line.ordered, line.unit, true),
        pdfQuantity(line.receivedBefore, line.unit, true),
        pdfQuantity(line.quantity, line.unit, true),
        line.balance > 0.0005 ? pdfQuantity(line.balance, line.unit, true) : 'Complete',
        ...(prices ? [pdfMoney(line.rate ?? 0), pdfMoney(line.amount ?? 0)] : []),
      ],
      // Full details under the item (the lot is printed with the references above).
      sub: [pdfWords(line.category), specsText(lineSpecs(line.specs, line.itemCode ?? ''))].filter(Boolean).join('\n'),
    })),
    totals,
    notes: challan.notes,
    issued: `Received ${pdfDate(challan.receivedAt, timezone, true)}${challan.receivedBy ? ` by ${challan.receivedBy}` : ''} against ${po.poNo} · computer-generated challan`,
    signatures: [
      'Delivered by (driver)',
      'Received by (godown)',
      `For ${c.legalName || c.name || 'SS Clothing Mills'}\nChecked by (office)`,
    ],
  });
}
