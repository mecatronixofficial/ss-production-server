import { BadRequestException } from '@nestjs/common';
import { FabricProductionFlow, Prisma } from '@prisma/client';
import { ProductionService } from './production.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { StorageService } from '../storage/storage.service';
import { AuthUser } from '../common/auth-user';
import { UpdateFabricCompactingDto, UpdateFabricDyeingDto } from './dto/fabric-flow.dto';
import { fabricFlowView } from './fabric-flow-view';

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
        // The batches sharing its yarn: just itself.
        findMany: jest.fn().mockResolvedValue([current]),
        update: jest.fn().mockResolvedValue(current),
      },
      stockTransaction: { findFirst: jest.fn().mockResolvedValue({ itemName: 'Fabric' }) },
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh', active: true, code: 'WH' }) },
      fabricFlowDelivery: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([{ value: 1 }]),
      processChallan: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'challan', ...data })),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const db = {
      fabricProductionFlow: { findUnique: jest.fn().mockResolvedValue(initial), findMany: jest.fn().mockResolvedValue([initial]) },
      fabricFlowDelivery: tx.fabricFlowDelivery,
      $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
    };
    const inventory = {
      issueWithin: jest.fn().mockRejectedValue(new Error('Duplicate process reached stock posting')),
      removeInWithin: jest.fn(),
      createTxn: jest.fn().mockResolvedValue({ id: 'return-txn' }),
      availableWithin: jest.fn().mockResolvedValue(250),
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
        rollCount: 1,
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

  it('issues a delivery challan when knitting finishes and the grey fabric goes on to dyeing', async () => {
    const { service, tx } = setup(flow({ status: 'KNITTING', knittingMillType: 'OTHER', knittingMillDetails: 'Sri Knits', fabricReceivedKg: null, deliveries: [] }));
    await service.finishKnitting(
      'batch',
      { finishedDate: '2026-10-01', rollCount: 12, totalWeightKg: 96.5, deliveryPlace: 'Dyeing mill', destination: 'NEXT_PROCESS', nextPartyDetails: 'Colour Dyers', nextMillDetails: 'Colour Dyers', knittingExpense: 0 },
      user,
    );
    expect(tx.processChallan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        handOff: 'KNITTING',
        challanNo: expect.stringMatching(/^PDC-2026-\d{6}$/),
        material: 'Grey fabric',
        fromName: 'Sri Knits',
        toKind: 'PROCESS',
        toName: 'Colour Dyers',
        weightKg: 96.5,
        packages: 12,
        packageUnit: 'rolls',
      }),
    });
  });

  it('returns the yarn knitting did not use to stock when knitting finishes', async () => {
    const { service, tx, inventory } = setup(flow({ status: 'KNITTING', knittingMillType: 'OTHER', yarnReceivedKg: new Prisma.Decimal(100), yarnIssueTxnId: 'issue', fabricReceivedKg: null, deliveries: [] }));
    tx.stockTransaction = { ...tx.stockTransaction, findUniqueOrThrow: jest.fn().mockResolvedValue({ category: 'YARN', itemCode: 'Y1', itemName: '30s yarn', lotNo: 'L7', warehouseId: 'wh', unit: 'KG' }) } as typeof tx.stockTransaction;
    await service.finishKnitting(
      'batch',
      { finishedDate: '2026-10-01', rollCount: 4, totalWeightKg: 78, deliveryPlace: 'Mill', destination: 'NEXT_PROCESS', nextPartyDetails: 'Dyers', nextMillDetails: 'Dyers', knittingExpense: 0, yarnUsedKg: 80, yarnRatePerKg: 250 },
      user,
    );
    expect(inventory.createTxn).toHaveBeenCalledWith(expect.objectContaining({ txnType: 'KNITTING_RETURN', itemCode: 'Y1', lotNo: 'L7', warehouseId: 'wh', quantityIn: 20 }), tx);
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ purchasedWeightKg: 80, yarnRatePerKg: 250 }) }));
  });

  it('refuses more yarn used than knitting was given', async () => {
    const { service } = setup(flow({ status: 'KNITTING', yarnReceivedKg: new Prisma.Decimal(100), yarnIssueTxnId: 'issue', fabricReceivedKg: null, deliveries: [] }));
    await expect(
      service.finishKnitting('batch', { finishedDate: '2026-10-01', rollCount: 4, totalWeightKg: 100, deliveryPlace: 'Mill', destination: 'NEXT_PROCESS', nextPartyDetails: 'Dyers', nextMillDetails: 'Dyers', knittingExpense: 0, yarnUsedKg: 120 }, user),
    ).rejects.toThrow('Only 100.000 KG of yarn was given to Y1-D1');
  });

  it('loads the front list without files, machine runs or challan details', async () => {
    const { service } = setup(flow({ status: 'KNITTING', deliveries: [] }));
    const db = (service as unknown as { prisma: { fabricProductionFlow: { findMany: jest.Mock } } }).prisma;
    await service.fabricFlows(user, true);
    const { include } = db.fabricProductionFlow.findMany.mock.calls[0][0];
    expect(include).not.toHaveProperty('attachments');
    expect(include).not.toHaveProperty('knittingRuns');
    expect(include.challans).toEqual({ select: { id: true, cancelledAt: true } });
  });

  it('sums stock by material, its codes and warehouses, leaving out empty positions', async () => {
    const position = (category: string, itemCode: string, warehouseId: string, inKg: number, outKg: number) => ({ category, itemCode, itemName: `${itemCode} name`, warehouseId, _sum: { quantityIn: inKg, quantityOut: outKg } });
    const db = {
      machine: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'm1', code: 'KN-01', name: 'One', status: 'RUNNING', operator: null },
          { id: 'm2', code: 'KN-02', name: 'Two', status: 'RUNNING', operator: null },
          { id: 'm3', code: 'KN-03', name: 'Three', status: 'IDLE', operator: null },
        ]),
      },
      knittingRun: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'r1', runNo: 'Y1-R1', outputKg: null, rollCount: null, yarnKg: new Prisma.Decimal(300), machine: { id: 'm1', code: 'KN-01', name: 'One' }, days: [{ date: new Date('2026-10-30'), outputKg: new Prisma.Decimal(60.25), rollCount: 3 }] },
        ]),
        groupBy: jest.fn().mockResolvedValue([{ productionFlowId: 'f1', _sum: { outputKg: new Prisma.Decimal(120.5) } }]),
      },
      knittingDayEntry: {
        // By production day for the floor, and by run for what each running machine has knitted.
        groupBy: jest.fn().mockImplementation(({ by }: { by: string[] }) =>
          Promise.resolve(
            by[0] === 'date'
              ? [{ date: new Date('2026-10-30'), _sum: { outputKg: new Prisma.Decimal(180.4), rollCount: 9 }, _count: { _all: 2 } }]
              : [{ runId: 'r1', _sum: { outputKg: new Prisma.Decimal(120.5), rollCount: 5 }, _count: { _all: 2 } }],
          ),
        ),
      },
      stockTransaction: {
        groupBy: jest.fn().mockResolvedValue([
          position('YARN', 'Y1', 'w1', 500, 200),
          position('YARN', 'Y1', 'w2', 40, 0),
          position('YARN', 'Y2', 'w2', 100, 0),
          position('YARN', 'Y3', 'w1', 50, 50),
          position('GREY_FABRIC', 'SS-1-R1', 'w2', 80, 0),
        ]),
      },
      warehouse: { findMany: jest.fn().mockResolvedValue([{ id: 'w1', code: 'YRN', name: 'Yarn store' }, { id: 'w2', code: 'GRY', name: 'Grey store' }]) },
    };
    const service = new ProductionService(db as unknown as PrismaService, {} as InventoryService, {} as StorageService);
    const result = await service.overview();
    expect(result.machines).toMatchObject({ total: 3, byStatus: { RUNNING: 2, IDLE: 1 }, running: [{ runNo: 'Y1-R1', outputKg: 120.5, rollCount: 5, dayCount: 2, yarnKg: 300 }] });
    expect(result.machines.list).toHaveLength(3);
    expect(result.machines.running[0].lastDay).toEqual({ date: '2026-10-30', outputKg: 60.25, rollCount: 3 });
    expect(result.knitting).toEqual({ days: [{ date: '2026-10-30', kg: 180.4, rolls: 9, machines: 2 }], knittedByFlow: [{ flowId: 'f1', kg: 120.5 }] });
    expect(result.stock[0]).toEqual({
      category: 'YARN',
      kg: 440,
      codes: 2,
      warehouses: [{ id: 'w1', code: 'YRN', name: 'Yarn store', kg: 300 }, { id: 'w2', code: 'GRY', name: 'Grey store', kg: 140 }],
      items: [
        { itemCode: 'Y1', itemName: 'Y1 name', kg: 340, warehouses: [{ id: 'w1', code: 'YRN', name: 'Yarn store', kg: 300 }, { id: 'w2', code: 'GRY', name: 'Grey store', kg: 40 }] },
        { itemCode: 'Y2', itemName: 'Y2 name', kg: 100, warehouses: [{ id: 'w2', code: 'GRY', name: 'Grey store', kg: 100 }] },
      ],
    });
    expect(result.stock[1]).toMatchObject({ category: 'GREY_FABRIC', kg: 80, codes: 1 });
    expect(result.stock[3]).toMatchObject({ category: 'FINISHED_FABRIC', kg: 0, codes: 0, warehouses: [] });
  });
});

