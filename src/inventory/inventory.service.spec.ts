import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { GodownEntryDto } from './dto/godown-entry.dto';
import { GODOWN_ENTRY, InventoryService } from './inventory.service';
import { StockBillsService } from './stock-bills.service';

type Row = Record<string, unknown> & { id: string; quantityIn: number; quantityOut: number; createdAt: Date };

/** Just enough of Prisma for the godown entry paths, with transactions that roll back on error. */
function fakePrisma() {
  let rows: Row[] = [];
  let bills: Array<Record<string, unknown> & { id: string }> = [];
  let seq = 0;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object') {
        if ('equals' in value) return String(row[key]).toLowerCase() === String((value as { equals: string }).equals).toLowerCase();
        if ('gt' in value) return Number(row[key]) > Number((value as { gt: number }).gt);
        if ('in' in value) return (value as { in: unknown[] }).in.includes(row[key]);
      }
      return (row[key] ?? null) === value;
    });
  const db = {
    $executeRaw: () => Promise.resolve(1),
    $queryRaw: () => Promise.resolve([{ value: ++seq }]),
    warehouse: { findUnique: ({ where }: { where: { id: string } }) => Promise.resolve(where.id === 'wh-1' ? { active: true } : null) },
    auditLog: { create: () => Promise.resolve({}) },
    purchaseReceipt: { findMany: () => Promise.resolve([]) },
    stockTransaction: {
      aggregate: ({ where }: { where: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        return Promise.resolve({
          _sum: { quantityIn: hit.reduce((s, r) => s + r.quantityIn, 0), quantityOut: hit.reduce((s, r) => s + r.quantityOut, 0) },
        });
      },
      findUnique: ({ where }: { where: { id: string } }) => Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      findFirst: ({ where }: { where: Record<string, unknown> }) => Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      create: ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
        const row = { createdAt: new Date(), ...data, id: `t${rows.length + 1}` } as Row;
        rows.push(row);
        return Promise.resolve(row);
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      delete: ({ where }: { where: { id: string } }) => {
        rows = rows.filter((r) => r.id !== where.id);
        return Promise.resolve({});
      },
      findMany: ({ where }: { where: Record<string, unknown> }) => Promise.resolve(rows.filter((r) => matches(r, where))),
      updateMany: ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: hit.length });
      },
      deleteMany: ({ where }: { where: Record<string, unknown> }) => {
        rows = rows.filter((r) => !matches(r, where));
        return Promise.resolve({});
      },
    },
    stockBill: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const bill = { ...data, id: `b${bills.length + 1}`, cancelledAt: null, createdAt: new Date() };
        bills.push(bill);
        return Promise.resolve(bill);
      },
      findUnique: ({ where }: { where: { id: string } }) => Promise.resolve(bills.find((b) => b.id === where.id) ?? null),
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const bill = bills.find((b) => b.id === where.id)!;
        Object.assign(bill, data);
        return Promise.resolve(bill);
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const snapshot = rows.map((r) => ({ ...r }));
      const billSnapshot = bills.map((b) => ({ ...b }));
      try {
        // A transaction client of its own, as Prisma gives one per transaction.
        return await fn({ ...db });
      } catch (error) {
        rows = snapshot;
        bills = billSnapshot;
        throw error;
      }
    },
    rows: () => rows,
    bills: () => bills,
  };
  return db;
}

const user: AuthUser = { id: 'u1', email: 'staff@example.com', name: 'Staff', role: 'STAFF' };
const entry = (overrides: Partial<GodownEntryDto> = {}): GodownEntryDto => ({
  direction: 'IN',
  category: 'YARN',
  txnType: 'PURCHASE_IN',
  itemName: '30s Combed Cotton',
  warehouseId: 'wh-1',
  quantityKg: 100,
  ...overrides,
});

