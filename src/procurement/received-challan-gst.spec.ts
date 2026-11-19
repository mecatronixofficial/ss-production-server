import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { AuthUser } from '../common/auth-user';
import { ProcurementService } from './procurement.service';
import { purchaseMoney } from './purchase-money';

const admin: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'ADMIN' };
const staff: AuthUser = { id: 'staff', name: 'Godown', email: 'staff@example.test', role: 'STAFF' };
const d = (v: string | number) => new Prisma.Decimal(v);

// Two PO lines at different GST rates; both received in full on one GRN.
const poItems = [
  { id: 'i1', itemName: '34', itemCode: '04SS26', category: 'YARN', unit: 'KG', quantity: d('50'), rate: d('10.00'), gstRate: d('5.00'), receiptItems: [{ quantity: d('50'), purchaseReceipt: { receiptNo: 'GRN-1' } }] },
  { id: 'i2', itemName: '40', itemCode: '05SS26', category: 'YARN', unit: 'KG', quantity: d('12.345'), rate: d('233.33'), gstRate: d('18.00'), receiptItems: [{ quantity: d('12.345'), purchaseReceipt: { receiptNo: 'GRN-1' } }] },
];
const receiptRow = {
  id: 'r1', receiptNo: 'GRN-1', receivedAt: new Date('2026-11-14'), category: 'YARN', lotNo: null, challanNo: '501', vehicleNo: null, notes: null, receivedById: null,
  warehouse: { id: 'w', code: 'W1', name: 'Main', location: null },
  items: [
    { id: 'l1', purchaseOrderItemId: 'i1', quantity: d('50'), dcQuantity: null, packages: null, packageCount: null, details: null, checks: null },
    { id: 'l2', purchaseOrderItemId: 'i2', quantity: d('12.345'), dcQuantity: null, packages: null, packageCount: null, details: null, checks: null },
  ],
  purchaseOrder: {
    id: 'po', poNo: 'PUR-1', orderDate: new Date('2026-11-14'), expectedDate: null, status: 'RECEIVED', warehouse: null,
    supplier: { id: 's', code: 'DST-1', name: 'Siva mills', company: null, contactPerson: null, mobile: null, gst: null, address: null, millId: null, mill: null },
    items: poItems,
  },
};

/** Any lookup the item details make (flows, runs, receipts…) finds nothing. */
const prisma = new Proxy(
  {
    purchaseReceipt: {
      findUnique: jest.fn().mockResolvedValue(receiptRow),
      findMany: jest.fn().mockResolvedValue([{ ...receiptRow, items: receiptRow.items.map((line) => ({ ...line, purchaseOrderItem: poItems.find((i) => i.id === line.purchaseOrderItemId) })) }]),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    systemSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  } as Record<string, unknown>,
  { get: (target, key: string) => target[key] ?? { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) } },
);
const service = new ProcurementService(prisma as unknown as PrismaService, {} as InventoryService);

describe('Received challan (GRN) amounts include GST', () => {
  const entry = purchaseMoney(poItems.map((i) => ({ quantity: i.quantity, rate: i.rate, gstRate: i.gstRate })), true);

  it('totals the taxable value, GST and amount with GST exactly as the purchase entry does', async () => {
    const challan = await service.receipt('r1', admin);
    expect(challan.subtotal).toBe(Number(entry.subtotal));
    expect(challan.gstAmount).toBe(Number(entry.gstAmount));
    expect(challan.total).toBe(Number(entry.totalAmount));
    expect(challan.lines[0]).toMatchObject({ amount: 500, gstRate: 5, gstAmount: 25, totalAmount: 525 });
    expect(challan.lines[1]).toMatchObject({ amount: 2880.46, gstRate: 18, gstAmount: 518.48, totalAmount: 3398.94 });
  });

  it('shows the same value with GST in the received challans register', async () => {
    const [row] = await service.receipts();
    expect(row.value).toBe(Number(entry.totalAmount));
  });

  it('hides every amount from those who do not see prices', async () => {
    const challan = await service.receipt('r1', staff);
    expect(challan).toMatchObject({ subtotal: null, gstAmount: null, total: null, pricesShown: false });
    expect(challan.lines[0]).toMatchObject({ rate: null, amount: null, gstRate: null, gstAmount: null, totalAmount: null });
  });
});
