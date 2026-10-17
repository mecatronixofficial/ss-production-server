import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from './search.service';

/** Every lookup returns one row; `asked` records which tables were searched. */
function fakePrisma() {
  const asked = new Set<string>();
  const table = (name: string, row: Record<string, unknown>) => ({
    findMany: () => {
      asked.add(name);
      return Promise.resolve([row]);
    },
    groupBy: () => {
      asked.add(name);
      return Promise.resolve([{ itemCode: 'SS-2026-003', category: 'YARN', unit: 'KG', _sum: { quantityIn: 500, quantityOut: 200 }, _max: { createdAt: new Date() } }]);
    },
  });
  const day = new Date('2026-10-01');
  const db = {
    stockTransaction: table('stockTransaction', { itemCode: 'SS-2026-003', itemName: '30s combed cotton' }),
    purchaseOrderItem: table('purchaseOrderItem', { itemCode: 'SS-2026-003', itemName: '30s combed cotton', category: 'YARN' }),
    fabricProductionFlow: table('fabricProductionFlow', { flowNo: 'SS-2026-003-D1', status: 'DYEING', fabricType: 'Single jersey', fabricDiameter: '22 DIA', fabricGsm: '180', color: 'Navy', purchasedWeightKg: 240 }),
    knittingRun: table('knittingRun', { runNo: 'SS-2026-014', status: 'FINISHED', fabricType: 'Rib', yarnKg: 240, outputKg: 238, machine: { code: 'M-03' } }),
    machine: table('machine', { id: 'm1', code: 'M-03', name: 'Circular 3', status: 'IDLE', type: null }),
    sale: table('sale', { id: 's1', saleNo: 'SAL-2026-000001', challanNo: null, partyName: 'Sri Murugan', status: 'PENDING', totalAmount: 1000, saleDate: day }),
    purchaseOrder: table('purchaseOrder', { id: 'p1', poNo: 'PUR-2026-000001', status: 'ORDERED', orderDate: day, supplier: { name: 'Kumar Yarns' } }),
    purchaseReceipt: table('purchaseReceipt', { id: 'r1', receiptNo: 'GRN-2026-000001', challanNo: null, receivedAt: day, purchaseOrder: { poNo: 'PUR-2026-000001', supplier: { name: 'Kumar Yarns' } } }),
    stockBill: table('stockBill', { id: 'b1', billNo: 'RCV-2026-000001', kind: 'RECEIVED', partyName: null, createdAt: day, cancelledAt: null, warehouse: { code: 'WH1' } }),
    supplier: table('supplier', { id: 'd1', code: 'DST-00001', name: 'Kumar Yarns', mobile: null }),
    textile: table('textile', { id: 't1', code: 'TXT-00001', name: 'Sri Murugan', mobile: null }),
    warehouse: table('warehouse', { id: 'w1', code: 'WH1', name: 'Main godown', location: null }),
  };
  return { prisma: db as unknown as PrismaService, asked };
}

describe('SearchService', () => {
  it('finds nothing for one letter', async () => {
    const { prisma, asked } = fakePrisma();
    expect(await new SearchService(prisma).search('S', 'ADMIN')).toEqual([]);
    expect(asked.size).toBe(0);
  });

  it('lets godown staff find stock, challans and warehouses, but not sales, purchases, parties or machines', async () => {
    const { prisma, asked } = fakePrisma();
    const hits = await new SearchService(prisma).search('SS-2026', 'STAFF');
    expect(new Set(hits.map((h) => h.kind))).toEqual(new Set(['item', 'challan', 'warehouse']));
    for (const table of ['sale', 'purchaseOrder', 'supplier', 'textile', 'machine', 'knittingRun']) expect(asked.has(table)).toBe(false);
  });

  it('lets admins find everything, with an item code’s stock', async () => {
    const { prisma } = fakePrisma();
    const hits = await new SearchService(prisma).search('ss-2026', 'ADMIN');
    expect(new Set(hits.map((h) => h.kind))).toEqual(
      new Set(['item', 'batch', 'run', 'machine', 'sale', 'purchase', 'receipt', 'challan', 'distributor', 'textile', 'warehouse']),
    );
    expect(hits.find((h) => h.kind === 'item')).toMatchObject({ key: 'SS-2026-003', subtitle: '30s combed cotton · Yarn · 300 KG in stock' });
  });

  it('puts an exact code first, so Enter opens it', async () => {
    const { prisma } = fakePrisma();
    const hits = await new SearchService(prisma).search('ss-2026-014', 'MANAGER');
    expect(hits[0]).toMatchObject({ kind: 'run', key: 'SS-2026-014' });
  });
});