describe('Dyeing lots', () => {
  /** A knitting batch knitted at another mill and sent straight to dyeing: 96 KG of yarn, 90 KG of grey fabric. */
  const knitted = (fields: Record<string, unknown> = {}) =>
    ({
      id: 'kt',
      flowNo: '01SS26-KT01',
      parentId: null,
      status: 'KNITTING',
      yarnItemCode: '01SS26',
      yarnCount: '30s cotton',
      fabricType: 'Single jersey',
      knittingMillType: 'OTHER',
      knittingMillDetails: 'Sri mill',
      knittingDestination: 'NEXT_PROCESS',
      knittingDestinationWarehouseId: null,
      purchasedWeightKg: new Prisma.Decimal(96),
      yarnRatePerKg: new Prisma.Decimal(250),
      purchaseOtherCost: 0,
      knittingExpense: new Prisma.Decimal(1800),
      dyeingExpense: 0,
      compactingExpense: 0,
      otherExpense: 0,
      collectedAmount: 0,
      knittingFinishedAt: new Date('2026-10-20'),
      knittingDeliveryKg: new Prisma.Decimal(90),
      dyeingDeliveryKg: new Prisma.Decimal(90),
      dyeingDate: null,
      dyeingFinishedAt: null,
      dyeingIssueTxnId: null,
      dyeingOutputWeightKg: null,
      ...fields,
    }) as unknown as FabricProductionFlow;

  const setup = (parent: FabricProductionFlow, existingCodes: string[] = [], inLots = 0, greyInStock: Array<{ itemCode: string; warehouseId: string; kg: number }> = []) => {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ value: 7 }]),
      fabricProductionFlow: {
        findUnique: jest.fn().mockResolvedValue(parent),
        findUniqueOrThrow: jest.fn().mockResolvedValue(parent),
        findMany: jest.fn().mockResolvedValue(existingCodes.map((flowNo) => ({ flowNo }))),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve({ id: `lot-${created.length}`, ...data });
        }),
        update: jest.fn().mockResolvedValue(parent),
        aggregate: jest.fn().mockImplementation(() => Promise.resolve({ _sum: { purchasedWeightKg: inLots + created.reduce((sum, lot) => sum + Number(lot.purchasedWeightKg), 0) } })),
      },
      fabricFlowExpense: { findMany: jest.fn().mockResolvedValue([{ amount: new Prisma.Decimal(200) }]) },
      // Grey fabric of the batch in stock: none from machines here; a dyeing balance back under its code, if any.
      knittingRun: { findMany: jest.fn().mockResolvedValue([]) },
      stockTransaction: {
        groupBy: jest.fn().mockResolvedValue(greyInStock.map((g) => ({ itemCode: g.itemCode, itemName: 'Single jersey grey', warehouseId: g.warehouseId, _sum: { quantityIn: g.kg, quantityOut: 0 } }))),
        findUnique: jest.fn().mockResolvedValue({ warehouse: { code: 'GRY', name: 'Grey store' } }),
      },
      // The knitting batch's own challan took it to the dyeing mill.
      processChallan: { findFirst: jest.fn().mockResolvedValue({ id: 'knit-challan' }), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const db = { $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) };
    const inventory = { issueWithin: jest.fn().mockResolvedValue({ id: 'grey-issue' }) };
    const service = new ProductionService(db as unknown as PrismaService, inventory as unknown as InventoryService, {} as StorageService);
    return { service, tx, created, inventory };
  };
  const start = { startDate: '2026-10-22', partyDetails: 'Colour house', millDetails: 'Colour house' };

  it('dyes one knitting batch in several colours, each its own coded lot carrying its share of the cost', async () => {
    const { service, tx, created } = setup(knitted(), ['01SS26-KT01-DY01', '01SS26-KT01-DY01-X']);
    await service.startDyeing('kt', { ...start, lots: [{ color: 'Red', kg: 60 }, { color: 'Navy' }] }, user);
    expect(created.map((lot) => [lot.flowNo, Number(lot.purchasedWeightKg), lot.color, lot.parentId])).toEqual([
      ['01SS26-KT01-DY02', 60, 'Red', 'kt'],
      ['01SS26-KT01-DY03', 30, 'Navy', 'kt'],
    ]);
    // (96 × 250 + 1800 knitting + 200 expense) / 90 KG of grey fabric
    expect(created[0]).toMatchObject({ yarnRatePerKg: 288.89, status: 'KNITTING', dyeingDate: new Date('2026-10-22'), dyeingMillDetails: 'Colour house', fabricReceivedKg: 60 });
    // Straight from the knitting mill: knitting's challan already covers it.
    expect(tx.processChallan.create).not.toHaveBeenCalled();
    expect(tx.fabricProductionFlow.update).toHaveBeenLastCalledWith({ where: { id: 'kt' }, data: { status: 'DELIVERED' } });
  });

  it('keeps the rest of the grey fabric on the knitting batch for another colour', async () => {
    const { service, tx, created } = setup(knitted());
    await service.startDyeing('kt', { ...start, lots: [{ color: 'Red', kg: 50 }] }, user);
    expect(created).toHaveLength(1);
    expect(created[0].flowNo).toBe('01SS26-KT01-DY01');
    expect(tx.fabricProductionFlow.update).toHaveBeenLastCalledWith({ where: { id: 'kt' }, data: { status: 'DYEING' } });
  });

  it('dyes grey fabric a lot did not use (back under the knitting batch code) from the warehouse', async () => {
    // 90 KG knitted, 60 in a lot that used 50 and sent 10 back: 40 KG left, 10 of it in the warehouse.
    const { service, tx, inventory } = setup(knitted(), ['01SS26-KT01-DY01'], 50, [{ itemCode: '01SS26-KT01', warehouseId: 'gry', kg: 10 }]);
    await service.startDyeing('kt', { ...start, lots: [{ color: 'Black', kg: 10 }] }, user);
    expect(inventory.issueWithin).toHaveBeenCalledWith(tx, expect.objectContaining({ category: 'GREY_FABRIC', itemCode: '01SS26-KT01', warehouseId: 'gry', quantityOut: 10, txnType: 'DYEING_ISSUE' }));
  });

  it('refuses more colours than the grey fabric left', async () => {
    const { service } = setup(knitted(), [], 50);
    await expect(service.startDyeing('kt', { ...start, lots: [{ color: 'Red', kg: 45 }] }, user)).rejects.toThrow('Only 40.000 KG of 01SS26-KT01 grey fabric is left for dyeing');
    await expect(service.startDyeing('kt', { ...start, lots: [{ color: 'Red' }, { color: 'Navy' }] }, user)).rejects.toThrow('every colour but one');
  });

  it('shows a knitting batch with lots by what is left of it, so its cost and weight count once', () => {
    const view = fabricFlowView({ ...knitted(), expenses: [{ amount: 200 }], lots: [{ purchasedWeightKg: 60 }] });
    expect(view.metrics.currentWeightKg).toBe(30);
    expect(view.metrics.totalSpent).toBeCloseTo((24000 + 1800 + 200) / 3, 2);
    expect(view.metrics.lots).toMatchObject({ count: 1, allocatedKg: 60, remainingKg: 30 });
    // Only the yarn's and knitting's own loss, not what went into the lot.
    expect(view.metrics.totalLossKg).toBe(6);
  });
});

