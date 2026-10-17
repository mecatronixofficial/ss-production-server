import { stockQuantity } from '../common/units';
import { MoneyService } from '../finance/money.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHEQUE_OPEN,
  counts,
  EXPENSE_LIVE,
  isOpenCheque,
  movedIn,
  movedOn,
  paidToDistributors,
  saleMoney,
  salePayment,
} from '../finance/money-rules';
import { fabricFlowView } from '../production/fabric-flow-view';
import {
  between,
  DateRange,
  iso,
  limit,
  monthKey,
  monthLabel,
  num,
  pct,
  ReportColumn,
  ReportDefinition,
  ReportRow,
  round,
} from './report-types';

const DAY_MS = 24 * 60 * 60 * 1000;
const col = (key: string, label: string, type: ReportColumn['type'], total = false): ReportColumn => ({ key, label, type, total });
const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean))].join(', ');
const count = (values: Array<string | null | undefined>) => new Set(values.filter(Boolean)).size;
/** "1,200 kg, 40 nos": quantities in mixed units, one figure per unit. */
function quantities(lines: Array<{ quantity: number; unit: string }>) {
  const byUnit = new Map<string, number>();
  for (const line of lines) {
    const unit = line.unit.trim().toLowerCase() || 'kg';
    byUnit.set(unit, (byUnit.get(unit) ?? 0) + line.quantity);
  }
  return [...byUnit.entries()].map(([unit, q]) => `${round(q).toLocaleString('en-IN')} ${unit}`).join(', ');
}
const sumBy = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
/** Top N labels by value, for summary tiles such as "biggest expense categories". */
function topBy(rows: ReportRow[], labelKey: string, valueKey: string, n: number) {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(String(row[labelKey] ?? '—'), (totals.get(String(row[labelKey] ?? '—')) ?? 0) + num(row[valueKey]));
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function reportDefinitions(prisma: PrismaService, money: MoneyService): ReportDefinition[] {
  return [
    // ───────────────────────────── Overview ─────────────────────────────
    {
      key: 'monthly-summary',
      title: 'Monthly business summary',
      group: 'Overview',
      description: 'One line per month: yarn received, fabric knitted, sales billed, fabric delivered, and money in / out.',
      dateLabel: 'Activity date',
      async build(range: DateRange, ctx) {
        const r = between(range);
        const [yarnIn, receipts, runs, sales, deliveries, distributorPaid, expenses] = await Promise.all([
          prisma.stockTransaction.findMany({
            where: { createdAt: r, category: 'YARN', unit: 'KG', txnType: 'PURCHASE_IN' },
            select: { createdAt: true, quantityIn: true },
          }),
          prisma.purchaseReceipt.findMany({
            where: { receivedAt: r },
            select: { receivedAt: true, items: { select: { quantity: true, purchaseOrderItem: { select: { rate: true } } } } },
          }),
          prisma.knittingRun.findMany({ where: { finishedAt: r, status: 'FINISHED' }, select: { finishedAt: true, outputKg: true } }),
          // Dispatched bills by bill date, as on Finance.
          prisma.sale.findMany({ where: { saleDate: r, status: 'DISPATCHED' }, select: { saleDate: true, totalAmount: true } }),
          prisma.fabricFlowDelivery.findMany({
            where: { deliveredAt: r, processStage: 'FINAL', destination: 'CUSTOMER' },
            select: { deliveredAt: true, weightKg: true, amount: true },
          }),
          // Money received and paid, cheques on their clearing day (the same rule as Money and Finance).
          prisma.moneyTransaction.findMany({
            where: { AND: [movedIn(r), { kind: { in: ['RECEIPT', 'PAYMENT'] } }] },
            select: { kind: true, mode: true, txnDate: true, clearedAt: true, amount: true, supplierId: true },
          }),
          prisma.expense.findMany({ where: { ...EXPENSE_LIVE, expenseDate: r }, select: { expenseDate: true, amount: true } }),
        ]);
        const months = new Map<string, Record<string, number>>();
        const add = (date: Date, field: string, value: number) => {
          const key = monthKey(date, ctx.timezone);
          const row = months.get(key) ?? {};
          row[field] = (row[field] ?? 0) + value;
          months.set(key, row);
        };
        for (const y of yarnIn) add(y.createdAt, 'yarnInKg', num(y.quantityIn));
        for (const rc of receipts)
          add(
            rc.receivedAt,
            'purchases',
            sumBy(rc.items, (i) => num(i.quantity) * num(i.purchaseOrderItem.rate)),
          );
        for (const k of runs) if (k.finishedAt) add(k.finishedAt, 'knittedKg', num(k.outputKg));
        for (const sale of sales) add(sale.saleDate, 'sales', num(sale.totalAmount));
        for (const d of deliveries) {
          add(d.deliveredAt, 'deliveredKg', num(d.weightKg));
          add(d.deliveredAt, 'collected', num(d.amount));
        }
        for (const p of distributorPaid) {
          const field = p.kind === 'RECEIPT' ? 'received' : p.supplierId ? 'distributorPaid' : 'otherPaid';
          add(movedOn(p), field, num(p.amount));
        }
        for (const e of expenses) add(e.expenseDate, 'expenses', num(e.amount));

        const rows = [...months.entries()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([key, m]) => ({
            month: monthLabel(key),
            yarnInKg: round(m.yarnInKg ?? 0),
            purchases: round(m.purchases ?? 0, 2),
            knittedKg: round(m.knittedKg ?? 0),
            sales: round(m.sales ?? 0, 2),
            deliveredKg: round(m.deliveredKg ?? 0),
            received: round(m.received ?? 0, 2),
            collected: round(m.collected ?? 0, 2),
            distributorPaid: round(m.distributorPaid ?? 0, 2),
            otherPaid: round(m.otherPaid ?? 0, 2),
            expenses: round(m.expenses ?? 0, 2),
            net: round((m.received ?? 0) + (m.collected ?? 0) - (m.distributorPaid ?? 0) - (m.otherPaid ?? 0) - (m.expenses ?? 0), 2),
          }));
        const total = (k: string) => sumBy(rows, (row) => num((row as ReportRow)[k]));
        return {
          columns: [
            col('month', 'Month', 'text'),
            col('yarnInKg', 'Yarn received (kg)', 'kg', true),
            col('purchases', 'Purchases received', 'money', true),
            col('knittedKg', 'Knitted (kg)', 'kg', true),
            col('sales', 'Sales billed', 'money', true),
            col('deliveredKg', 'Delivered (kg)', 'kg', true),
            col('received', 'Money received', 'money', true),
            col('collected', 'Collected on deliveries', 'money', true),
            col('distributorPaid', 'Paid to distributors', 'money', true),
            col('otherPaid', 'Other payments', 'money', true),
            col('expenses', 'Expenses', 'money', true),
            col('net', 'Net cash', 'money', true),
          ],
          rows,
          summary: [
            { label: 'Sales billed', value: total('sales'), type: 'money', hint: 'Dispatched bills, with GST' },
            { label: 'Delivered', value: total('deliveredKg'), type: 'kg', hint: 'From production batches' },
            { label: 'Money in', value: total('received') + total('collected'), type: 'money' },
            { label: 'Paid to distributors', value: total('distributorPaid'), type: 'money' },
            { label: 'Net cash', value: total('net'), type: 'money' },
          ],
          note: 'Sales billed = dispatched sale bills by bill date, with GST (as on Finance). Money received = receipts on the Money page (a cheque on the day it cleared). Collected = amounts recorded on fabric delivered to parties on the Production page. Net cash = money in - payments - expenses, the same as the Money and Finance pages. Months follow the company time zone.',
        };
      },
    },
    // ───────────────────────────── Sales ─────────────────────────────
    {
      key: 'sales-register',
      title: 'Sales register',
      group: 'Sales',
      description: 'Every sale bill: party, warehouse, taxable value, GST, money received against it and what is still due.',
      dateLabel: 'Bill date',
      async build(range) {
        const sales = await prisma.sale.findMany({
          where: { saleDate: between(range), status: { not: 'CANCELLED' } },
          include: { warehouse: { select: { code: true } }, items: { select: { quantity: true, dispatchedQty: true, unit: true } } },
          orderBy: [{ saleDate: 'desc' }, { saleNo: 'desc' }],
        });
        const moneyBy = await saleMoney(
          prisma,
          sales.map((s) => s.id),
        );
        const rows = sales.map((s) => {
          const pay = salePayment(num(s.totalAmount), moneyBy.get(s.id));
          const dispatched = s.status === 'DISPATCHED';
          return {
            saleDate: iso(s.saleDate),
            saleNo: s.saleNo,
            challanNo: s.challanNo ?? '',
            party: s.partyName,
            partyType: s.partyType,
            warehouse: s.warehouse.code,
            quantity: quantities(s.items.map((i) => ({ quantity: num(dispatched ? i.dispatchedQty : i.quantity), unit: i.unit }))),
            taxable: round(num(s.subtotal), 2),
            gst: round(num(s.gstAmount), 2),
            total: round(num(s.totalAmount), 2),
            received: pay.received,
            due: pay.due,
            payment: pay.status,
            status: s.status,
          };
        });
        const billed = rows.filter((r) => r.status === 'DISPATCHED');
        const waiting = rows.length - billed.length;
        return {
          columns: [
            col('saleDate', 'Bill date', 'date'),
            col('saleNo', 'Bill no', 'text'),
            col('challanNo', 'Challan no', 'text'),
            col('party', 'Party', 'text'),
            col('partyType', 'Party type', 'status'),
            col('warehouse', 'Warehouse', 'text'),
            col('quantity', 'Quantity', 'text'),
            col('taxable', 'Taxable value', 'money', true),
            col('gst', 'GST', 'money', true),
            col('total', 'Bill total', 'money', true),
            col('received', 'Received', 'money', true),
            col('due', 'Due', 'money', true),
            col('payment', 'Payment', 'status'),
            col('status', 'Status', 'status'),
          ],
          ...limit(rows),
          summary: [
            {
              label: 'Bills dispatched',
              value: billed.length,
              type: 'number',
              hint: waiting ? `${waiting} waiting at the warehouse` : 'None waiting',
            },
            {
              label: 'Sales value',
              value: sumBy(billed, (r) => r.total),
              type: 'money',
              hint: `GST ${sumBy(billed, (r) => r.gst).toLocaleString('en-IN', { maximumFractionDigits: 0 })} included`,
            },
            { label: 'Received', value: sumBy(billed, (r) => r.received), type: 'money' },
            {
              label: 'Due on bills',
              value: sumBy(billed, (r) => r.due),
              type: 'money',
              hint: `${billed.filter((r) => r.due > 0.005).length} bills not fully paid`,
            },
          ],
          note: 'Cancelled bills are left out; the summary counts dispatched bills only, the same as Finance. A dispatched bill is valued at the quantity actually sent. Received = money entered against the bill (a cheque once it clears); money received on account, not against a bill, is in Party balances.',
        };
      },
    },
    {
      key: 'sales-by-item',
      title: 'Item-wise sales',
      group: 'Sales',
      description: 'What was sold: quantity dispatched, average rate and value for each item.',
      dateLabel: 'Bill date',
      async build(range) {
        const items = await prisma.saleItem.findMany({
          where: { sale: { status: 'DISPATCHED', saleDate: between(range) } },
          select: {
            category: true,
            itemCode: true,
            itemName: true,
            unit: true,
            dispatchedQty: true,
            amount: true,
            saleId: true,
            sale: { select: { partyName: true } },
          },
        });
        type ItemTotal = {
          category: string;
          itemCode: string;
          itemName: string;
          unit: string;
          qty: number;
          amount: number;
          bills: string[];
          parties: string[];
        };
        const groups = new Map<string, ItemTotal>();
        for (const item of items) {
          const unit = item.unit.trim().toUpperCase() || 'KG';
          const key = `${item.itemCode}|${unit}`;
          const g = groups.get(key) ?? {
            category: item.category,
            itemCode: item.itemCode,
            itemName: item.itemName,
            unit,
            qty: 0,
            amount: 0,
            bills: [],
            parties: [],
          };
          g.qty += num(item.dispatchedQty);
          g.amount += num(item.amount);
          g.bills.push(item.saleId);
          g.parties.push(item.sale.partyName);
          groups.set(key, g);
        }
        const rows = [...groups.values()]
          .filter((g) => g.qty > 0.0005 || g.amount > 0.005)
          .map((g) => ({
            itemCode: g.itemCode,
            itemName: g.itemName,
            category: g.category,
            unit: g.unit,
            bills: count(g.bills),
            parties: count(g.parties),
            quantity: round(g.qty),
            avgRate: g.qty > 0.0005 ? round(g.amount / g.qty, 2) : 0,
            amount: round(g.amount, 2),
          }))
          .sort((a, b) => b.amount - a.amount);
        const kgSold = sumBy(
          rows.filter((r) => r.unit === 'KG'),
          (r) => r.quantity,
        );
        return {
          columns: [
            col('itemCode', 'Item code', 'text'),
            col('itemName', 'Item', 'text'),
            col('category', 'Category', 'status'),
            col('unit', 'Unit', 'text'),
            col('bills', 'Bills', 'number'),
            col('parties', 'Parties', 'number'),
            col('quantity', 'Quantity sent', 'qty'),
            col('avgRate', 'Average rate', 'money'),
            col('amount', 'Value (before GST)', 'money', true),
          ],
          ...limit(rows),
          summary: [
            { label: 'Items sold', value: rows.length, type: 'number', hint: `${count(items.map((i) => i.saleId))} bills` },
            { label: 'Sold by weight', value: kgSold, type: 'kg' },
            { label: 'Value before GST', value: sumBy(rows, (r) => r.amount), type: 'money' },
            ...(rows[0] ? [{ label: 'Top item', value: rows[0].amount, type: 'money' as const, hint: rows[0].itemName }] : []),
          ],
          note: 'Dispatched bills only. Quantity is what the warehouse actually sent; average rate = value ÷ quantity.',
        };
      },
    },
    {
      key: 'party-balances',
      title: 'Party balances',
      group: 'Sales',
      description: 'What each textile and distributor owes us on sale bills, and what we owe each distributor for goods, as of today.',
      dateLabel: null,
      async build() {
        const { distributors, textiles, totals } = await money.parties();
        const rows = [
          ...textiles.map((t) => ({
            code: t.code,
            name: t.name,
            type: t.type,
            billed: t.billed,
            received: t.received,
            chequesPending: t.receiveChequesPending,
            receivable: t.receivable,
            creditLimit: t.creditLimit,
            purchased: 0,
            paid: 0,
            payable: 0,
            lastActivity: iso(t.lastActivity),
          })),
          ...distributors.map((d) => ({
            code: d.code,
            name: d.name,
            type: d.type,
            billed: d.billed,
            received: d.received,
            chequesPending: d.receiveChequesPending,
            receivable: d.receivable,
            creditLimit: null,
            purchased: d.purchased,
            paid: d.paid,
            payable: d.payable,
            lastActivity: iso(d.lastActivity),
          })),
        ]
          .filter((r) => [r.billed, r.received, r.receivable, r.purchased, r.paid, r.payable].some((v) => Math.abs(v) > 0.005))
          .sort((a, b) => b.receivable - a.receivable || b.payable - a.payable || a.name.localeCompare(b.name));
        const overLimit = rows.filter((r) => r.creditLimit !== null && r.receivable > r.creditLimit + 0.005).length;
        return {
          columns: [
            col('code', 'Code', 'text'),
            col('name', 'Party', 'text'),
            col('type', 'Type', 'status'),
            col('billed', 'Sales billed', 'money', true),
            col('received', 'Received', 'money', true),
            col('chequesPending', 'Cheques to clear', 'money', true),
            col('receivable', 'To collect', 'money', true),
            col('creditLimit', 'Credit limit', 'money'),
            col('purchased', 'Goods received', 'money', true),
            col('paid', 'Paid', 'money', true),
            col('payable', 'To pay', 'money', true),
            col('lastActivity', 'Last activity', 'date'),
          ],
          ...limit(rows),
          summary: [
            {
              label: 'To collect',
              value: totals.receivable,
              type: 'money',
              hint: `${totals.textilesDue + totals.distributorsDue} parties owe us`,
            },
            { label: 'Advances received', value: totals.advanceReceived, type: 'money', hint: 'Paid ahead of bills' },
            { label: 'To pay distributors', value: totals.payable, type: 'money', hint: `${totals.distributorsToPay} distributors` },
            { label: 'Over credit limit', value: overLimit, type: 'number', hint: overLimit ? 'Check before the next sale' : 'None' },
          ],
          note: 'To collect = opening balance (textiles) + dispatched bills - money received + refunds paid back. To pay = opening balance + goods received (qty × PO rate) - payments. A minus figure is an advance. Cheques count once they clear. The same figures as the Money page.',
        };
      },
    },

    // ───────────────────────────── Production ─────────────────────────────
    {
      key: 'fabric-batches',
      title: 'Own-material production',
      group: 'Production',
      description: 'Yarn-to-fabric batches from the Production page: weights, losses, spend, collection and profit.',
      // `purchaseDate` is the knitting start for batches started from stock, the purchase date on older ones.
      dateLabel: 'Start date',
      async build(range) {
        const flows = await prisma.fabricProductionFlow.findMany({
          where: { purchaseDate: between(range) },
          // Dated batch expenses are part of spend, the same as on the Production page.
          include: { expenses: { select: { amount: true } } },
          orderBy: { purchaseDate: 'desc' },
        });
        const rows = flows.map((f) => {
          const v = fabricFlowView(f);
          return {
            flowNo: f.flowNo,
            purchaseDate: iso(f.purchaseDate),
            // Batches are tracked by item code; older purchase-started batches have none.
            yarnCode: f.yarnItemCode,
            party: f.knittingPartyDetails ?? f.partyDetails,
            mill: f.knittingMillDetails ?? f.millDetails,
            yarnCount: f.yarnCount,
            purchasedKg: round(v.purchasedWeightKg),
            currentKg: round(v.metrics.currentWeightKg),
            lossKg: round(v.metrics.totalLossKg),
            lossPct: round(v.metrics.lossPct, 1),
            spend: round(v.metrics.totalSpent, 2),
            collected: round(v.collectedAmount, 2),
            profit: round(v.metrics.profit, 2),
            status: f.status,
          };
        });
        const purchased = sumBy(rows, (r) => r.purchasedKg);
        const loss = sumBy(rows, (r) => r.lossKg);
        return {
          columns: [
            col('flowNo', 'Batch', 'text'),
            col('purchaseDate', 'Start date', 'date'),
            col('yarnCode', 'Yarn code', 'text'),
            col('party', 'Party', 'text'),
            col('mill', 'Mill', 'text'),
            col('yarnCount', 'Yarn', 'text'),
            col('purchasedKg', 'Yarn used (kg)', 'kg', true),
            col('currentKg', 'Current (kg)', 'kg', true),
            col('lossKg', 'Loss (kg)', 'kg', true),
            col('lossPct', 'Loss %', 'pct'),
            col('spend', 'Total spend', 'money', true),
            col('collected', 'Collected', 'money', true),
            col('profit', 'Profit', 'money', true),
            col('status', 'Stage', 'status'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Batches', value: rows.length, type: 'number' },
            { label: 'Loss', value: loss, type: 'kg', hint: `${pct(loss, purchased)}% of purchased yarn` },
            { label: 'Total spend', value: sumBy(rows, (r) => r.spend), type: 'money' },
            { label: 'Net profit', value: sumBy(rows, (r) => r.profit), type: 'money' },
          ],
          note: 'Spend = yarn + purchase, knitting, dyeing, compacting and other costs + expenses entered on the batch. Profit = collected - spend.',
        };
      },
    },
    // ───────────────────────────── Purchases ─────────────────────────────
    {
      key: 'purchase-orders',
      title: 'Purchase orders',
      group: 'Purchases',
      description: 'Distributor POs with ordered, received and pending value.',
      dateLabel: 'PO date',
      async build(range) {
        const pos = await prisma.purchaseOrder.findMany({
          where: { orderDate: between(range) },
          include: {
            supplier: { select: { name: true } },
            items: { include: { receiptItems: { select: { quantity: true } } } },
            receipts: { select: { receivedAt: true } },
          },
          orderBy: { orderDate: 'desc' },
        });
        const rows = pos.map((po) => {
          const ordered = sumBy(po.items, (i) => num(i.quantity) * num(i.rate));
          const received = sumBy(po.items, (i) => sumBy(i.receiptItems, (x) => num(x.quantity)) * num(i.rate));
          const last = po.receipts.map((x) => x.receivedAt).sort((a, b) => b.getTime() - a.getTime())[0];
          return {
            poNo: po.poNo,
            orderDate: iso(po.orderDate),
            supplier: po.supplier.name,
            items: unique(po.items.map((i) => i.itemName)),
            orderedValue: round(ordered, 2),
            receivedValue: round(received, 2),
            // Nothing more is expected on a cancelled or closed-short PO.
            pendingValue: po.status === 'CANCELLED' || po.status === 'CLOSED' ? 0 : round(Math.max(0, ordered - received), 2),
            receivedPct: pct(received, ordered),
            expectedDate: iso(po.expectedDate),
            lastReceipt: iso(last),
            status: po.status,
          };
        });
        const live = rows.filter((r) => r.status !== 'CANCELLED');
        return {
          columns: [
            col('poNo', 'PO no', 'text'),
            col('orderDate', 'PO date', 'date'),
            col('supplier', 'Distributor', 'text'),
            col('items', 'Items', 'text'),
            col('orderedValue', 'Ordered value', 'money', true),
            col('receivedValue', 'Received value', 'money', true),
            col('pendingValue', 'Pending value', 'money', true),
            col('receivedPct', 'Received', 'pct'),
            col('expectedDate', 'Expected', 'date'),
            col('lastReceipt', 'Last GRN', 'date'),
            col('status', 'Status', 'status'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Purchase orders', value: live.length, type: 'number' },
            { label: 'Ordered value', value: sumBy(live, (r) => r.orderedValue), type: 'money' },
            { label: 'Received value', value: sumBy(live, (r) => r.receivedValue), type: 'money' },
            { label: 'Pending value', value: sumBy(live, (r) => r.pendingValue), type: 'money' },
          ],
          note: 'Values are quantity × PO rate. Cancelled POs are excluded from the summary.',
        };
      },
    },
    {
      key: 'goods-received',
      title: 'Goods received (GRN)',
      group: 'Purchases',
      description: 'Every receipt against a PO: distributor, warehouse, items, quantity and value at the PO rate.',
      dateLabel: 'Received date',
      async build(range) {
        const receipts = await prisma.purchaseReceipt.findMany({
          where: { receivedAt: between(range) },
          include: {
            purchaseOrder: { select: { poNo: true, supplier: { select: { name: true } } } },
            warehouse: { select: { code: true } },
            items: { select: { quantity: true, purchaseOrderItem: { select: { itemName: true, unit: true, rate: true } } } },
          },
          orderBy: { receivedAt: 'desc' },
        });
        // Weight as it went into stock: KG lines, and gram lines turned into KG.
        const stockKg = (quantity: number, unit: string) => {
          const stocked = stockQuantity(quantity, unit);
          return stocked.unit.trim().toUpperCase() === 'KG' ? stocked.quantity : 0;
        };
        const rows = receipts.map((rc) => ({
          receivedAt: iso(rc.receivedAt),
          receiptNo: rc.receiptNo,
          poNo: rc.purchaseOrder.poNo,
          supplier: rc.purchaseOrder.supplier.name,
          warehouse: rc.warehouse.code,
          category: rc.category,
          items: unique(rc.items.map((i) => i.purchaseOrderItem.itemName)),
          quantity: quantities(rc.items.map((i) => ({ quantity: num(i.quantity), unit: i.purchaseOrderItem.unit }))),
          kg: round(sumBy(rc.items, (i) => stockKg(num(i.quantity), i.purchaseOrderItem.unit))),
          value: round(
            sumBy(rc.items, (i) => num(i.quantity) * num(i.purchaseOrderItem.rate)),
            2,
          ),
          challanNo: rc.challanNo ?? '',
          vehicleNo: rc.vehicleNo ?? '',
          lotNo: rc.lotNo ?? '',
        }));
        return {
          columns: [
            col('receivedAt', 'Received', 'date'),
            col('receiptNo', 'GRN no', 'text'),
            col('poNo', 'PO no', 'text'),
            col('supplier', 'Distributor', 'text'),
            col('warehouse', 'Warehouse', 'text'),
            col('category', 'Category', 'status'),
            col('items', 'Items', 'text'),
            col('quantity', 'Quantity', 'text'),
            col('kg', 'Weight (kg)', 'kg', true),
            col('value', 'Value', 'money', true),
            col('challanNo', 'Their challan', 'text'),
            col('vehicleNo', 'Vehicle', 'text'),
            col('lotNo', 'Lot', 'text'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Receipts (GRN)', value: rows.length, type: 'number', hint: `${count(rows.map((r) => r.poNo))} POs` },
            { label: 'Weight received', value: sumBy(rows, (r) => r.kg), type: 'kg' },
            { label: 'Value received', value: sumBy(rows, (r) => r.value), type: 'money' },
            { label: 'Distributors', value: count(rows.map((r) => r.supplier)), type: 'number' },
          ],
          note: 'Value = quantity received × PO rate, the figure distributor balances use. Weight counts lines bought in KG and in grams (as KG).',
        };
      },
    },
    {
      key: 'supplier-summary',
      title: 'Distributor summary',
      group: 'Purchases',
      description: 'Purchasing and payments per distributor, with each distributor’s balance payable today.',
      dateLabel: 'PO / receipt / payment date',
      async build(range) {
        const r = between(range);
        const [suppliers, pos, receiptsInRange, receiptsAll, paidInRange, paidAll] = await Promise.all([
          prisma.supplier.findMany({ select: { id: true, code: true, name: true, materialCategory: true, openingBalance: true } }),
          prisma.purchaseOrder.findMany({
            where: { orderDate: r, status: { not: 'CANCELLED' } },
            select: { supplierId: true, items: { select: { quantity: true, rate: true } } },
          }),
          prisma.purchaseReceipt.findMany({
            where: { receivedAt: r },
            select: {
              purchaseOrder: { select: { supplierId: true } },
              items: { select: { quantity: true, purchaseOrderItem: { select: { rate: true } } } },
            },
          }),
          prisma.purchaseReceipt.findMany({
            select: {
              purchaseOrder: { select: { supplierId: true } },
              items: { select: { quantity: true, purchaseOrderItem: { select: { rate: true } } } },
            },
          }),
          paidToDistributors(prisma, movedIn(r)),
          paidToDistributors(prisma),
        ]);
        const receivedBy = (list: typeof receiptsAll) => {
          const totals = new Map<string, number>();
          for (const rc of list)
            totals.set(
              rc.purchaseOrder.supplierId,
              (totals.get(rc.purchaseOrder.supplierId) ?? 0) + sumBy(rc.items, (i) => num(i.quantity) * num(i.purchaseOrderItem.rate)),
            );
          return totals;
        };
        const recRange = receivedBy(receiptsInRange);
        const recAll = receivedBy(receiptsAll);
        const payRange = new Map([...paidInRange].map(([id, p]) => [id, p.amount]));
        const payAll = new Map([...paidAll].map(([id, p]) => [id, p.amount]));
        const rows = suppliers
          .map((s) => {
            const mine = pos.filter((po) => po.supplierId === s.id);
            return {
              code: s.code,
              supplier: s.name,
              category: s.materialCategory ?? '',
              pos: mine.length,
              orderedValue: round(
                sumBy(mine, (po) => sumBy(po.items, (i) => num(i.quantity) * num(i.rate))),
                2,
              ),
              receivedValue: round(recRange.get(s.id) ?? 0, 2),
              paid: round(payRange.get(s.id) ?? 0, 2),
              balance: round(num(s.openingBalance) + (recAll.get(s.id) ?? 0) - (payAll.get(s.id) ?? 0), 2),
            };
          })
          .filter((row) => row.pos || row.receivedValue || row.paid || Math.abs(row.balance) > 0.005)
          .sort((a, b) => b.orderedValue - a.orderedValue);
        return {
          columns: [
            col('code', 'Code', 'text'),
            col('supplier', 'Distributor', 'text'),
            col('category', 'Material', 'text'),
            col('pos', 'POs', 'number', true),
            col('orderedValue', 'Ordered value', 'money', true),
            col('receivedValue', 'Received value', 'money', true),
            col('paid', 'Paid', 'money', true),
            col('balance', 'Balance payable today', 'money', true),
          ],
          ...limit(rows),
          summary: [
            { label: 'Distributors with activity', value: rows.length, type: 'number' },
            { label: 'Ordered value', value: sumBy(rows, (x) => x.orderedValue), type: 'money' },
            { label: 'Paid', value: sumBy(rows, (x) => x.paid), type: 'money' },
            { label: 'Total payable today', value: sumBy(rows, (x) => x.balance), type: 'money' },
          ],
          note: 'Balance payable today = opening balance + all goods received (qty × PO rate) - all distributor payments.',
        };
      },
    },

    // ───────────────────────────── Inventory ─────────────────────────────
    {
      key: 'stock-statement',
      title: 'Stock statement',
      group: 'Inventory',
      description: 'Opening, received, issued and closing quantity for every item and warehouse.',
      dateLabel: 'Movement date',
      async build(range) {
        const by = ['category', 'itemCode', 'unit', 'warehouseId'] as const;
        const [before, during, names, warehouses] = await Promise.all([
          range.from
            ? prisma.stockTransaction.groupBy({
                by: [...by],
                where: { createdAt: { lt: range.from } },
                _sum: { quantityIn: true, quantityOut: true },
              })
            : Promise.resolve([]),
          prisma.stockTransaction.groupBy({
            by: [...by],
            where: { createdAt: between(range) },
            _sum: { quantityIn: true, quantityOut: true },
          }),
          prisma.stockTransaction.findMany({
            distinct: ['itemCode'],
            orderBy: { createdAt: 'desc' },
            select: { itemCode: true, itemName: true },
          }),
          prisma.warehouse.findMany({ select: { id: true, code: true, name: true } }),
        ]);
        const key = (g: { category: string; itemCode: string; unit: string; warehouseId: string }) =>
          `${g.category}|${g.itemCode}|${g.unit}|${g.warehouseId}`;
        const lines = new Map<
          string,
          { category: string; itemCode: string; unit: string; warehouseId: string; opening: number; in: number; out: number }
        >();
        const line = (g: { category: string; itemCode: string; unit: string; warehouseId: string }) => {
          const k = key(g);
          const existing = lines.get(k) ?? { ...g, opening: 0, in: 0, out: 0 };
          lines.set(k, existing);
          return existing;
        };
        for (const g of before) line(g).opening = num(g._sum.quantityIn) - num(g._sum.quantityOut);
        for (const g of during) Object.assign(line(g), { in: num(g._sum.quantityIn), out: num(g._sum.quantityOut) });
        const nameOf = new Map(names.map((n) => [n.itemCode, n.itemName]));
        const whOf = new Map(warehouses.map((w) => [w.id, w.code]));
        const rows = [...lines.values()]
          .map((l) => ({
            category: l.category,
            itemCode: l.itemCode,
            itemName: nameOf.get(l.itemCode) ?? l.itemCode,
            warehouse: whOf.get(l.warehouseId) ?? '',
            unit: l.unit,
            opening: round(l.opening),
            received: round(l.in),
            issued: round(l.out),
            closing: round(l.opening + l.in - l.out),
          }))
          .filter((r) => r.opening || r.received || r.issued)
          .sort((a, b) => a.category.localeCompare(b.category) || a.itemName.localeCompare(b.itemName));
        const negative = rows.filter((r) => r.closing < -0.0005).length;
        return {
          columns: [
            col('category', 'Category', 'status'),
            col('itemCode', 'Item code', 'text'),
            col('itemName', 'Item', 'text'),
            col('warehouse', 'Warehouse', 'text'),
            col('unit', 'Unit', 'text'),
            col('opening', 'Opening', 'qty'),
            col('received', 'Received', 'qty'),
            col('issued', 'Issued', 'qty'),
            col('closing', 'Closing', 'qty'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Stock lines', value: rows.length, type: 'number' },
            { label: 'Items in stock', value: rows.filter((r) => r.closing > 0.0005).length, type: 'number' },
            { label: 'Lines with movement', value: rows.filter((r) => r.received || r.issued).length, type: 'number' },
            { label: 'Negative balances', value: negative, type: 'number', hint: negative ? 'Check the stock ledger' : 'None' },
          ],
          note: 'Opening = balance before the start date; closing = opening + received - issued. Quantities are in each item’s own unit, so no grand total.',
        };
      },
    },

    // ───────────────────────────── Machines ─────────────────────────────
    {
      key: 'machines',
      title: 'Machine utilisation',
      group: 'Machines',
      description: 'Knitting runs finished on each machine: yarn loaded, fabric taken off, shifts worked and knitting charges.',
      dateLabel: 'Finish date',
      async build(range) {
        const [machines, runs] = await Promise.all([
          prisma.machine.findMany({ where: { status: { not: 'DISABLED' } }, orderBy: { code: 'asc' } }),
          prisma.knittingRun.findMany({
            where: { status: 'FINISHED', finishedAt: between(range) },
            select: {
              machineId: true,
              yarnKg: true,
              outputKg: true,
              knittingCharge: true,
              startedAt: true,
              startShift: true,
              finishedAt: true,
              finishShift: true,
            },
          }),
        ]);
        /** Shifts from start to finish, both counted (Day comes before Night on the same date). */
        const shiftIndex = (date: Date, shift: string) =>
          Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS) * 2 + (shift === 'NIGHT' ? 1 : 0);
        const rows = machines.map((m) => {
          const mine = runs.filter((run) => run.machineId === m.id);
          const yarnKg = sumBy(mine, (run) => num(run.yarnKg));
          const fabricKg = sumBy(mine, (run) => num(run.outputKg));
          return {
            code: m.code,
            machine: m.name,
            type: m.type ?? '',
            runs: mine.length,
            yarnKg: round(yarnKg),
            fabricKg: round(fabricKg),
            changePct: yarnKg ? round(((fabricKg - yarnKg) / yarnKg) * 100, 1) : 0,
            shifts: sumBy(mine, (run) =>
              run.finishedAt && run.finishShift
                ? shiftIndex(run.finishedAt, run.finishShift) - shiftIndex(run.startedAt, run.startShift) + 1
                : 0,
            ),
            charges: round(
              sumBy(mine, (run) => num(run.knittingCharge)),
              2,
            ),
            status: m.status,
          };
        });
        return {
          columns: [
            col('code', 'Code', 'text'),
            col('machine', 'Machine', 'text'),
            col('type', 'Type', 'text'),
            col('runs', 'Runs finished', 'number', true),
            col('yarnKg', 'Yarn loaded (kg)', 'kg', true),
            col('fabricKg', 'Fabric (kg)', 'kg', true),
            col('changePct', 'Change %', 'pct'),
            col('shifts', 'Shifts', 'number', true),
            col('charges', 'Knitting charges', 'money', true),
            col('status', 'Current status', 'status'),
          ],
          ...limit(rows),
          summary: [
            {
              label: 'Machines',
              value: rows.length,
              type: 'number',
              hint: `${rows.filter((x) => x.status === 'RUNNING').length} running now`,
            },
            { label: 'Fabric knitted', value: sumBy(rows, (x) => x.fabricKg), type: 'kg', hint: `${sumBy(rows, (x) => x.runs)} runs` },
            { label: 'Knitting charges', value: sumBy(rows, (x) => x.charges), type: 'money' },
            {
              label: 'Out of service now',
              value: rows.filter((x) => x.status === 'MAINTENANCE' || x.status === 'BREAKDOWN').length,
              type: 'number',
            },
          ],
        };
      },
    },

    {
      key: 'knitting-runs',
      title: 'Knitting runs',
      group: 'Machines',
      description: 'Each finished run: machine, operator, yarn loaded, fabric taken off, rolls and knitting charge.',
      dateLabel: 'Finish date',
      async build(range) {
        const runs = await prisma.knittingRun.findMany({
          where: { status: 'FINISHED', finishedAt: between(range) },
          include: {
            machine: { select: { code: true } },
            operator: { select: { name: true } },
            productionFlow: { select: { flowNo: true } },
            warehouse: { select: { code: true } },
            yarns: { select: { itemCode: true } },
          },
          orderBy: { finishedAt: 'desc' },
        });
        const rows = runs.map((run) => {
          const yarnKg = num(run.yarnKg);
          const fabricKg = num(run.outputKg);
          return {
            runNo: run.runNo,
            finishedAt: iso(run.finishedAt),
            machine: run.machine.code,
            operator: run.operator?.name ?? '',
            fabricType: run.fabricType ?? '',
            yarns: unique(run.yarns.map((y) => y.itemCode)),
            batch: run.productionFlow?.flowNo ?? '',
            yarnKg: round(yarnKg),
            fabricKg: round(fabricKg),
            changePct: yarnKg ? round(((fabricKg - yarnKg) / yarnKg) * 100, 1) : 0,
            rolls: run.rollCount ?? 0,
            ratePerKg: round(num(run.ratePerKg), 2),
            charge: round(num(run.knittingCharge), 2),
            yarnCost: round(num(run.yarnCost), 2),
            warehouse: run.warehouse?.code ?? '',
          };
        });
        const yarn = sumBy(rows, (r) => r.yarnKg);
        const fabric = sumBy(rows, (r) => r.fabricKg);
        return {
          columns: [
            col('runNo', 'Run', 'text'),
            col('finishedAt', 'Finished', 'date'),
            col('machine', 'Machine', 'text'),
            col('operator', 'Operator', 'text'),
            col('fabricType', 'Fabric', 'text'),
            col('yarns', 'Yarns', 'text'),
            col('batch', 'Batch', 'text'),
            col('yarnKg', 'Yarn loaded (kg)', 'kg', true),
            col('fabricKg', 'Fabric (kg)', 'kg', true),
            col('changePct', 'Change %', 'pct'),
            col('rolls', 'Rolls', 'number', true),
            col('ratePerKg', 'Rate / kg', 'money'),
            col('charge', 'Knitting charge', 'money', true),
            col('yarnCost', 'Yarn cost', 'money', true),
            col('warehouse', 'Fabric to', 'text'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Runs finished', value: rows.length, type: 'number', hint: `${count(rows.map((r) => r.machine))} machines` },
            { label: 'Fabric knitted', value: fabric, type: 'kg', hint: `from ${round(yarn).toLocaleString('en-IN')} kg yarn` },
            {
              label: 'Weight change',
              value: yarn ? round(((fabric - yarn) / yarn) * 100, 1) : 0,
              type: 'pct',
              hint: 'Fabric vs yarn loaded',
            },
            { label: 'Knitting charges', value: sumBy(rows, (r) => r.charge), type: 'money' },
          ],
        };
      },
    },

    // ───────────────────────────── Finance ─────────────────────────────
    {
      key: 'deliveries',
      title: 'Fabric deliveries',
      group: 'Finance',
      description: 'Finished fabric delivered from production batches: to which party, how much, and what was collected.',
      dateLabel: 'Delivery date',
      async build(range) {
        const deliveries = await prisma.fabricFlowDelivery.findMany({
          where: { deliveredAt: between(range), processStage: 'FINAL' },
          include: {
            flow: { select: { flowNo: true, fabricType: true, yarnCount: true, color: true } },
            warehouse: { select: { code: true } },
          },
          orderBy: { deliveredAt: 'desc' },
        });
        const rows = deliveries.map((d) => ({
          deliveredAt: iso(d.deliveredAt),
          flowNo: d.flow.flowNo,
          fabric: [d.flow.fabricType ?? d.flow.yarnCount, d.flow.color].filter(Boolean).join(' · '),
          to: d.destination === 'CUSTOMER' ? (d.partyName ?? 'Party') : `Warehouse ${d.warehouse?.code ?? ''}`.trim(),
          weightKg: round(num(d.weightKg)),
          amount: round(num(d.amount), 2),
          expense: round(num(d.expense), 2),
          notes: d.notes ?? '',
        }));
        return {
          columns: [
            col('deliveredAt', 'Date', 'date'),
            col('flowNo', 'Batch', 'text'),
            col('fabric', 'Fabric', 'text'),
            col('to', 'Delivered to', 'text'),
            col('weightKg', 'Weight (kg)', 'kg', true),
            col('amount', 'Collected', 'money', true),
            col('expense', 'Delivery cost', 'money', true),
            col('notes', 'Notes', 'text'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Delivered', value: sumBy(rows, (r) => r.weightKg), type: 'kg', hint: `${rows.length} deliveries` },
            { label: 'Collected', value: sumBy(rows, (r) => r.amount), type: 'money' },
            ...topBy(rows, 'to', 'amount', 2).map(([label, value]) => ({ label, value, type: 'money' as const })),
          ],
        };
      },
    },
    {
      key: 'expenses',
      title: 'Expenses',
      group: 'Finance',
      description: 'Every expense by category, with payment mode and branch.',
      dateLabel: 'Expense date',
      async build(range) {
        const expenses = await prisma.expense.findMany({
          where: { ...EXPENSE_LIVE, expenseDate: between(range) },
          orderBy: { expenseDate: 'desc' },
        });
        const rows = expenses.map((e) => ({
          expenseDate: iso(e.expenseDate),
          expenseNo: e.expenseNo,
          category: e.category,
          subcategory: e.subcategory ?? '',
          description: e.description ?? '',
          paymentMode: e.paymentMode,
          branch: e.branch ?? '',
          amount: round(num(e.amount), 2),
        }));
        return {
          columns: [
            col('expenseDate', 'Date', 'date'),
            col('expenseNo', 'Expense no', 'text'),
            col('category', 'Category', 'text'),
            col('subcategory', 'Sub-category', 'text'),
            col('description', 'Description', 'text'),
            col('paymentMode', 'Paid by', 'status'),
            col('branch', 'Branch', 'text'),
            col('amount', 'Amount', 'money', true),
          ],
          ...limit(rows),
          summary: [
            { label: 'Total expenses', value: sumBy(rows, (r) => r.amount), type: 'money', hint: `${rows.length} entries` },
            ...topBy(rows, 'category', 'amount', 3).map(([label, value]) => ({ label, value, type: 'money' as const })),
          ],
        };
      },
    },
    {
      key: 'money-register',
      title: 'Receipts and payments',
      group: 'Finance',
      description: 'Every receipt and payment from the Money page: party, mode, account, reference and whether it has counted yet.',
      dateLabel: 'Entry date',
      async build(range) {
        const txns = await prisma.moneyTransaction.findMany({
          where: { cancelledAt: null, kind: { in: ['RECEIPT', 'PAYMENT'] }, txnDate: between(range) },
          include: { account: { select: { name: true } }, sale: { select: { saleNo: true } } },
          orderBy: [{ txnDate: 'desc' }, { createdAt: 'desc' }],
        });
        const rows = txns.map((t) => {
          const amount = round(num(t.amount), 2);
          const counted = counts(t);
          return {
            txnDate: iso(t.txnDate),
            txnNo: t.txnNo,
            kind: t.kind,
            party: t.partyName ?? '',
            partyType: t.partyType ?? '',
            against: t.sale?.saleNo ?? '',
            mode: t.mode,
            account: t.account?.name ?? '',
            reference: t.chequeNo ? `Cheque ${t.chequeNo}${t.chequeBank ? ` · ${t.chequeBank}` : ''}` : (t.referenceNo ?? ''),
            received: counted && t.kind === 'RECEIPT' ? amount : 0,
            paid: counted && t.kind === 'PAYMENT' ? amount : 0,
            chequePending: isOpenCheque(t) ? amount : 0,
            status: t.mode === 'CHEQUE' ? (t.chequeStatus ?? 'PENDING') : 'CLEARED',
          };
        });
        const received = sumBy(rows, (r) => r.received);
        const paid = sumBy(rows, (r) => r.paid);
        const open = rows.filter((r) => r.chequePending > 0);
        return {
          columns: [
            col('txnDate', 'Date', 'date'),
            col('txnNo', 'Entry no', 'text'),
            col('kind', 'Type', 'status'),
            col('party', 'Party', 'text'),
            col('partyType', 'Party type', 'status'),
            col('against', 'Against bill', 'text'),
            col('mode', 'Mode', 'status'),
            col('account', 'Account', 'text'),
            col('reference', 'Reference', 'text'),
            col('received', 'Received', 'money', true),
            col('paid', 'Paid', 'money', true),
            col('chequePending', 'Cheque to clear', 'money', true),
            col('status', 'Status', 'status'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Received', value: received, type: 'money', hint: `${rows.filter((r) => r.received).length} receipts` },
            { label: 'Paid', value: paid, type: 'money', hint: `${rows.filter((r) => r.paid).length} payments` },
            { label: 'Net', value: round(received - paid, 2), type: 'money' },
            { label: 'Cheques to clear', value: sumBy(open, (r) => r.chequePending), type: 'money', hint: `${open.length} cheques` },
          ],
          note: 'Listed by entry date. A cheque counts in Received / Paid only once it clears; bounced cheques count nowhere. The Monthly summary puts a cheque on the day it cleared, so a cheque that cleared in another period can make the two differ. Cancelled entries and transfers between own accounts are left out.',
        };
      },
    },
    {
      key: 'cheques',
      title: 'Cheques to clear',
      group: 'Finance',
      description: 'Cheques received and issued that have not cleared or bounced yet, oldest first, as of today.',
      dateLabel: null,
      async build(_range, ctx) {
        const cheques = await prisma.moneyTransaction.findMany({
          where: CHEQUE_OPEN,
          include: { account: { select: { name: true } } },
          orderBy: [{ chequeDate: 'asc' }, { txnDate: 'asc' }],
        });
        const rows = cheques.map((c) => {
          const date = c.chequeDate ?? c.txnDate;
          return {
            chequeDate: iso(date),
            chequeNo: c.chequeNo ?? '',
            bank: c.chequeBank ?? '',
            kind: c.kind,
            party: c.partyName ?? '',
            txnNo: c.txnNo,
            account: c.account?.name ?? '',
            toReceive: c.kind === 'RECEIPT' ? round(num(c.amount), 2) : 0,
            toPay: c.kind === 'PAYMENT' ? round(num(c.amount), 2) : 0,
            days: Math.max(0, Math.floor((ctx.now.getTime() - date.getTime()) / DAY_MS)),
            status: c.chequeStatus ?? 'PENDING',
          };
        });
        const oldest = rows.reduce((max, r) => Math.max(max, r.days), 0);
        return {
          columns: [
            col('chequeDate', 'Cheque date', 'date'),
            col('chequeNo', 'Cheque no', 'text'),
            col('bank', 'Bank', 'text'),
            col('kind', 'Type', 'status'),
            col('party', 'Party', 'text'),
            col('txnNo', 'Entry no', 'text'),
            col('account', 'Account', 'text'),
            col('toReceive', 'To receive', 'money', true),
            col('toPay', 'To pay', 'money', true),
            col('days', 'Days', 'number'),
            col('status', 'Status', 'status'),
          ],
          ...limit(rows),
          summary: [
            {
              label: 'To receive',
              value: sumBy(rows, (r) => r.toReceive),
              type: 'money',
              hint: `${rows.filter((r) => r.toReceive).length} cheques`,
            },
            { label: 'To pay', value: sumBy(rows, (r) => r.toPay), type: 'money', hint: `${rows.filter((r) => r.toPay).length} cheques` },
            { label: 'Open cheques', value: rows.length, type: 'number' },
            { label: 'Oldest', value: oldest, type: 'number', hint: rows.length ? 'days since the cheque date' : 'None open' },
          ],
          note: 'These amounts are not in any balance yet: a received cheque counts when it clears, an issued one when it is cashed. Days = days since the cheque date.',
        };
      },
    },
    {
      key: 'account-balances',
      title: 'Account balances',
      group: 'Finance',
      description: 'Cash in hand, bank and UPI accounts: opening balance, money in and out, and the balance today.',
      dateLabel: null,
      async build() {
        const accounts = await money.accounts();
        const rows = accounts
          .filter((a) => a.active || Math.abs(a.balance) > 0.005)
          .map((a) => ({
            name: a.name,
            type: a.type,
            details: [a.bankName, a.accountNoMasked, a.upiId].filter(Boolean).join(' · '),
            opening: round(a.openingBalance, 2),
            moneyIn: a.moneyIn,
            moneyOut: a.moneyOut,
            balance: a.balance,
            chequesToClear: a.chequesToClear,
            chequesIssued: a.chequesIssued,
            lastTxnAt: iso(a.lastTxnAt),
            status: a.active ? 'ACTIVE' : 'INACTIVE',
          }));
        const live = rows.filter((r) => r.status === 'ACTIVE');
        const byType = (type: string) =>
          sumBy(
            live.filter((r) => r.type === type),
            (r) => r.balance,
          );
        return {
          columns: [
            col('name', 'Account', 'text'),
            col('type', 'Type', 'status'),
            col('details', 'Bank / number', 'text'),
            col('opening', 'Opening', 'money', true),
            col('moneyIn', 'Money in', 'money', true),
            col('moneyOut', 'Money out', 'money', true),
            col('balance', 'Balance', 'money', true),
            col('chequesToClear', 'Cheques to clear', 'money', true),
            col('chequesIssued', 'Cheques issued', 'money', true),
            col('lastTxnAt', 'Last entry', 'date'),
            col('status', 'Status', 'status'),
          ],
          ...limit(rows),
          summary: [
            { label: 'Total balance', value: sumBy(live, (r) => r.balance), type: 'money', hint: `${live.length} active accounts` },
            { label: 'Cash in hand', value: byType('CASH'), type: 'money' },
            { label: 'Bank', value: byType('BANK'), type: 'money' },
            { label: 'UPI', value: byType('UPI'), type: 'money' },
          ],
          note: 'Balance = opening + money received + transfers in - payments - transfers out - expenses paid from the account. Cheques count once cleared: cheques to clear will add to the balance, cheques issued will reduce it. The same figures as the Money page.',
        };
      },
    },
  ];
}
