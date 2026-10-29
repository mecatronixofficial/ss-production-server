import { InventoryService } from './inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { StockBillsService } from './stock-bills.service';
import { itemJourney } from './item-journey';

jest.mock('./item-journey', () => ({ itemJourney: jest.fn() }));

describe('Item detail price permissions', () => {
  it.each([false, true])('returns purchase rates only when prices=%s', async (prices) => {
    jest.mocked(itemJourney).mockResolvedValue({ journey: [], runs: [], sales: [] } as unknown as Awaited<ReturnType<typeof itemJourney>>);
    const db = {
      stockTransaction: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      purchaseOrderItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'line', itemCode: 'Y1', quantity: 100, unit: 'KG', rate: 250, purchaseOrder: {}, receiptItems: [] }]),
      },
      warehouse: { findMany: jest.fn().mockResolvedValue([]) },
      fabricProductionFlow: { findMany: jest.fn().mockResolvedValue([]) },
      knittingRun: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new InventoryService(db as unknown as PrismaService, {} as StockBillsService);
    const result = await service.itemDetails('Y1', { prices });
    expect(result.purchases[0].rate).toBe(prices ? 250 : null);
  });
});
