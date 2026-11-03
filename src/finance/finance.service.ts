import { BadRequestException, Injectable } from '@nestjs/common';
import { MoneyTxnKind, SalePartyType, SaleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cashFlow, EXPENSE_LIVE, movedIn, movedOn, paidToDistributors, round2, thisMonth } from './money-rules';
import { MoneyService } from './money.service';

export type PnlGroup = 'day' | 'week' | 'month' | 'year';
/** Most buckets one profit-and-loss table can have. */
const MAX_BUCKETS: Record<PnlGroup, number> = { day: 400, week: 260, month: 120, year: 30 };
const DAY_MS = 86_400_000;

/** The calendar day a moment falls on where the user is (`tz` is the browser's getTimezoneOffset: India is -330). */
const localDay = (date: Date, tz: number) => new Date(date.getTime() - tz * 60_000).toISOString().slice(0, 10);

/** The bucket a day belongs to: the day, the Monday of its week, its month, or the year its financial year starts. */
function bucketOf(day: string, group: PnlGroup) {
  if (group === 'day') return day;
  if (group === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  if (group === 'week') {
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return String(d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
}

const PNL_FIGURES = ['sales', 'collected', 'earned', 'purchases', 'expenses', 'machineExpenses', 'staffPayments', 'batchCosts', 'spent', 'profit', 'moneyIn', 'moneyOut', 'net'] as const;
type PnlFigures = Record<(typeof PNL_FIGURES)[number], number>;
const emptyFigures = (): PnlFigures => Object.fromEntries(PNL_FIGURES.map((k) => [k, 0])) as PnlFigures;

/**
 * Finance is the results side, read-only: what the business earned and spent in a period, how money flowed, and where
 * it stands. Every rupee is recorded on the Money page (MoneyService); the money figures here come from the same
 * calculation (`cashFlow`, `parties`, `accounts`), so the two pages always agree.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly money: MoneyService,
  ) {}

  /** This month's money and what is owed to distributors, for the Dashboard. */
  async summary() {
    const { from, to } = thisMonth();
    const [month, payables] = await Promise.all([cashFlow(this.prisma, from, to), this.payables()]);
    const owing = payables.filter((s) => s.balance > 0.005);
    return { payable: round2(owing.reduce((s, row) => s + row.balance, 0)), suppliersOwed: owing.length, month };
  }

  /**
   * What is owed to each distributor for material received: opening balance + value received (quantity x PO rate)
   * - payments that count. The same figure as the Distributors master, the Money page and the Distributor report.
   */
  async payables() {
    const [suppliers, received, paid] = await Promise.all([
      this.prisma.supplier.findMany({ select: { id: true, openingBalance: true } }),
      this.prisma.$queryRaw<Array<{ supplierId: string; value: number }>>`
        SELECT po."supplierId" AS "supplierId", COALESCE(SUM(ri."quantity" * poi."rate"), 0)::float8 AS "value"
        FROM "PurchaseReceiptItem" ri
        JOIN "PurchaseReceipt" pr ON pr."id" = ri."purchaseReceiptId"
        JOIN "PurchaseOrderItem" poi ON poi."id" = ri."purchaseOrderItemId"
        JOIN "PurchaseOrder" po ON po."id" = pr."purchaseOrderId"
        GROUP BY po."supplierId"`,
      paidToDistributors(this.prisma),
    ]);
    const receivedBy = new Map(received.map((row) => [row.supplierId, Number(row.value)]));
    return suppliers.map((s) => ({
      id: s.id,
      balance: round2(Number(s.openingBalance) + (receivedBy.get(s.id) ?? 0) - (paid.get(s.id)?.amount ?? 0)),
    }));
  }

  /**
   * One period's results:
   * - Earned: sales billed (dispatched, by bill date; taxable value, GST shown apart) + amounts collected on
   *   production deliveries.
   * - Spent: goods received from distributors (value at PO rate) + expenses + costs entered on production batches.
   * - Cash flow: money that actually came in and went out (cheques on their clearing day).
   * - Position now: money in accounts, to collect, to pay.
   * - Expenses by category, machine expenses by machine and type, and money given to employees.
   * Results over time (day, week, month, year) come from `pnl`.
   */
  async overview(fromIso: string, toIso: string) {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from > to) throw new BadRequestException('The start date is after the end date');
    const range = { gte: from, lte: to };

    const [flow, sales, salesByParty, purchases, expenseByCategory, batchCosts, machineExpenses, staffPayments, parties, accounts] = await Promise.all([
      cashFlow(this.prisma, from, to),
      this.prisma.sale.aggregate({
        where: { status: SaleStatus.DISPATCHED, saleDate: range },
        _sum: { subtotal: true, gstAmount: true, totalAmount: true },
        _count: { _all: true },
      }),
      this.prisma.sale.groupBy({
        by: ['partyType'],
        where: { status: SaleStatus.DISPATCHED, saleDate: range },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ value: number; receipts: number }>>`
        SELECT COALESCE(SUM(ri."quantity" * poi."rate"), 0)::float8 AS "value", COUNT(DISTINCT pr."id")::int AS "receipts"
        FROM "PurchaseReceiptItem" ri
        JOIN "PurchaseReceipt" pr ON pr."id" = ri."purchaseReceiptId"
        JOIN "PurchaseOrderItem" poi ON poi."id" = ri."purchaseOrderItemId"
        WHERE pr."receivedAt" >= ${from} AND pr."receivedAt" <= ${to}`,
      this.prisma.expense.groupBy({
        by: ['category'],
        where: { ...EXPENSE_LIVE, expenseDate: range },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.fabricFlowExpense.aggregate({ where: { expenseDate: range }, _sum: { amount: true }, _count: { _all: true } }),
      this.machineExpenses(range),
      this.staffPayments(range),
      this.money.parties(),
      this.money.accounts(),
    ]);

    const salesTaxable = round2(Number(sales._sum.subtotal ?? 0));
    const earnedTotal = round2(salesTaxable + flow.collected);
    const purchaseValue = round2(Number(purchases[0]?.value ?? 0));
    const batchCostTotal = round2(Number(batchCosts._sum.amount ?? 0));
    const spentTotal = round2(purchaseValue + flow.expenses + batchCostTotal);
    const byParty = (type: SalePartyType) => {
      const row = salesByParty.find((r) => r.partyType === type);
      return { amount: round2(Number(row?._sum.totalAmount ?? 0)), count: row?._count._all ?? 0 };
    };
    const live = accounts.filter((a) => a.active);
    return {
      period: { from, to },
      earned: {
        salesTaxable,
        salesGst: round2(Number(sales._sum.gstAmount ?? 0)),
        salesTotal: round2(Number(sales._sum.totalAmount ?? 0)),
        salesCount: sales._count._all,
        textiles: byParty(SalePartyType.TEXTILE),
        distributors: byParty(SalePartyType.DISTRIBUTOR),
        collected: flow.collected,
        deliveries: flow.deliveries,
        total: earnedTotal,
      },
      spent: {
        purchases: purchaseValue,
        purchaseReceipts: Number(purchases[0]?.receipts ?? 0),
        expenses: flow.expenses,
        expenseCount: flow.expenseCount,
        batchCosts: batchCostTotal,
        batchCostCount: batchCosts._count._all,
        total: spentTotal,
      },
      result: round2(earnedTotal - spentTotal),
      cashFlow: flow,
      machineExpenses,
      staffPayments,
      expensesByCategory: expenseByCategory
        .map((row) => ({ category: row.category, amount: round2(Number(row._sum.amount ?? 0)), count: row._count._all }))
        .sort((a, b) => b.amount - a.amount),
      position: {
        inAccounts: round2(live.reduce((s, a) => s + a.balance, 0)),
        accounts: live.length,
        ...parties.totals,
      },
    };
  }

  /** Money spent on machines (repair, spares, needles, oil, service, power) in a period: by machine and by type. */
  private async machineExpenses(range: { gte: Date; lte: Date }) {
    const where = { ...EXPENSE_LIVE, expenseDate: range, machineId: { not: null } };
    const [byMachine, byType] = await Promise.all([
      this.prisma.expense.groupBy({ by: ['machineId'], where, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.expense.groupBy({ by: ['subcategory'], where, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const machines = byMachine.length
      ? await this.prisma.machine.findMany({ where: { id: { in: byMachine.map((r) => r.machineId!) } }, select: { id: true, code: true, name: true } })
      : [];
    const rows = byMachine
      .map((r) => ({ ...machines.find((m) => m.id === r.machineId)!, amount: round2(Number(r._sum.amount ?? 0)), count: r._count._all }))
      .sort((a, b) => b.amount - a.amount);
    return {
      total: round2(rows.reduce((sum, r) => sum + r.amount, 0)),
      count: rows.reduce((sum, r) => sum + r.count, 0),
      byMachine: rows,
      byType: byType
        .map((r) => ({ type: r.subcategory ?? 'Other', amount: round2(Number(r._sum.amount ?? 0)), count: r._count._all }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  /** Money given to employees in a period (Wages expenses linked to them): by employee and by kind. */
  private async staffPayments(range: { gte: Date; lte: Date }) {
    const where = { ...EXPENSE_LIVE, expenseDate: range, employeeId: { not: null } };
    const [byEmployee, byKind] = await Promise.all([
      this.prisma.expense.groupBy({ by: ['employeeId'], where, _sum: { amount: true }, _count: { _all: true }, _max: { expenseDate: true } }),
      this.prisma.expense.groupBy({ by: ['subcategory'], where, _sum: { amount: true }, _count: { _all: true } }),
    ]);
    const employees = byEmployee.length
      ? await this.prisma.employee.findMany({ where: { id: { in: byEmployee.map((r) => r.employeeId!) } }, select: { id: true, code: true, name: true, department: true } })
      : [];
    const rows = byEmployee
      .map((r) => ({ ...employees.find((e) => e.id === r.employeeId)!, amount: round2(Number(r._sum.amount ?? 0)), count: r._count._all, last: r._max.expenseDate }))
      .sort((a, b) => b.amount - a.amount);
    return {
      total: round2(rows.reduce((sum, r) => sum + r.amount, 0)),
      count: rows.reduce((sum, r) => sum + r.count, 0),
      byEmployee: rows,
      byKind: byKind
        .map((r) => ({ kind: r.subcategory ?? 'Other', amount: round2(Number(r._sum.amount ?? 0)), count: r._count._all }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  /**
   * Profit and loss for a period, day by day, week by week (Monday to Sunday), month by month or by financial year
   * (April to March), on the same rules as the overview:
   * - Earned: sales billed (taxable value, by bill date) + amounts collected on production deliveries.
   * - Spent: goods received at PO rate + expenses (machine expenses and staff payments among them) + batch costs.
   * - Profit = earned − spent. Cash in / out / net is the money that actually moved (cheques when cleared).
   * The period's rows are loaded once and bucketed here, so a year by day is still a handful of queries.
   */
  async pnl(fromIso: string, toIso: string, group: PnlGroup, tz = 0) {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from > to) throw new BadRequestException('The start date is after the end date');
    const range = { gte: from, lte: to };

    // Every bucket in the period, empty ones too, with the first and last day of the period inside it.
    const buckets = new Map<string, PnlFigures & { key: string; from: string; to: string }>();
    const lastDay = localDay(to, tz);
    for (let day = localDay(from, tz); day <= lastDay; day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) {
      const key = bucketOf(day, group);
      const bucket = buckets.get(key);
      if (bucket) bucket.to = day;
      else {
        if (buckets.size >= MAX_BUCKETS[group]) {
          throw new BadRequestException(`That is more than ${MAX_BUCKETS[group]} ${group === 'day' ? 'days' : `${group}s`}; choose a shorter period or a longer grouping`);
        }
        buckets.set(key, { key, from: day, to: day, ...emptyFigures() });
      }
    }
    const add = (date: Date, figure: keyof PnlFigures, amount: number) => {
      const bucket = buckets.get(bucketOf(localDay(date, tz), group));
      if (bucket) bucket[figure] += amount;
    };

    const [sales, deliveries, receipts, expenses, batchCosts, txns] = await Promise.all([
      this.prisma.sale.findMany({ where: { status: SaleStatus.DISPATCHED, saleDate: range }, select: { saleDate: true, subtotal: true } }),
      this.prisma.fabricFlowDelivery.findMany({ where: { destination: 'CUSTOMER', processStage: 'FINAL', deliveredAt: range }, select: { deliveredAt: true, amount: true } }),
      this.prisma.$queryRaw<Array<{ receivedAt: Date; value: number }>>`
        SELECT pr."receivedAt" AS "receivedAt", COALESCE(SUM(ri."quantity" * poi."rate"), 0)::float8 AS "value"
        FROM "PurchaseReceiptItem" ri
        JOIN "PurchaseReceipt" pr ON pr."id" = ri."purchaseReceiptId"
        JOIN "PurchaseOrderItem" poi ON poi."id" = ri."purchaseOrderItemId"
        WHERE pr."receivedAt" >= ${from} AND pr."receivedAt" <= ${to}
        GROUP BY pr."id", pr."receivedAt"`,
      this.prisma.expense.findMany({ where: { ...EXPENSE_LIVE, expenseDate: range }, select: { expenseDate: true, amount: true, machineId: true, employeeId: true } }),
      this.prisma.fabricFlowExpense.findMany({ where: { expenseDate: range }, select: { expenseDate: true, amount: true } }),
      this.prisma.moneyTransaction.findMany({
        where: { AND: [movedIn(range), { kind: { in: [MoneyTxnKind.RECEIPT, MoneyTxnKind.PAYMENT] } }] },
        select: { kind: true, mode: true, txnDate: true, clearedAt: true, amount: true },
      }),
    ]);

    for (const sale of sales) add(sale.saleDate, 'sales', Number(sale.subtotal));
    for (const d of deliveries) {
      add(d.deliveredAt, 'collected', Number(d.amount));
      add(d.deliveredAt, 'moneyIn', Number(d.amount));
    }
    for (const r of receipts) add(r.receivedAt, 'purchases', Number(r.value));
    for (const e of expenses) {
      add(e.expenseDate, 'expenses', Number(e.amount));
      add(e.expenseDate, 'moneyOut', Number(e.amount));
      if (e.machineId) add(e.expenseDate, 'machineExpenses', Number(e.amount));
      if (e.employeeId) add(e.expenseDate, 'staffPayments', Number(e.amount));
    }
    for (const c of batchCosts) add(c.expenseDate, 'batchCosts', Number(c.amount));
    for (const t of txns) add(movedOn(t), t.kind === MoneyTxnKind.RECEIPT ? 'moneyIn' : 'moneyOut', Number(t.amount));

    const rows = [...buckets.values()].map((b) => {
      const earned = b.sales + b.collected;
      const spent = b.purchases + b.expenses + b.batchCosts;
      const figures = { ...b, earned, spent, profit: earned - spent, net: b.moneyIn - b.moneyOut };
      for (const k of PNL_FIGURES) figures[k] = round2(figures[k]);
      return figures;
    });
    const totals = emptyFigures();
    for (const row of rows) for (const k of PNL_FIGURES) totals[k] = round2(totals[k] + row[k]);
    const active = rows.filter((r) => r.earned || r.spent);
    return {
      group,
      buckets: rows,
      totals,
      /** Buckets with any business, and how many of them made a profit. */
      activeBuckets: active.length,
      profitableBuckets: active.filter((r) => r.profit > 0.005).length,
      best: active.length ? active.reduce((a, b) => (b.profit > a.profit ? b : a)).key : null,
      worst: active.length ? active.reduce((a, b) => (b.profit < a.profit ? b : a)).key : null,
    };
  }
}