describe('Knitting several fabric types from one yarn', () => {
  const setup = (available = 1400) => {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      warehouse: { findFirst: jest.fn().mockResolvedValue({ code: 'YRN' }) },
      // The yarn's latest movement, then "kept in another unit?" (no).
      stockTransaction: { findFirst: jest.fn().mockResolvedValueOnce({ itemName: "36'S VL" }).mockResolvedValueOnce(null) },
      yarnReceiptLine: { findUnique: jest.fn().mockResolvedValue({ ratePerKg: new Prisma.Decimal(260) }) },
      fabricProductionFlow: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { flowNo?: unknown; id?: { in: string[] } } }) =>
          Promise.resolve(where.id ? created.filter((f) => where.id!.in.includes(f.id as string)).map((f) => ({ ...flow(), ...f, expenses: [], deliveries: [], lots: [] })) : created.map((f) => ({ flowNo: f.flowNo }))),
        ),
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          created.push({ id: `kt-${created.length + 1}`, ...data });
          return Promise.resolve(created[created.length - 1]);
        }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      auditLog: { create: jest.fn() },
    };
    const inventory = { availableWithin: jest.fn().mockResolvedValue(available), issueWithin: jest.fn().mockImplementation(({ referenceId }: { referenceId: string }) => Promise.resolve({ id: `issue-${referenceId}` })) };
    const db = { $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) };
    const service = new ProductionService(db as unknown as PrismaService, inventory as unknown as InventoryService, {} as StorageService);
    return { service, created, inventory };
  };
  const start = {
    millType: 'OTHER' as const,
    millDetails: 'Sri mill',
    startDate: '2026-11-02',
    yarnItemCode: '01SS26',
    warehouseId: '00000000-0000-0000-0000-000000000001',
    yarnCategory: 'YARN' as const,
    fabricType: '',
    fabricDiameter: '',
  };

  it('makes one knitting batch per type, each with its share of the yarn', async () => {
    const { service, created, inventory } = setup();
    const result = await service.startKnitting(
      { ...start, fabrics: [{ fabricType: 'Single jersey', fabricDiameter: '30', fabricGsm: '180', yarnKg: 400 }, { fabricType: 'Rib', fabricDiameter: '24', gg: '18' }] },
      user,
    );
    expect(created.map((f) => [f.flowNo, f.fabricType, f.fabricDiameter, f.knittingGg, f.purchasedWeightKg])).toEqual([
      ['01SS26-KT01', 'Single jersey', '30', null, 400],
      ['01SS26-KT02', 'Rib', '24', '18', 1000],
    ]);
    expect(inventory.issueWithin).toHaveBeenCalledTimes(2);
    expect(result.started).toEqual([
      { flowNo: '01SS26-KT01', fabricType: 'Single jersey', yarnKg: 400 },
      { flowNo: '01SS26-KT02', fabricType: 'Rib', yarnKg: 1000 },
    ]);
  });

  it('lets types with no yarn KG share all of the yarn, issued once', async () => {
    const { service, created, inventory } = setup();
    await service.startKnitting({ ...start, fabrics: [{ fabricType: 'Single jersey', fabricDiameter: '30' }, { fabricType: 'Rib', fabricDiameter: '24' }] }, user);
    expect(created.map((f) => [f.flowNo, f.purchasedWeightKg])).toEqual([
      ['01SS26-KT01', 700],
      ['01SS26-KT02', 700],
    ]);
    expect(inventory.issueWithin).toHaveBeenCalledTimes(1);
    expect(inventory.issueWithin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantityOut: 1400, referenceId: 'kt-1' }));
  });

  it('refuses more yarn than there is', async () => {
    await expect(setup(300).service.startKnitting({ ...start, fabrics: [{ fabricType: 'A', fabricDiameter: '30', yarnKg: 400 }] }, user)).rejects.toThrow('Only 300.000 KG of 01SS26');
  });
});

