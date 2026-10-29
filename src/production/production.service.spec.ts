import { BadRequestException } from '@nestjs/common';
import { FabricProductionFlow, Prisma } from '@prisma/client';
import { ProductionService } from './production.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { StorageService } from '../storage/storage.service';
import { AuthUser } from '../common/auth-user';
import { UpdateFabricCompactingDto, UpdateFabricDyeingDto } from './dto/fabric-flow.dto';

const user: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' };
const flow = (fields: Record<string, unknown> = {}) =>
  ({
    id: 'batch',
    flowNo: 'Y1-D1',
    purchasedWeightKg: new Prisma.Decimal(100),
    yarnRatePerKg: new Prisma.Decimal(10),
    purchaseOtherCost: 0,
    knittingExpense: 0,
    dyeingExpense: 0,
    compactingExpense: 0,
    otherExpense: 0,
    collectedAmount: 0,
    knittingFinishedAt: new Date(),
    dyeingFinishedAt: new Date(),
    dyeingOutputWeightKg: new Prisma.Decimal(100),
    dyeingDeliveryKg: new Prisma.Decimal(100),
    compactingDeliveryKg: new Prisma.Decimal(100),
    compactingDate: null,
    compactingFinishedAt: null,
    officeDeliveryKg: null,
    dyeingIssueTxnId: null,
    compactingIssueTxnId: null,
    finalDeliveredKg: null,
    ...fields,
  }) as unknown as FabricProductionFlow;

describe('Production state and balances', () => {
  const setup = (initial: FabricProductionFlow, current = initial) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      fabricProductionFlow: {
        findUnique: jest.fn().mockResolvedValue(current),
        findUniqueOrThrow: jest.fn().mockResolvedValue(current),
        update: jest.fn().mockResolvedValue(current),
      },
      stockTransaction: { findFirst: jest.fn().mockResolvedValue({ itemName: 'Fabric' }) },
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh', active: true, code: 'WH' }) },
      fabricFlowDelivery: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const db = {
      fabricProductionFlow: { findUnique: jest.fn().mockResolvedValue(initial), findMany: jest.fn().mockResolvedValue([initial]) },
      fabricFlowDelivery: tx.fabricFlowDelivery,
      $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
    };
    const inventory = {
      issueWithin: jest.fn().mockRejectedValue(new Error('Duplicate process reached stock posting')),
      removeInWithin: jest.fn(),
    };
    const service = new ProductionService(db as unknown as PrismaService, inventory as unknown as InventoryService, {} as StorageService);
    return { service, tx, inventory };
  };

  it('checks whether a warehouse process was already started after taking the batch lock', async () => {
    const { service, inventory } = setup(flow(), flow({ dyeingIssueTxnId: 'issued-by-concurrent-request' }));
    await expect(
      service.startStockProcess({ process: 'dyeing', itemCode: 'Y1-D1', warehouseId: 'wh', quantityKg: 10 }, user),
    ).rejects.toThrow(BadRequestException);
    expect(inventory.issueWithin).not.toHaveBeenCalled();
  });

  it('does not reduce compacted output below a delivery saved by another request', async () => {
    const { service, tx } = setup(flow({ finalDeliveredKg: 10 }), flow({ finalDeliveredKg: 90 }));
    const dto: UpdateFabricCompactingDto = {
      compactingDate: '2026-10-01',
      compactingPartyDetails: 'Mill',
      compactingMillDetails: 'Mill',
      compactingInwardNo: 'IN1',
      compactingReceivedKg: 100,
      compactingOutwardNo: 'OUT1',
      officeDeliveryKg: 80,
      compactingExpense: 0,
    };
    await expect(service.updateFabricCompacting('batch', dto)).rejects.toThrow('90.000 KG has already been delivered');
    expect(tx.fabricProductionFlow.update).not.toHaveBeenCalled();
  });

  it('does not expose batch expense rows or their sum to a manager', async () => {
    const { service } = setup(flow({ status: 'KNITTING', knittingMillType: 'OWN', expenses: [{ amount: 500 }], deliveries: [] }));
    const result = await service.fabricFlows({ ...user, role: 'MANAGER' });
    expect(result.data[0]).toMatchObject({ expenses: [], metrics: { additionalExpenses: 0, totalSpent: 0 } });
  });

  it('does not undo a process hand-off through the final delivery endpoint', async () => {
    const { service, tx, inventory } = setup(flow());
    tx.fabricFlowDelivery.findFirst.mockResolvedValue({ id: 'delivery', flowId: 'batch', processStage: 'KNITTING', stockTxnId: 'stock' });
    await expect(service.deleteDelivery('batch', 'delivery', user)).rejects.toThrow(BadRequestException);
    expect(inventory.removeInWithin).not.toHaveBeenCalled();
  });

  it('keeps completed downstream production when an old dyeing form is submitted', async () => {
    const { service, tx } = setup(flow({ compactingDate: new Date() }));
    const dto: UpdateFabricDyeingDto = {
      dyeingDate: '2026-10-01',
      dyeingPartyDetails: 'Mill',
      dyeingMillDetails: 'Mill',
      fabricReceivedKg: 100,
      dyeingGreyWeightKg: 100,
      color: 'Blue',
      dyeingCount: '30s',
      rollCount: 1,
      dyeingOutputWeightKg: 95,
      dyeingExpense: 0,
      compactingDeliveryKg: 95,
      destination: 'NEXT_PROCESS',
      nextPartyDetails: 'Mill',
      nextMillDetails: 'Mill',
    };
    await expect(service.updateFabricDyeing('batch', dto)).rejects.toThrow('Compacting has already started');
    expect(tx.fabricProductionFlow.update).not.toHaveBeenCalled();
  });

  it('rejects knitting edits when a concurrent request already started dyeing', async () => {
    const { service, tx } = setup(
      flow({ status: 'KNITTING', fabricReceivedKg: null }),
      flow({ status: 'KNITTING', fabricReceivedKg: 100 }),
    );
    await expect(service.updateKnitting('batch', { startDate: '2026-10-01', millDetails: 'Mill', yarnRatePerKg: 10 })).rejects.toThrow(
      'moved past knitting',
    );
    expect(tx.fabricProductionFlow.update).not.toHaveBeenCalled();
  });

  it('also hides financial fields in the response to a manager finishing knitting', async () => {
    const { service } = setup(
      flow({ status: 'KNITTING', knittingMillType: 'OWN', fabricReceivedKg: null, expenses: [{ amount: 500 }], deliveries: [] }),
    );
    const result = await service.finishKnitting(
      'batch',
      {
        finishedDate: '2026-10-01',
        bagCount: 1,
        totalWeightKg: 100,
        deliveryPlace: 'Dyeing mill',
        destination: 'NEXT_PROCESS',
        nextPartyDetails: 'Mill',
        nextMillDetails: 'Mill',
        knittingExpense: 0,
      },
      { ...user, role: 'MANAGER' },
    );
    expect(result).toMatchObject({ yarnRatePerKg: 0, expenses: [], metrics: { additionalExpenses: 0, totalSpent: 0 } });
  });
});
