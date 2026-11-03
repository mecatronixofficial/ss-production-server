import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { InventoryService } from './inventory.service';
import { bagTotal, YarnReceiptsService } from './yarn-receipts.service';

const user: AuthUser = { id: 'staff', name: 'Staff', email: 'staff@example.com', role: 'STAFF' };

describe('bags as written on a DC', () => {
  it('adds up "30+9" and reads a plain count', () => {
    expect(bagTotal('30+9')).toBe(39);
    expect(bagTotal(' 12 ')).toBe(12);
    expect(bagTotal('')).toBeNull();
    expect(bagTotal(undefined)).toBeNull();
  });
});

describe('Yarn received register', () => {
  const setup = () => {
    let sequence = 0;
    const lines: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([{ value: ++sequence }])),
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh' }) },
      yarnReceipt: {
        create: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'yr', ...data })),
        findUniqueOrThrow: jest.fn().mockImplementation(() => Promise.resolve({ id: 'yr', lines, warehouse: { id: 'wh', code: 'YRN', name: 'Yarn store' } })),
      },
      yarnReceiptLine: {
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          lines.push({ id: `line-${lines.length + 1}`, ...data });
          return Promise.resolve(lines[lines.length - 1]);
        }),
      },
      auditLog: { create: jest.fn() },
    };
    const inventory = { createTxn: jest.fn().mockImplementation((data: { itemCode: string }) => Promise.resolve({ id: `txn-${data.itemCode}` })) };
    const db = {
      $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
      // Its stock movements went on one received challan.
      stockTransaction: { findMany: jest.fn().mockResolvedValue([{ id: 'txn-02SS26', stockBill: { id: 'bill', billNo: 'RCV-2026-000004', cancelledAt: null } }]) },
    };
    const service = new YarnReceiptsService(db as unknown as PrismaService, inventory as unknown as InventoryService);
    return { service, tx, inventory, lines };
  };

  it('puts each count of a DC into stock under its own yarn code, with bags and the mill on it', async () => {
    const { service, inventory, lines, tx } = setup();
    const saved = await service.create(
      {
        receivedAt: '2026-10-10',
        dcNo: '577',
        millName: 'NAVEEN MILL',
        agentName: 'Direct',
        warehouseId: '00000000-0000-0000-0000-000000000001',
        lines: [
          { count: "20'S G-M", bags: '5', weightKg: 300, ratePerKg: 210 },
          { count: "20'S C-M", bags: '3', weightKg: 180, ratePerKg: 205 },
        ],
      },
      user,
      { prices: false },
    );
    // Direct from the mill: no agent.
    expect(tx.yarnReceipt.create.mock.calls[0][0].data).toMatchObject({ dcNo: '577', millName: 'NAVEEN MILL', agentName: null });
    expect(lines.map((l) => [l.count, l.bags, l.bagCount, l.weightKg, l.itemCode, l.ratePerKg])).toEqual([
      ["20'S G-M", '5', 5, 300, '02SS26', null],
      ["20'S C-M", '3', 3, 180, '03SS26', null],
    ]);
    // Its received challan, to print.
    expect(saved.challan).toEqual({ id: 'bill', no: 'RCV-2026-000004' });
    expect(inventory.createTxn.mock.calls[0][0]).toMatchObject({ category: 'YARN', txnType: 'PURCHASE_IN', itemCode: '02SS26', itemName: "20'S G-M", quantityIn: 300, referenceType: 'YARN_RECEIPT', notes: 'DC 577 · NAVEEN MILL · 5 bags' });
  });

  it('lists a month with yarn received on purchase orders too, and totals by count and mill', async () => {
    const receivedAt = new Date('2026-10-06');
    const db = {
      yarnReceipt: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'yr1',
            receiptNo: 'YR-2026-000001',
            receivedAt,
            dcNo: '574',
            millName: 'CHERAN MILL',
            agentName: null,
            warehouse: { id: 'wh', code: 'YRN', name: 'Yarn store' },
            vehicleNo: null,
            notes: null,
            lines: [{ id: 'l1', count: "36'S VL", bags: '30+9', bagCount: 39, weightKg: new Prisma.Decimal(1825), ratePerKg: new Prisma.Decimal(260), itemCode: '01SS26' }],
          },
        ]),
      },
      purchaseReceipt: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'grn',
            receiptNo: 'GRN-2026-000004',
            receivedAt: new Date('2026-10-21'),
            challanNo: '578',
            vehicleNo: null,
            notes: null,
            warehouse: { id: 'wh', code: 'YRN', name: 'Yarn store' },
            purchaseOrder: { poNo: 'PO-2026-000002', supplier: { name: 'Cheran Mill' } },
            items: [{ id: 'gi', quantity: new Prisma.Decimal(1140), purchaseOrderItem: { itemName: "36's vl", itemCode: '05SS26', rate: new Prisma.Decimal(255), unit: 'KG' } }],
          },
        ]),
      },
      fabricProductionFlow: {
        findMany: jest.fn().mockResolvedValue([
          { flowNo: '01SS26-KT01', yarnItemCode: '01SS26', status: 'DYEING', fabricType: 'Single jersey', fabricDiameter: '30', fabricGsm: '180', knittingMillType: 'OWN', knittingMillDetails: 'KN-01', knittingDate: new Date('2026-10-08'), knittingFinishedAt: new Date('2026-10-12'), purchasedWeightKg: 975, yarnReceivedKg: 1000, knittingDeliveryKg: 960, dyeingDeliveryKg: 960, _count: { lots: 2 } },
        ]),
      },
      stockTransaction: {
        groupBy: jest.fn().mockResolvedValue([
          { itemCode: '01SS26', txnType: 'PURCHASE_IN', _sum: { quantityIn: 1825, quantityOut: 0 } },
          { itemCode: '01SS26', txnType: 'KNITTING_ISSUE', _sum: { quantityIn: 0, quantityOut: 1000 } },
          { itemCode: '01SS26', txnType: 'KNITTING_RETURN', _sum: { quantityIn: 25, quantityOut: 0 } },
        ]),
      },
    };
    const service = new YarnReceiptsService(db as unknown as PrismaService, {} as InventoryService);
    const result = await service.register({ month: '2026-10' }, { prices: true });
    expect(result.rows.map((r) => [r.source, r.dcNo, r.mill, r.count, r.bagCount, r.weightKg, r.itemCode, r.amount])).toEqual([
      ['REGISTER', '574', 'CHERAN MILL', "36'S VL", 39, 1825, '01SS26', 474500],
      ['PURCHASE', '578', 'Cheran Mill', "36's vl", null, 1140, '05SS26', 290700],
    ]);
    expect(result.rows[0]).toMatchObject({ inStockKg: 850, toKnittingKg: 975, returnedKg: 25 });
    expect(result.rows[0].knitting).toEqual([
      { flowNo: '01SS26-KT01', fabric: 'Single jersey · 30 dia · 180 GSM', mill: 'Own mill', startedAt: new Date('2026-10-08'), done: true, yarnKg: 975, fabricKg: 960, colours: 2 },
    ]);
    expect(result.summary).toMatchObject({ deliveries: 2, lines: 2, weightKg: 2965, bags: 39, amount: 765200, returnedKg: 25, codes: { inStock: 0, partly: 1, used: 0 } });
    expect(result.summary.byCount).toEqual([{ name: "36'S VL", kg: 2965, bags: 39, lines: 2, deliveries: 2 }]);
    expect(result.summary.byMill).toEqual([{ name: 'CHERAN MILL', kg: 2965, bags: 39, lines: 2, deliveries: 2 }]);
  });

  it('hides rates from the godown', async () => {
    const db = {
      yarnReceipt: { findMany: jest.fn().mockResolvedValue([]) },
      purchaseReceipt: { findMany: jest.fn().mockResolvedValue([]) },
      stockTransaction: { groupBy: jest.fn() },
    };
    const all = new YarnReceiptsService(db as unknown as PrismaService, {} as InventoryService);
    await all.register({}, { prices: false });
    // Every yarn ever received: no date limit.
    expect(db.yarnReceipt.findMany.mock.calls[0][0].where).toEqual({});
    const service = new YarnReceiptsService(db as unknown as PrismaService, {} as InventoryService);
    expect((await service.register({ month: '2026-10' }, { prices: false })).summary.amount).toBeNull();
    await expect(service.register({ month: 'Oct' }, { prices: false })).rejects.toThrow('YYYY-MM');
    await expect(service.register({ from: '01/10/2026' }, { prices: false })).rejects.toThrow('YYYY-MM-DD');
  });
});