describe('Knitting loss', () => {
  const stock = (fields: Record<string, unknown>) =>
    ({
      id: 'kt',
      flowNo: '01SS26-KT01',
      parentId: null,
      source: 'STOCK',
      status: 'KNITTING',
      yarnIssueTxnId: 'issue',
      purchasedWeightKg: new Prisma.Decimal(90),
      yarnReceivedKg: new Prisma.Decimal(90),
      yarnRatePerKg: 0,
      purchaseOtherCost: 0,
      knittingExpense: 0,
      dyeingExpense: 0,
      compactingExpense: 0,
      otherExpense: 0,
      collectedAmount: 0,
      knittingFinishedAt: null,
      knittingDeliveryKg: null,
      dyeingDeliveryKg: null,
      ...fields,
    }) as never;

  it('is nothing while knitting, however little is knitted so far', () => {
    const view = fabricFlowView(stock({ knittingDeliveryKg: new Prisma.Decimal(22) }));
    expect(view.metrics).toMatchObject({ knittingLossKg: 0, totalLossKg: 0, lossPct: 0, yarnReturnedKg: 0 });
  });

  it('is the yarn used against the fabric made: the yarn not used went back and is not lost', () => {
    // 90 KG given, 50 used (40 back in the warehouse), 48 KG of fabric.
    const view = fabricFlowView(stock({ purchasedWeightKg: new Prisma.Decimal(50), knittingFinishedAt: new Date(), knittingDeliveryKg: new Prisma.Decimal(48), dyeingDeliveryKg: new Prisma.Decimal(48) }));
    expect(view.metrics).toMatchObject({ yarnLossKg: 0, knittingLossKg: 2, yarnReturnedKg: 40, totalLossKg: 2, lossPct: 4 });
  });
});