describe('Godown entries', () => {
  let db: ReturnType<typeof fakePrisma>;
  let service: InventoryService;
  const stock = () => db.rows().reduce((sum, r) => sum + r.quantityIn - r.quantityOut, 0);

  beforeEach(() => {
    db = fakePrisma();
    const prisma = db as unknown as PrismaService;
    service = new InventoryService(prisma, new StockBillsService(prisma));
  });

  it('records stock in with a document number and a code derived from the name', async () => {
    const txn = await service.createEntry(entry(), user);
    expect(txn).toMatchObject({ itemCode: '30S-COMBED-COTTON', referenceType: GODOWN_ENTRY, quantityIn: 100, quantityOut: 0 });
    expect(txn.referenceId).toMatch(/^GD-\d{4}-000001$/);
  });

  it('reuses the code of an existing item with the same name', async () => {
    await service.createEntry(entry({ itemCode: 'YARN-30S' }), user);
    const txn = await service.createEntry(entry({ itemName: '30S COMBED COTTON' }), user);
    expect(txn.itemCode).toBe('YARN-30S');
  });

  it('issues stock out up to the balance and rejects more', async () => {
    await service.createEntry(entry(), user);
    await service.createEntry(entry({ direction: 'OUT', txnType: 'PRODUCTION_ISSUE', quantityKg: 60 }), user);
    await expect(service.createEntry(entry({ direction: 'OUT', txnType: 'PRODUCTION_ISSUE', quantityKg: 41 }), user)).rejects.toThrow(
      BadRequestException,
    );
    expect(stock()).toBe(40);
  });

  it('rejects a reason that does not fit the direction', async () => {
    await expect(service.createEntry(entry({ txnType: 'WASTE' }), user)).rejects.toThrow('not a valid IN entry type');
  });

  it('edits a manual entry but not below what was already issued', async () => {
    const received = await service.createEntry(entry(), user);
    await service.createEntry(entry({ direction: 'OUT', txnType: 'PRODUCTION_ISSUE', quantityKg: 60 }), user);
    await service.updateEntry(received.id, entry({ quantityKg: 80 }), user);
    expect(stock()).toBe(20);
    await expect(service.updateEntry(received.id, entry({ quantityKg: 50 }), user)).rejects.toThrow('Not enough stock');
    expect(stock()).toBe(20);
  });

  it('corrects and deletes movements posted by other modules, keeping their type', async () => {
    const posted = await db.stockTransaction.create({
      data: { category: 'YARN', txnType: 'PURCHASE_IN', itemCode: 'Y1', itemName: 'Y1', lotNo: null, warehouseId: 'wh-1', quantityIn: 10, quantityOut: 0, referenceType: 'PURCHASE_RECEIPT' },
    });
    const fixed = await service.updateEntry(posted.id, entry({ itemCode: 'Y1', itemName: 'Y1', txnType: 'PURCHASE_IN', quantityKg: 12 }), user);
    expect(fixed).toMatchObject({ quantityIn: 12, referenceType: 'PURCHASE_RECEIPT' });
    await expect(service.updateEntry(posted.id, entry({ txnType: 'KNITTING_ISSUE' }), user)).rejects.toThrow('not a valid IN entry type');
    await service.deleteEntry(posted.id, user);
    expect(db.rows()).toHaveLength(0);
  });

  it('blocks deleting stock that has already been issued', async () => {
    const received = await service.createEntry(entry(), user);
    await service.createEntry(entry({ direction: 'OUT', txnType: 'PRODUCTION_ISSUE', quantityKg: 60 }), user);
    await expect(service.deleteEntry(received.id, user)).rejects.toThrow('Not enough stock');
    expect(stock()).toBe(40);
  });

  it('lets old negative positions be improved', async () => {
    await db.stockTransaction.create({
      data: { category: 'YARN', txnType: 'DISPATCH_OUT', itemCode: 'Y1', itemName: 'Y1', lotNo: null, warehouseId: 'wh-1', quantityIn: 0, quantityOut: 50, referenceType: 'DISPATCH' },
    });
    await service.createEntry(entry({ itemCode: 'Y1', itemName: 'Y1', quantityKg: 20 }), user);
    expect(stock()).toBe(-30);
  });

  describe('challans', () => {
    const live = () => db.bills().filter((b) => !b.cancelledAt);

    it('puts stock in on a received challan and stock out on an export challan', async () => {
      const received = await service.createEntry(entry(), user);
      const issued = await service.createEntry(entry({ direction: 'OUT', txnType: 'PRODUCTION_ISSUE', quantityKg: 30 }), user);
      const bills = db.bills();
      expect(bills).toHaveLength(2);
      expect(bills[0]).toMatchObject({ kind: 'RECEIVED', billNo: expect.stringMatching(/^RCV-/), referenceId: received.referenceId });
      expect(bills[1]).toMatchObject({ kind: 'EXPORT', billNo: expect.stringMatching(/^EXP-/), referenceId: issued.referenceId });
      expect(db.rows().every((r) => r.stockBillId)).toBe(true);
    });

    it('puts every line one operation moves on the same challan', async () => {
      const prisma = db as unknown as PrismaService;
      await prisma.$transaction(async (tx) => {
        for (const itemCode of ['Y1', 'Y2', 'Y3']) {
          await service.createTxn({ category: 'YARN', txnType: 'PURCHASE_IN', itemCode, itemName: itemCode, warehouseId: 'wh-1', quantityIn: 10, referenceType: 'PURCHASE_RECEIPT', referenceId: 'grn-1' }, tx);
        }
      });
      expect(db.bills()).toHaveLength(1);
      expect(new Set(db.rows().map((r) => r.stockBillId))).toEqual(new Set(['b1']));
    });

    it('cancels and replaces the challan when its movement is corrected', async () => {
      const received = await service.createEntry(entry(), user);
      await service.updateEntry(received.id, entry({ quantityKg: 80 }), user);
      const [old, replacement] = db.bills();
      expect(old.cancelledAt).toBeInstanceOf(Date);
      expect(old.cancelReason).toContain('corrected');
      expect(replacement).toMatchObject({ kind: 'RECEIVED', cancelledAt: null });
      expect(db.rows()[0]).toMatchObject({ quantityIn: 80, stockBillId: replacement.id });
    });

    it('cancels the challan when its only movement is deleted', async () => {
      const received = await service.createEntry(entry(), user);
      await service.deleteEntry(received.id, user);
      expect(live()).toHaveLength(0);
      expect(db.bills()[0].cancelReason).toContain('deleted');
    });
  });
});
