import { ChequeStatus, MoneyAccountType, MoneyTxnKind, PaymentMode, Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The rules every money figure in the ERP follows (Money page, Finance, Distributors, Sales, Reports):
 * an entry counts when it is not cancelled and is not a cheque, or is a cheque that has cleared. Cheques still
 * to clear are shown separately as pending; bounced and cancelled entries never count.
 */
export const COUNTED: Prisma.MoneyTransactionWhereInput = {
  cancelledAt: null,
  OR: [{ mode: { not: PaymentMode.CHEQUE } }, { chequeStatus: ChequeStatus.CLEARED }],
};

/** Cheques given or received that have not cleared or bounced yet. */
export const CHEQUE_OPEN: Prisma.MoneyTransactionWhereInput = {
  cancelledAt: null,
  mode: PaymentMode.CHEQUE,
  chequeStatus: { in: [ChequeStatus.PENDING, ChequeStatus.DEPOSITED] },
};

export const counts = (t: { cancelledAt: Date | null; mode: PaymentMode; chequeStatus: ChequeStatus | null }) =>
  !t.cancelledAt && (t.mode !== PaymentMode.CHEQUE || t.chequeStatus === ChequeStatus.CLEARED);

export const isOpenCheque = (t: { cancelledAt: Date | null; mode: PaymentMode; chequeStatus: ChequeStatus | null }) =>
  !t.cancelledAt && t.mode === PaymentMode.CHEQUE && (t.chequeStatus === ChequeStatus.PENDING || t.chequeStatus === ChequeStatus.DEPOSITED);

/** Which accounts each way of paying can go through: cash into cash in hand, UPI into a UPI or bank account, the rest into a bank. */
export const ACCOUNT_TYPES_FOR: Record<PaymentMode, MoneyAccountType[]> = {
  CASH: [MoneyAccountType.CASH],
  UPI: [MoneyAccountType.UPI, MoneyAccountType.BANK],
  BANK: [MoneyAccountType.BANK],
  CHEQUE: [MoneyAccountType.BANK],
};

export const TXN_PREFIX: Record<MoneyTxnKind, string> = { RECEIPT: 'RCP', PAYMENT: 'PAY', TRANSFER: 'TRF' };

export const round2 = (value: number) => Math.round(value * 100) / 100;

/** "  Sri  Murugan Tex " → "Sri Murugan Tex": the form textile names are stored in. */
export const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');
/** Textiles have no master: everything under the same name (any case or spacing) is one textile. */
export const nameKey = (name: string) => cleanName(name).toLowerCase();

/** Pays to distributors that count (by distributor). Shared by Finance, Distributors and the Distributor report. */
export async function paidToDistributors(db: Db, where: Prisma.MoneyTransactionWhereInput = {}) {
  const rows = await db.moneyTransaction.groupBy({
    by: ['supplierId'],
    where: { AND: [COUNTED, { kind: MoneyTxnKind.PAYMENT, supplierId: { not: null } }, where] },
    _sum: { amount: true },
    _max: { txnDate: true },
  });
  return new Map(rows.map((row) => [row.supplierId!, { amount: Number(row._sum.amount ?? 0), last: row._max.txnDate }]));
}

/**
 * Money received against each sale bill: `received` counts (cleared), `pending` is in cheques still to clear.
 * `due` is what is left of the bill; a bill not yet dispatched is shown against what was entered.
 */
export async function saleMoney(db: Db, saleIds: string[]) {
  if (!saleIds.length) return new Map<string, { received: number; pending: number }>();
  const [counted, open] = await Promise.all([
    db.moneyTransaction.groupBy({
      by: ['saleId'],
      where: { AND: [COUNTED, { kind: MoneyTxnKind.RECEIPT, saleId: { in: saleIds } }] },
      _sum: { amount: true },
    }),
    db.moneyTransaction.groupBy({
      by: ['saleId'],
      where: { AND: [CHEQUE_OPEN, { kind: MoneyTxnKind.RECEIPT, saleId: { in: saleIds } }] },
      _sum: { amount: true },
    }),
  ]);
  const result = new Map<string, { received: number; pending: number }>();
  for (const row of counted) result.set(row.saleId!, { received: Number(row._sum.amount ?? 0), pending: 0 });
  for (const row of open)
    result.set(row.saleId!, { received: result.get(row.saleId!)?.received ?? 0, pending: Number(row._sum.amount ?? 0) });
  return result;
}

/**
 * Entries whose money moved within a period: cash / UPI / bank on their date, a cheque on the day it cleared
 * (a cheque received in March that clears in April is April's money).
 */
export const movedIn = (range?: Prisma.DateTimeFilter): Prisma.MoneyTransactionWhereInput =>
  range
    ? {
        cancelledAt: null,
        OR: [
          { mode: { not: PaymentMode.CHEQUE }, txnDate: range },
          { mode: PaymentMode.CHEQUE, chequeStatus: ChequeStatus.CLEARED, clearedAt: range },
        ],
      }
    : COUNTED;

/** When an entry's money moved: the clearing day for a cheque. */
export const movedOn = (t: { mode: PaymentMode; txnDate: Date; clearedAt: Date | null }) =>
  t.mode === PaymentMode.CHEQUE && t.clearedAt ? t.clearedAt : t.txnDate;

/** Expenses that count: not cancelled. */
export const EXPENSE_LIVE: Prisma.ExpenseWhereInput = { cancelledAt: null };

export type ModeTotal = { mode: PaymentMode; amount: number; count: number };

/**
 * Money in and out over a period, the one calculation behind the Money page, Finance, the Dashboard and the
 * Monthly report, so they always agree.
 * - In: money received (sales, advances, other) + amounts collected on production deliveries (recorded on the
 *   Production page, not in any account).
 * - Out: every payment (distributors, others) + expenses.
 */
export async function cashFlow(db: Db, from: Date, to: Date) {
  const range = { gte: from, lte: to };
  const [byMode, distributorPaid, expenses, deliveries] = await Promise.all([
    db.moneyTransaction.groupBy({
      by: ['kind', 'mode'],
      where: { AND: [movedIn(range), { kind: { in: [MoneyTxnKind.RECEIPT, MoneyTxnKind.PAYMENT] } }] },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    db.moneyTransaction.aggregate({
      where: { AND: [movedIn(range), { kind: MoneyTxnKind.PAYMENT, supplierId: { not: null } }] },
      _sum: { amount: true },
    }),
    db.expense.aggregate({ where: { ...EXPENSE_LIVE, expenseDate: range }, _sum: { amount: true }, _count: { _all: true } }),
    db.fabricFlowDelivery.aggregate({
      where: { destination: 'CUSTOMER', processStage: 'FINAL', deliveredAt: range },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);
  const modes = (kind: MoneyTxnKind): ModeTotal[] =>
    Object.values(PaymentMode).map((mode) => {
      const row = byMode.find((r) => r.kind === kind && r.mode === mode);
      return { mode, amount: round2(Number(row?._sum.amount ?? 0)), count: row?._count._all ?? 0 };
    });
  const received = modes(MoneyTxnKind.RECEIPT);
  const paid = modes(MoneyTxnKind.PAYMENT);
  const receivedTotal = round2(received.reduce((s, r) => s + r.amount, 0));
  const paidTotal = round2(paid.reduce((s, r) => s + r.amount, 0));
  const collected = round2(Number(deliveries._sum.amount ?? 0));
  const supplierPaid = round2(Number(distributorPaid._sum.amount ?? 0));
  const expenseTotal = round2(Number(expenses._sum.amount ?? 0));
  const moneyIn = round2(receivedTotal + collected);
  const moneyOut = round2(paidTotal + expenseTotal);
  return {
    from,
    to,
    received,
    paid,
    receivedTotal,
    paidTotal,
    /** Collected on production deliveries (Production page). */
    collected,
    deliveries: deliveries._count._all,
    supplierPaid,
    otherPaid: round2(paidTotal - supplierPaid),
    expenses: expenseTotal,
    expenseCount: expenses._count._all,
    moneyIn,
    moneyOut,
    net: round2(moneyIn - moneyOut),
  };
}
export type CashFlow = Awaited<ReturnType<typeof cashFlow>>;

/** First and last moment of the current calendar month (server time). */
export function thisMonth(now = new Date()) {
  return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999) };
}

export type SalePaymentStatus = 'PAID' | 'PART_PAID' | 'UNPAID' | 'CHEQUE_PENDING';

/** How much of a bill is paid. */
export function salePayment(total: number, money?: { received: number; pending: number }) {
  const received = round2(money?.received ?? 0);
  const pending = round2(money?.pending ?? 0);
  const due = round2(Math.max(0, total - received));
  const status: SalePaymentStatus =
    due < 0.005
      ? 'PAID'
      : received + pending >= total - 0.005
        ? 'CHEQUE_PENDING'
        : received > 0.005 || pending > 0.005
          ? 'PART_PAID'
          : 'UNPAID';
  return { received, pending, due, status };
}
