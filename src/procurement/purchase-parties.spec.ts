import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Mill, Prisma } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePurchaseOrderDto } from './dto/procurement.dto';
import { ProcurementService } from './procurement.service';
import { purchaseParty, resolvePurchaseSupplier } from './purchase-parties';

const mill: Mill = {
  id: 'mill-id',
  code: 'PC-001',
  name: 'Example Mill',
  services: 'KNITTING',
  contactPerson: 'Office',
  mobile: '9876543210',
  alternateMobile: null,
  email: null,
  gst: null,
  address: 'Mill road',
  city: 'Tiruppur',
  state: 'Tamil Nadu',
  paymentTerms: '30 Days',
  notes: null,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mockTransaction() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(0),
    mill: { findFirst: jest.fn().mockResolvedValue(mill) },
    supplier: {
      findFirst: jest.fn().mockResolvedValue({ id: 'distributor-id', name: 'Distributor', millId: null, mill: null }),
      upsert: jest.fn().mockResolvedValue({ id: 'mill-account', code: mill.code, name: mill.name, millId: mill.id, mill }),
    },
  };
}

describe('purchasing from mills', () => {
  it('accepts a mill instead of a distributor in the purchase DTO', async () => {
    const dto = plainToInstance(CreatePurchaseOrderDto, {
      millId: '11111111-1111-4111-8111-111111111111',
      warehouseId: '22222222-2222-4222-8222-222222222222',
      items: [{ itemName: 'Yarn', category: 'YARN', quantity: 10, unit: 'KG', rate: 100 }],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([{}, { supplierId: 'distributor-id', millId: mill.id }])('requires exactly one purchase party: %j', async (party) => {
    const tx = mockTransaction();
    await expect(resolvePurchaseSupplier(tx as unknown as Prisma.TransactionClient, party)).rejects.toThrow('Select exactly one');
    expect(tx.supplier.upsert).not.toHaveBeenCalled();
  });

  it('keeps distributor purchases on their original account', async () => {
    const tx = mockTransaction();
    const result = await resolvePurchaseSupplier(tx as unknown as Prisma.TransactionClient, { supplierId: 'distributor-id' });
    expect(result.id).toBe('distributor-id');
    expect(tx.supplier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'distributor-id', active: true, millId: null } }),
    );
    expect(tx.supplier.upsert).not.toHaveBeenCalled();
  });

  it('uses a unique mill link and copies contact details into the purchasing account', async () => {
    const tx = mockTransaction();
    const result = await resolvePurchaseSupplier(tx as unknown as Prisma.TransactionClient, { millId: mill.id });
    expect(result.id).toBe('mill-account');
    expect(tx.mill.findFirst).toHaveBeenCalledWith({ where: { id: mill.id, active: true } });
    expect(tx.supplier.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { millId: mill.id },
        create: expect.objectContaining({ millId: mill.id, code: mill.code, name: mill.name, address: 'Mill road, Tiruppur, Tamil Nadu' }),
        update: expect.objectContaining({ name: mill.name, active: true }),
      }),
    );
  });

  it('rejects a missing or inactive mill without creating a purchasing account', async () => {
    const tx = mockTransaction();
    tx.mill.findFirst.mockResolvedValue(null);
    await expect(resolvePurchaseSupplier(tx as unknown as Prisma.TransactionClient, { millId: mill.id })).rejects.toThrow(
      'Select an active mill',
    );
    expect(tx.supplier.upsert).not.toHaveBeenCalled();
  });

  it('rejects inactive distributors and direct use of a mill purchasing account', async () => {
    const tx = mockTransaction();
    tx.supplier.findFirst.mockResolvedValue(null);
    await expect(resolvePurchaseSupplier(tx as unknown as Prisma.TransactionClient, { supplierId: 'inactive' })).rejects.toThrow(
      'Select an active distributor',
    );
  });

  it('shows the mill identity and current contact data without changing its ledger id', () => {
    expect(purchaseParty({ id: 'mill-account', code: 'OLD', name: 'Old name', millId: mill.id, mill })).toMatchObject({
      id: 'mill-account',
      code: mill.code,
      name: mill.name,
      partyType: 'MILL',
      mobile: mill.mobile,
    });
    expect(purchaseParty({ id: 'distributor-id', millId: null })).toMatchObject({ id: 'distributor-id', partyType: 'DISTRIBUTOR' });
  });

  it('lists active mills separately and excludes their linked accounts from distributor choices', async () => {
    const db = {
      supplier: { findMany: jest.fn().mockResolvedValue([{ id: 'distributor-id' }]) },
      mill: { findMany: jest.fn().mockResolvedValue([mill]) },
      warehouse: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new ProcurementService(db as unknown as PrismaService, {} as InventoryService);
    const result = await service.context();
    expect(result.mills).toEqual([mill]);
    expect(result.suppliers).toEqual([{ id: 'distributor-id' }]);
    expect(db.supplier.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true, millId: null } }));
    expect(db.mill.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true } }));
  });
});