describe('Each process delivers its fabric when it finishes', () => {
  const setup = (current: FabricProductionFlow, sales: Array<Record<string, unknown>> = []) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ value: 9 }]),
      fabricProductionFlow: {
        findUnique: jest.fn().mockResolvedValue(current),
        findUniqueOrThrow: jest.fn().mockResolvedValue(current),
        findMany: jest.fn().mockResolvedValue([current]),
        update: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ ...current, ...data, deliveries: [], lots: [], expenses: [] })),
      },
      fabricFlowDelivery: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue(sales),
        create: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'delivery', ...data })),
        delete: jest.fn(),
      },
      processChallan: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'challan' }), updateMany: jest.fn() },
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'wh', code: 'FIN', name: 'Finished store' }) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn() },
    };
    const db = { $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx), warehouse: tx.warehouse };
    const service = new ProductionService(db as unknown as PrismaService, {} as InventoryService, {} as StorageService);
    return { service, tx };
  };

  it('compacting delivers all the finished fabric to the party with its completion', async () => {
    const { service, tx } = setup(flow({ status: 'COMPACTING', compactingDate: new Date('2026-11-01'), compactingDeliveryKg: new Prisma.Decimal(100), officeDeliveryKg: null, finalDeliveredKg: null, finalDate: null }));
    await service.updateFabricCompacting(
      'batch',
      {
        compactingDate: '2026-11-01',
        finishedDate: '2026-11-02',
        compactingPartyDetails: 'Sun compacting',
        compactingMillDetails: 'Sun compacting',
        compactingReceivedKg: 100,
        officeDeliveryKg: 95,
        compactingExpense: 900,
        delivery: { destination: 'CUSTOMER', partyName: 'Kumar Textiles', amount: 50000, packages: 22 },
      },
      user,
    );
    expect(tx.fabricFlowDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ destination: 'CUSTOMER', partyName: 'Kumar Textiles', weightKg: 95, amount: 50000 }) });
    expect(tx.processChallan.create).toHaveBeenCalledWith({ data: expect.objectContaining({ handOff: 'DELIVERY:delivery', material: 'Finished fabric', toKind: 'PARTY', toName: 'Kumar Textiles', packages: 22, packageUnit: 'rolls' }) });
    expect(tx.fabricProductionFlow.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED', finalDeliveredKg: 95, collectedAmount: { increment: 50000 } }) }));
  });

  const knitted = { finishedDate: '2026-11-02', rollCount: 12, totalWeightKg: 96, deliveryPlace: 'Kumar Textiles', knittingExpense: 1800 };

  it('knitting can deliver its grey fabric straight to a party, which ends the batch', async () => {
    const { service, tx } = setup(flow({ status: 'KNITTING', knittingMillType: 'OTHER', knittingMillDetails: 'Sri mill', knittingDestination: 'NEXT_PROCESS', knittingFinishedAt: null, fabricReceivedKg: null, dyeingDate: null, dyeingDeliveryKg: null, finalDeliveredKg: null, finalDate: null, deliveries: [] }));
    await service.finishKnitting('batch', { ...knitted, destination: 'PARTY', partyName: 'Kumar Textiles', amount: 30000 }, user);
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ knittingDestination: 'PARTY', dyeingDeliveryKg: null, knittingDeliveryPlace: 'Kumar Textiles' }) }));
    // No knitting hand-off challan: the delivery's own one goes to the party.
    expect(tx.processChallan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ handOff: 'KNITTING' }) }));
    expect(tx.processChallan.create).toHaveBeenCalledWith({ data: expect.objectContaining({ material: 'Grey fabric', toKind: 'PARTY', toName: 'Kumar Textiles', weightKg: 96, packages: 12, packageUnit: 'rolls' }) });
    expect(tx.fabricProductionFlow.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED', finalDeliveredKg: 96 }) }));
  });

  it('takes the party delivery back when knitting is corrected to go on to dyeing', async () => {
    const { service, tx } = setup(
      flow({ status: 'DELIVERED', knittingMillType: 'OTHER', knittingMillDetails: 'Sri mill', knittingDestination: 'PARTY', knittingFinishedAt: new Date(), fabricReceivedKg: null, dyeingDate: null, dyeingDeliveryKg: null, finalDeliveredKg: new Prisma.Decimal(96), deliveries: [] }),
      [{ id: 'sale', amount: new Prisma.Decimal(30000), expense: new Prisma.Decimal(0), stockTxnId: null }],
    );
    await service.finishKnitting('batch', { ...knitted, destination: 'NEXT_PROCESS', nextPartyDetails: 'Colour house', nextMillDetails: 'Colour house' }, user);
    expect(tx.fabricFlowDelivery.delete).toHaveBeenCalledWith({ where: { id: 'sale' } });
    expect(tx.processChallan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ handOff: 'DELIVERY:sale' }) }));
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finalDeliveredKg: null, collectedAmount: { decrement: 30000 } }) }));
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'KNITTING', dyeingDeliveryKg: 96 }) }));
  });
});

