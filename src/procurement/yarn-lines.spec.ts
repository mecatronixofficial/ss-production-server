import { Prisma } from '@prisma/client';
import { ProcurementService } from './procurement.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { AuthUser } from '../common/auth-user';

const admin: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' };

describe('Yarn bought on purchase orders', () => {
  const db = {
    purchaseOrderItem: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'line',
          itemName: "36'S VL",
          itemCode: '05SS26',
          unit: 'KG',
          quantity: new Prisma.Decimal(2000),
          rate: new Prisma.Decimal(255),
          specs: [{ label: 'Count', value: "36'S" }, { label: 'Bags', value: '30+9' }],
          purchaseOrder: { id: 'po', poNo: 'PUR-2026-000002', orderDate: new Date('2026-10-01'), expectedDate: null, status: 'PARTIALLY_RECEIVED', supplier: { code: 'DST-00001', name: 'Cheran Mill' }, warehouse: { code: 'YRN' } },
          receiptItems: [
            {
              quantity: new Prisma.Decimal(1140),
              dcQuantity: new Prisma.Decimal(1145),
              packages: '19',
              packageCount: 19,
              details: null,
              checks: [{ label: 'Count', ordered: "36'S", ok: true, received: "36'S" }],
              purchaseReceipt: { id: 'grn', receiptNo: 'GRN-2026-000004', receivedAt: new Date('2026-10-21'), challanNo: '578', vehicleNo: 'TN39AB1234', lotNo: null, warehouse: { code: 'YRN' } },
            },
          ],
        },
      ]),
    },
    stockTransaction: {
      groupBy: jest.fn().mockResolvedValue([
        { itemCode: '05SS26', txnType: 'PURCHASE_IN', _sum: { quantityIn: 1140, quantityOut: 0 } },
        { itemCode: '05SS26', txnType: 'KNITTING_ISSUE', _sum: { quantityIn: 0, quantityOut: 600 } },
      ]),
    },
    fabricProductionFlow: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new ProcurementService(db as unknown as PrismaService, {} as InventoryService);

  it('gives each yarn line ordered, received, to come, its receipts with their checks, and where its yarn is', async () => {
    const [line] = await service.yarnLines(admin);
    expect(line).toMatchObject({ itemCode: '05SS26', orderedQty: 2000, receivedQty: 1140, balanceQty: 860, rate: 255, amount: 510000 });
    expect(line.specs).toEqual([{ label: 'Count', value: "36'S" }, { label: 'Bags', value: '30+9' }]);
    expect(line.receipts).toEqual([
      expect.objectContaining({ receiptNo: 'GRN-2026-000004', dcNo: '578', quantity: 1140, dcQuantity: 1145, packages: '19', checks: [expect.objectContaining({ ok: true })] }),
    ]);
    expect(line.usage).toMatchObject({ inStockKg: 540, toKnittingKg: 600, returnedKg: 0, knitting: [] });
    // Only yarn, and not cancelled orders.
    expect(db.purchaseOrderItem.findMany.mock.calls[0][0].where).toEqual({ category: 'YARN', purchaseOrder: { status: { not: 'CANCELLED' } } });
  });

  it('hides rates from those who do not see prices', async () => {
    const [line] = await service.yarnLines({ ...admin, role: 'STAFF' });
    expect(line).toMatchObject({ rate: null, amount: null });
  });
});
