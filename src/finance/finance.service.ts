import { BadRequestException, Injectable } from '@nestjs/common';
import { SalePartyType, SaleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cashFlow, EXPENSE_LIVE, paidToDistributors, round2, thisMonth } from './money-rules';
import { MoneyService } from './money.service';

const MAX_MONTHS = 24;

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
   * - Month by month cash flow, and expenses by category.
   */
  async overview(fromIso: string, toIso: string) {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from > to) throw new BadRequestException('The start date is after the end date');
    const range = { gte: from, lte: to };

    const months: Array<{ key: string; from: Date; to: Date }> = [];
    for (
      let d = new Date(from.getFullYear(), from.getMonth(), 1);
      d <= to && months.length < MAX_MONTHS;
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
    ) {
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        from: d < from ? from : d,
        to: end > to ? to : end,
      });
    }

    const [flow, sales, salesByParty, purchases, expenseByCategory, batchCosts, parties, accounts, monthly] = await Promise.all([
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
      this.money.parties(),
      this.money.accounts(),
      Promise.all(months.map(async (m) => ({ month: m.key, ...(await cashFlow(this.prisma, m.from, m.to)) }))),
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
      months: monthly.map((m) => ({
        month: m.month,
        moneyIn: m.moneyIn,
        moneyOut: m.moneyOut,
        net: m.net,
        received: m.receivedTotal,
        collected: m.collected,
        paid: m.paidTotal,
        expenses: m.expenses,
      })),
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
}