describe('A process puts the fabric it did not use back in a warehouse', () => {
  const setup = (current: FabricProductionFlow, parent: Record<string, unknown> | null = null) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ value: 3 }]),
      fabricProductionFlow: {
        findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(where.id === current.id ? current : parent)),
        findUniqueOrThrow: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(where.id === current.id ? current : parent)),
        update: jest.fn().mockImplementation(({ data }: { data: object }) => Promise.resolve({ ...current, ...data })),
        aggregate: jest.fn().mockResolvedValue({ _sum: { purchasedWeightKg: new Prisma.Decimal(250) } }),
      },
      fabricFlowDelivery: { findFirst: jest.fn().mockResolvedValue(null) },
      processChallan: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'c' }), update: jest.fn(), updateMany: jest.fn() },
      warehouse: { findFirst: jest.fn().mockResolvedValue({ id: 'grey-store', code: 'GRY', name: 'Grey store' }) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { create: jest.fn() },
    };
    const inventory = { createTxn: jest.fn().mockResolvedValue({ id: 'back' }), removeInWithin: jest.fn() };
    const db = { $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx), warehouse: tx.warehouse };
    const service = new ProductionService(db as unknown as PrismaService, inventory as unknown as InventoryService, {} as StorageService);
    return { service, tx, inventory };
  };
  const dyed = {
    dyeingDate: '2026-11-01',
    finishedDate: '2026-11-03',
    dyeingPartyDetails: 'Colour house',
    dyeingMillDetails: 'Colour house',
    color: 'Navy',
    rollCount: 12,
    dyeingExpense: 3000,
    destination: 'NEXT_PROCESS' as const,
    nextPartyDetails: 'Sun compacting',
    nextMillDetails: 'Sun compacting',
  };

  it('dyeing: a lot uses 250 of its 300 KG, the 50 goes back under its knitting batch and can be dyed again', async () => {
    const lot = flow({ id: 'lot', flowNo: '01SS26-KT01-DY01', parentId: 'kt', status: 'KNITTING', dyeingDeliveryKg: new Prisma.Decimal(300), fabricReceivedKg: new Prisma.Decimal(300), dyeingOutputWeightKg: null, dyeingFinishedAt: null, compactingDate: null, compactingDeliveryKg: null, greyReturnTxnId: null, yarnCount: '36s', color: 'Navy' });
    const { service, tx, inventory } = setup(lot, { id: 'kt', flowNo: '01SS26-KT01', knittingDeliveryKg: new Prisma.Decimal(300), dyeingDeliveryKg: new Prisma.Decimal(300) });
    await service.updateFabricDyeing('lot', { ...dyed, fabricReceivedKg: 250, dyeingOutputWeightKg: 245, balanceKg: 50, balanceWarehouseId: '00000000-0000-0000-0000-000000000001' }, user);
    expect(inventory.createTxn).toHaveBeenCalledWith(expect.objectContaining({ category: 'GREY_FABRIC', txnType: 'RETURN_IN', itemCode: '01SS26-KT01', warehouseId: 'grey-store', quantityIn: 50 }), tx);
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'lot' }, data: expect.objectContaining({ dyeingBalanceKg: 50, greyReturnTxnId: 'back', purchasedWeightKg: 250 }) }));
    // The knitting batch has 50 KG grey fabric again: back at dyeing.
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith({ where: { id: 'kt' }, data: { status: 'DYEING' } });
  });

  it('refuses a balance that with the fabric used is more than was sent', async () => {
    const lot = flow({ id: 'lot', flowNo: '01SS26-KT01-DY01', parentId: null, status: 'KNITTING', dyeingDeliveryKg: new Prisma.Decimal(300), dyeingOutputWeightKg: null, compactingDate: null, compactingDeliveryKg: null, greyReturnTxnId: null });
    const { service } = setup(lot);
    await expect(service.updateFabricDyeing('lot', { ...dyed, fabricReceivedKg: 280, dyeingOutputWeightKg: 270, balanceKg: 50, balanceWarehouseId: '00000000-0000-0000-0000-000000000001' }, user)).rejects.toThrow('more than the 300.000 KG sent to dyeing');
  });

  it('compacting: dyed fabric it did not use goes back under the batch code, replacing an earlier return', async () => {
    const batch = flow({ id: 'lot', flowNo: '01SS26-KT01-DY01', status: 'COMPACTING', compactingDate: new Date('2026-11-04'), compactingDeliveryKg: new Prisma.Decimal(240), officeDeliveryKg: null, finalDeliveredKg: null, dyedReturnTxnId: 'earlier', yarnCount: '36s', color: 'Navy' });
    const { service, tx, inventory } = setup(batch);
    await service.updateFabricCompacting('lot', { compactingDate: '2026-11-04', finishedDate: '2026-11-05', compactingPartyDetails: 'Sun', compactingMillDetails: 'Sun', compactingReceivedKg: 200, officeDeliveryKg: 198, compactingExpense: 800, balanceKg: 40, balanceWarehouseId: '00000000-0000-0000-0000-000000000001' }, user);
    expect(inventory.removeInWithin).toHaveBeenCalledWith(tx, 'earlier', 'admin');
    expect(inventory.createTxn).toHaveBeenCalledWith(expect.objectContaining({ category: 'DYED_FABRIC', txnType: 'RETURN_IN', itemCode: '01SS26-KT01-DY01', quantityIn: 40 }), tx);
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ compactingBalanceKg: 40, dyedReturnTxnId: 'back' }) }));
  });
});
