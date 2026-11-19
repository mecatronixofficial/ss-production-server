import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthUser } from '../common/auth-user';
import { documentNo, batchCode } from '../common/numbering';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ProcurementService } from './procurement.service';
import { CreatePurchaseOrderDto, ReceivePurchaseOrderDto } from './dto/procurement.dto';

jest.mock('../common/numbering', () => ({
  documentNo: jest.fn().mockResolvedValue('DOC-2026-1'),
  batchCode: jest.fn().mockResolvedValue('01SS26'),
}));
jest.mock('../notifications/notify.util', () => ({ ...jest.requireActual('../notifications/notify.util'), notifyRoles: jest.fn() }));

const user: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@test.local', role: 'ADMIN' };
const selected = new Date('2026-07-10');
function setup() {
  const supplier = { id: 'supplier', code: 'DST-01', name: 'Yarn Mill', millId: null, mill: null };
  const warehouse = { id: 'warehouse', code: 'WH01', name: 'Store', active: true };
  const item = {
    id: 'line',
    itemCode: null,
    itemName: 'Cotton',
    category: 'YARN',
    quantity: 1200,
    unit: 'KG',
    rate: 10,
    gstRate: 0,
    receiptItems: [],
    specs: [],
  };
  const po = {
    id: 'po',
    poNo: 'PUR-2026-1',
    orderDate: selected,
    supplier,
    warehouse,
    warehouseId: warehouse.id,
    status: 'ORDERED',
    items: [item],
    receipts: [],
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    warehouse: { findFirst: jest.fn().mockResolvedValue(warehouse) },
    supplier: { findFirst: jest.fn().mockResolvedValue(supplier) },
    purchaseOrder: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...po, ...data, items: [item] })),
      findUnique: jest.fn().mockResolvedValue(po),
      update: jest.fn().mockResolvedValue(po),
    },
    purchaseOrderItem: { update: jest.fn().mockResolvedValue({ ...item, itemCode: '01SS26' }) },
    purchaseReceipt: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'receipt', ...data, items: [] })) },
    auditLog: { create: jest.fn() },
    notification: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = { ...tx, $transaction: jest.fn().mockImplementation((work) => work(tx)) };
  const inventory = { createTxn: jest.fn().mockResolvedValue({ id: 'stock' }) };
  return { service: new ProcurementService(prisma as unknown as PrismaService, inventory as unknown as InventoryService), tx, inventory };
}

describe('Backdated purchase and goods receipt entries', () => {
  beforeEach(() => jest.clearAllMocks());
  it('stores the selected order date and uses its year for document numbering', async () => {
    const { service, tx } = setup();
    await service.create(
      {
        supplierId: 'supplier',
        warehouseId: 'warehouse',
        orderDate: '2026-07-10',
        items: [{ itemName: 'Cotton', category: 'YARN', quantity: 1200, unit: 'KG', rate: 10 }],
      },
      user,
    );
    expect(tx.purchaseOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderDate: selected }) }),
    );
    expect(documentNo).toHaveBeenCalledWith(tx, 'PUR', selected);
    expect(tx.auditLog.create.mock.calls[0][0].data.createdAt).toBeUndefined();
  });
  it('dates the goods receipt, yarn code and stock calculation on the chosen day', async () => {
    const { service, tx, inventory } = setup();
    await service.receive(
      'po',
      { warehouseId: 'warehouse', receivedDate: '2026-07-10', items: [{ purchaseOrderItemId: 'line', quantity: 1200, packages: '30+9' }] },
      user,
    );
    expect(tx.purchaseReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receivedAt: selected }) }),
    );
    expect(documentNo).toHaveBeenCalledWith(tx, 'GRN', selected);
    expect(batchCode).toHaveBeenCalledWith(tx, selected);
    expect(inventory.createTxn).toHaveBeenCalledWith(
      expect.objectContaining({ quantityIn: 1200, txnType: 'PURCHASE_IN', createdAt: selected }),
      tx,
    );
  });
  it('does not post a receipt dated before the purchase', async () => {
    const { service, tx, inventory } = setup();
    await expect(
      service.receive(
        'po',
        { warehouseId: 'warehouse', receivedDate: '2026-07-09', items: [{ purchaseOrderItemId: 'line', quantity: 1200, packages: '30+9' }] },
        user,
      ),
    ).rejects.toThrow('before');
    expect(tx.purchaseReceipt.create).not.toHaveBeenCalled();
    expect(inventory.createTxn).not.toHaveBeenCalled();
  });
  it('accepts date fields through the validated DTOs', async () => {
    const warehouseId = '11111111-1111-4111-8111-111111111111';
    const po = plainToInstance(CreatePurchaseOrderDto, {
      supplierId: 'supplier',
      warehouseId,
      orderDate: '2026-07-10',
      items: [{ itemName: 'Cotton', category: 'YARN', quantity: 1200, unit: 'KG', rate: 10 }],
    });
    const receipt = plainToInstance(ReceivePurchaseOrderDto, {
      warehouseId,
      receivedDate: '2026-07-10',
      items: [{ purchaseOrderItemId: warehouseId, quantity: 1200, packages: '30+9' }],
    });
    expect(await validate(po, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    expect(await validate(receipt, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });
  it('refuses a received line without its rolls / bags, which the received note prints', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const errors = (items: unknown[]) =>
      validate(plainToInstance(ReceivePurchaseOrderDto, { warehouseId: id, receivedDate: '2026-07-10', items }), { whitelist: true, forbidNonWhitelisted: true });
    expect(JSON.stringify(await errors([{ purchaseOrderItemId: id, quantity: 1200 }]))).toContain('Enter the number of rolls / bags for every line received');
    expect(JSON.stringify(await errors([{ purchaseOrderItemId: id, quantity: 1200, packages: 'ten' }]))).toContain('as numbers');
    expect(await errors([{ purchaseOrderItemId: id, quantity: 1200, packages: '22' }])).toHaveLength(0);
  });
});
