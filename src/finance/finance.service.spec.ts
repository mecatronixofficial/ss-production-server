import { MoneyTxnKind, PaymentMode } from '@prisma/client';
import { FinanceService } from './finance.service';

/** India: the browser's getTimezoneOffset() is -330. */
const IST = -330;
/** A moment given as India local time. */
const ist = (local: string) => new Date(`${local}+05:30`);

function service(rows: Partial<Record<'sales' | 'deliveries' | 'receipts' | 'expenses' | 'batchCosts' | 'txns', unknown[]>> = {}) {
  const prisma = {
    sale: { findMany: jest.fn().mockResolvedValue(rows.sales ?? []) },
    fabricFlowDelivery: { findMany: jest.fn().mockResolvedValue(rows.deliveries ?? []) },
    $queryRaw: jest.fn().mockResolvedValue(rows.receipts ?? []),
    expense: { findMany: jest.fn().mockResolvedValue(rows.expenses ?? []) },
    fabricFlowExpense: { findMany: jest.fn().mockResolvedValue(rows.batchCosts ?? []) },
    moneyTransaction: { findMany: jest.fn().mockResolvedValue(rows.txns ?? []) },
  };
  return new FinanceService(prisma as never, {} as never);
}

describe('FinanceService.pnl', () => {
  it('buckets earned, spent and cash by local week, Monday to Sunday', async () => {
    const finance = service({
      sales: [{ saleDate: ist('2026-10-05T12:00:00'), subtotal: 1000 }],
      // 00:30 on Monday 5 October in India is still Sunday in UTC: it belongs to the week of the 5th.
      expenses: [
        { expenseDate: ist('2026-10-05T00:30:00'), amount: 200, machineId: 'm1', employeeId: null },
        // A daily wage given to an employee.
        { expenseDate: ist('2026-10-12T18:00:00'), amount: 40, machineId: null, employeeId: 'e1' },
      ],
      receipts: [{ receivedAt: ist('2026-10-01T11:00:00'), value: 300 }],
      deliveries: [{ deliveredAt: ist('2026-10-13T10:00:00'), amount: 150 }],
      batchCosts: [{ expenseDate: ist('2026-10-13T12:00:00'), amount: 50 }],
      txns: [
        { kind: MoneyTxnKind.RECEIPT, mode: PaymentMode.CASH, txnDate: ist('2026-10-12T12:00:00'), clearedAt: null, amount: 500 },
        // A cheque counts on the day it cleared, not the day it was written.
        { kind: MoneyTxnKind.PAYMENT, mode: PaymentMode.CHEQUE, txnDate: ist('2026-10-02T12:00:00'), clearedAt: ist('2026-10-13T12:00:00'), amount: 100 },
      ],
    });
    const result = await finance.pnl(ist('2026-10-01T00:00:00').toISOString(), ist('2026-10-14T23:59:59.999').toISOString(), 'week', IST);

    expect(result.buckets.map((b) => [b.key, b.from, b.to])).toEqual([
      ['2026-09-28', '2026-10-01', '2026-10-04'],
      ['2026-10-05', '2026-10-05', '2026-10-11'],
      ['2026-10-12', '2026-10-12', '2026-10-14'],
    ]);
    const [first, second, third] = result.buckets;
    expect(first).toMatchObject({ purchases: 300, spent: 300, profit: -300 });
    expect(second).toMatchObject({ sales: 1000, expenses: 200, machineExpenses: 200, earned: 1000, spent: 200, profit: 800, moneyOut: 200 });
    expect(third).toMatchObject({ collected: 150, batchCosts: 50, expenses: 40, staffPayments: 40, earned: 150, spent: 90, profit: 60, moneyIn: 650, moneyOut: 140, net: 510 });
    expect(result.totals).toMatchObject({ earned: 1150, spent: 590, profit: 560, staffPayments: 40, machineExpenses: 200, moneyIn: 650, moneyOut: 340 });
    expect(result).toMatchObject({ activeBuckets: 3, profitableBuckets: 2, best: '2026-10-05', worst: '2026-09-28' });
  });

  it('groups by financial year, April to March', async () => {
    const finance = service({
      sales: [
        { saleDate: ist('2026-03-31T12:00:00'), subtotal: 100 },
        { saleDate: ist('2026-04-01T12:00:00'), subtotal: 200 },
      ],
    });
    const result = await finance.pnl(ist('2026-01-01T00:00:00').toISOString(), ist('2026-12-31T23:59:59.999').toISOString(), 'year', IST);
    expect(result.buckets.map((b) => [b.key, b.from, b.to, b.sales])).toEqual([
      ['2025', '2026-01-01', '2026-03-31', 100],
      ['2026', '2026-04-01', '2026-12-31', 200],
    ]);
  });

  it('refuses a table too long to read', async () => {
    await expect(service().pnl('2020-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'day', 0)).rejects.toThrow('more than 400 days');
  });
});
