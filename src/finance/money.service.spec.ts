import { BadRequestException } from '@nestjs/common';
import { PaymentMode } from '@prisma/client';
import { MoneyService } from './money.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';

// SQL comparisons with NULL evaluate to UNKNOWN, including NOT (NULL = 'BOUNCED').
// Model that here so a fake database cannot hide nullable-column payment bugs.
type Truth = boolean | null;
function matches(row: Record<string, unknown>, where: Record<string, any>): Truth {
  const and = (values: Truth[]): Truth => (values.includes(false) ? false : values.includes(null) ? null : true);
  const or = (values: Truth[]): Truth => (values.includes(true) ? true : values.includes(null) ? null : false);
  return and(
    Object.entries(where).map(([key, value]): Truth => {
      if (key === 'AND') return and((Array.isArray(value) ? value : [value]).map((part) => matches(row, part)));
      if (key === 'OR') return or(value.map((part: Record<string, unknown>) => matches(row, part)));
      if (key === 'NOT') {
        const result = matches(row, value);
        return result === null ? null : !result;
      }
      const actual = row[key];
      if (value === null) return actual === null;
      if (value && typeof value === 'object') {
        if (actual === null) return null;
        if ('not' in value) return actual !== value.not;
        if ('in' in value) return value.in.includes(actual);
      }
      return actual === null ? null : actual === value;
    }),
  );
}

const user: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' };

describe('Sale bill receipts', () => {
  const setup = (mode: PaymentMode, chequeStatus: string | null, cancelledAt: Date | null = null) => {
    const prior = { saleId: 'sale', kind: 'RECEIPT', cancelledAt, mode, chequeStatus, amount: 80 };
    const sale = {
      id: 'sale',
      saleNo: 'SAL-1',
      status: 'DISPATCHED',
      partyType: 'DISTRIBUTOR',
      supplierId: 'supplier',
      textileId: null,
      partyName: 'Distributor',
      totalAmount: 100,
    };
    const total = (where: Record<string, unknown>) => (matches(prior, where) === true ? prior.amount : 0);
    const create = jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...data, id: 'receipt', cancelledAt: null, account: { name: 'Cash' }, sale }),
    );
    const db = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ value: 1 }]),
      moneyAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'cash', name: 'Cash', type: 'CASH', active: true }) },
      sale: { findUnique: jest.fn().mockResolvedValue(sale), findUniqueOrThrow: jest.fn().mockResolvedValue(sale) },
      moneyTransaction: {
        aggregate: ({ where }: { where: Record<string, unknown> }) => Promise.resolve({ _sum: { amount: total(where) } }),
        groupBy: ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(total(where) ? [{ saleId: 'sale', _sum: { amount: total(where) } }] : []),
        create,
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: <T>(fn: (client: unknown) => Promise<T>) => fn(db),
    };
    return { service: new MoneyService(db as unknown as PrismaService), create };
  };

  it.each([
    ['CASH', null],
    ['UPI', null],
    ['BANK', null],
    ['CHEQUE', 'PENDING'],
    ['CHEQUE', 'DEPOSITED'],
    ['CHEQUE', 'CLEARED'],
  ] as const)('counts existing %s / %s receipts before accepting more money', async (mode, status) => {
    const { service, create } = setup(mode, status);
    await expect(
      service.create({ kind: 'RECEIPT', txnDate: '2026-10-01', mode: 'CASH', amount: 30, accountId: 'cash', saleId: 'sale' }, user),
    ).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['CHEQUE', 'BOUNCED', null],
    ['CASH', null, new Date()],
  ] as const)('does not count bounced or cancelled receipts (%s)', async (mode, status, cancelledAt) => {
    const { service, create } = setup(mode, status, cancelledAt);
    await service.create({ kind: 'RECEIPT', txnDate: '2026-10-01', mode: 'CASH', amount: 30, accountId: 'cash', saleId: 'sale' }, user);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('allows the exact remaining balance after a cash receipt', async () => {
    const { service, create } = setup('CASH', null);
    await service.create({ kind: 'RECEIPT', txnDate: '2026-10-01', mode: 'CASH', amount: 20, accountId: 'cash', saleId: 'sale' }, user);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
