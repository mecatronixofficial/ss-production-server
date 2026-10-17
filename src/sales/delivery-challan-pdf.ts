import { pdfDate, pdfMoney, pdfQuantity, pdfWords, renderChallanPdf, type ChallanBlock } from '../common/challan-document-pdf';
import { lineSpecs, specsText } from '../common/item-specs';
import type { SalesService } from './sales.service';

type DeliveryChallan = Awaited<ReturnType<SalesService['deliveryChallan']>>;

const EMPTY = 0.0005;

/** "286.050 kg · 12.000 PCS" for lines in mixed units. */
function unitTotals(lines: Array<{ unit: string; value: number }>) {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.unit, (totals.get(line.unit) ?? 0) + line.value);
  return [...totals.entries()].map(([unit, q]) => pdfQuantity(q, unit)).join('   ·   ');
}

/** A dispatched sale's delivery challan as a PDF, the same as the office copy: rates and values only for admins. */
export function deliveryChallanPdf(challan: DeliveryChallan): Promise<Buffer> {
  const c = challan.company;
  const timezone = c.timezone || 'Asia/Kolkata';
  const p = challan.party;
  const prices = challan.pricesShown;
  const consignee: ChallanBlock = { label: 'Consignee (deliver to)', lines: [[p.name, true]] };
  const who = [challan.partyType === 'TEXTILE' ? 'Textile' : 'Distributor', p.code, p.phone].filter(Boolean).join(' · ');
  if (who) consignee.lines.push([who]);
  if (p.address) consignee.lines.push([p.address]);
  if (p.gst) consignee.lines.push([`GSTIN ${p.gst}`]);
  const w = challan.warehouse;
  const site: ChallanBlock = { label: 'Dispatched from', lines: [[`${w.code} · ${w.name}`, true]] };
  if (w.location) site.lines.push([w.location]);
  site.lines.push([`Vehicle ${challan.vehicleNo || '—'}${challan.transporter ? `  ·  ${challan.transporter}` : ''}`]);
  const driver = [challan.driverName, challan.driverPhone].filter(Boolean).join(' · ');
  if (driver) site.lines.push([`Driver ${driver}`]);
  if (challan.lrNo) site.lines.push([`LR no ${challan.lrNo}`]);

  const sent = challan.lines.filter((line) => line.quantity > EMPTY);
  const totals: Array<[string, string]> = [
    [
      `Total dispatched · ${sent.length} of ${challan.lines.length} lines`,
      unitTotals(sent.map((l) => ({ unit: l.unit, value: l.quantity }))),
    ],
  ];
  if (prices) {
    totals.push(['Taxable value', pdfMoney(challan.subtotal ?? 0)]);
    totals.push([`GST ${challan.gstRate}%`, pdfMoney(challan.gstAmount ?? 0)]);
    totals.push(['Bill value', pdfMoney(challan.total ?? 0)]);
  }
  return renderChallanPdf({
    title: 'Delivery Challan',
    number: challan.challanNo,
    date: challan.dispatchedAt ?? challan.saleDate,
    company: c,
    blocks: [consignee, site],
    references: [
      { label: 'Bill no', value: challan.saleNo },
      { label: 'Bill date', value: pdfDate(challan.saleDate, timezone) },
      ...(challan.verifiedBy ? [{ label: 'Checked & loaded by', value: challan.verifiedBy }] : []),
    ],
    columns: [
      { label: '#', weight: 4 },
      { label: 'Item', weight: prices ? 24 : 32 },
      { label: 'Code / lot', weight: prices ? 18 : 20 },
      { label: 'Ordered', weight: prices ? 12 : 20, align: 'right' },
      { label: 'Dispatched', weight: prices ? 14 : 24, align: 'right' },
      ...(prices
        ? [
            { label: 'Rate', weight: 11, align: 'right' as const },
            { label: 'Amount', weight: 17, align: 'right' as const },
          ]
        : []),
    ],
    rows: challan.lines.map((line, index) => {
      const short = line.quantity > EMPTY && line.quantity < line.sold - EMPTY;
      return {
        cells: [
          String(index + 1),
          line.itemName,
          `${line.itemCode}${line.lotNo ? `\nLot ${line.lotNo}` : ''}`,
          pdfQuantity(line.sold, line.unit, prices),
          line.quantity > EMPTY
            ? `${pdfQuantity(line.quantity, line.unit, prices)}${short ? `\nshort ${pdfQuantity(line.sold - line.quantity, line.unit, true)}` : ''}`
            : 'Not sent',
          ...(prices ? [pdfMoney(line.rate ?? 0), pdfMoney(line.amount ?? 0)] : []),
        ],
        // Full details under the item: fabric type, dia, GSM, GG, LL, colour, rolls… (the lot has its own cell).
        sub: [pdfWords(line.category), specsText(lineSpecs(line.specs, line.itemCode, ['Lot']))].filter(Boolean).join('\n'),
      };
    }),
    totals,
    notes: challan.dispatchNotes,
    issued: `Office record of the goods dispatched against bill ${challan.saleNo}; not a tax invoice. Dispatched ${challan.dispatchedAt ? pdfDate(challan.dispatchedAt, timezone, true) : '—'}${challan.verifiedBy ? ` by ${challan.verifiedBy}` : ''}.`,
    signatures: [
      'Dispatched by (godown)',
      `Driver${challan.driverName ? ` (${challan.driverName})` : ''}`,
      `For ${c.legalName || c.name || 'SS Clothing Mills'}\nChecked by (office)`,
    ],
  });
}
