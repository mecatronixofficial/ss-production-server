import { BadRequestException } from '@nestjs/common';
import { SalesService } from './sales.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { AuthUser } from '../common/auth-user';

const user: AuthUser = { id: 'staff', name: 'Staff', email: 'staff@example.com', role: 'STAFF' };

describe('Sale dispatch validation', () => {
  const setup = () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      sale: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sale',
          saleNo: 'SAL-1',
          status: 'PENDING',
          items: [{ id: 'line', quantity: 10, itemCode: 'Y1', unit: 'KG' }],
        }),
      },
      saleItem: { update: jest.fn().mockRejectedValue(new Error('Invalid dispatch reached stock posting')) },
    };
    const db = { $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) };
    const inventory = { issueWithin: jest.fn().mockRejectedValue(new Error('Invalid dispatch reached stock posting')) };
    return { service: new SalesService(db as unknown as PrismaService, inventory as unknown as InventoryService), tx, inventory };
  };

  it('rejects a positive unrelated line even when every actual line is zero', async () => {
    const { service, tx, inventory } = setup();
    await expect(
      service.dispatch(
        'sale',
        {
          items: [
            { id: 'line', quantity: 0 },
            { id: 'unrelated', quantity: 1 },
          ],
        },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(tx.saleItem.update).not.toHaveBeenCalled();
    expect(inventory.issueWithin).not.toHaveBeenCalled();
  });

  it('rejects duplicate line IDs before posting stock', async () => {
    const { service, inventory } = setup();
    await expect(
      service.dispatch(
        'sale',
        {
          items: [
            { id: 'line', quantity: 1 },
            { id: 'line', quantity: 2 },
          ],
        },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(inventory.issueWithin).not.toHaveBeenCalled();
  });
});

describe('Sale stock validation', () => {
  it('does not sell yarn using fabric stock that has the same code and unit', async () => {
    const db = {
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh', code: 'WH' }) },
      supplier: { findFirst: jest.fn().mockResolvedValue({ id: 'supplier', name: 'Distributor' }) },
      $transaction: jest.fn().mockRejectedValue(new Error('Incorrect category reached sale creation')),
    };
    const inventory = {
      balance: jest.fn().mockResolvedValue([{ category: 'GREY_FABRIC', itemCode: 'ITEM', lotNo: null, unit: 'KG', balanceKg: 100 }]),
    };
    const service = new SalesService(db as unknown as PrismaService, inventory as unknown as InventoryService);
    await expect(
      service.create(
        {
          saleDate: '2026-10-01',
          partyType: 'DISTRIBUTOR',
          supplierId: 'supplier',
          warehouseId: 'wh',
          gstRate: 5,
          items: [{ category: 'YARN', itemCode: 'ITEM', itemName: 'Yarn', unit: 'KG', quantity: 10, rate: 1 }],
        },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
