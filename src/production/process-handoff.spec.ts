import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { StorageService } from '../storage/storage.service';
import { KnittingService } from '../knitting/knitting.service';
import { AuthUser } from '../common/auth-user';
import { ProductionService } from './production.service';
import { FinishKnittingDto, UpdateFabricDyeingDto } from './dto/fabric-flow.dto';
import { issueChallan } from './process-challans';

jest.mock('./process-notify', () => ({ notifyProcessDone: jest.fn() }));
jest.mock('./process-challans', () => ({ issueChallan: jest.fn().mockResolvedValue({ id: 'challan' }), hasChallan: jest.fn().mockResolvedValue(true), cancelChallan: jest.fn(), issueWarehouseName: jest.fn().mockResolvedValue(null) }));

const user: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'ADMIN' };
const setup = (overrides: Record<string, unknown> = {}) => {
  const initial = {
    id: 'batch', flowNo: 'Y1-KT01', parentId: null, status: 'KNITTING', source: 'STOCK',
    yarnItemCode: 'Y1', yarnCount: 'Cotton', yarnRatePerKg: 100, purchasedWeightKg: 100, yarnReceivedKg: 100,
    yarnIssueTxnId: null, yarnReturnTxnId: null, knittingMillType: 'OTHER', knittingMillDetails: 'Knitter',
    knittingDate: new Date('2020-01-01'), knittingFinishedAt: null, knittingDestination: null, knittingDestinationWarehouseId: null,
    knittingDeliveryKg: null, fabricType: 'Rib', fabricReceivedKg: null, dyeingDate: null, dyeingFinishedAt: null,
    dyeingDeliveryKg: null, dyeingOutputWeightKg: null, dyeingIssueTxnId: null, dyeingDestination: null,
    compactingDeliveryKg: null, compactingDate: null, compactingFinishedAt: null, compactingIssueTxnId: null,
    officeDeliveryKg: null, greyReturnTxnId: null, purchaseOtherCost: 0, knittingExpense: 0, dyeingExpense: 0,
    compactingExpense: 0, otherExpense: 0, collectedAmount: 0, ...overrides,
  };
  const rows = new Map<string, Record<string, unknown>>([['batch', initial]]);
  const view = (id: string) => ({ ...rows.get(id), lots: [...rows.values()].filter(row => row.parentId === id), expenses: [], deliveries: [], attachments: [], challans: [] });
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    fabricProductionFlow: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(rows.get(where.id))),
      findUniqueOrThrow: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve(view(where.id))),
      findMany: jest.fn().mockImplementation(({ where }: { where: { flowNo?: { startsWith: string }; parentId?: string } }) => Promise.resolve([...rows.values()].filter(row => where.flowNo ? String(row.flowNo).startsWith(where.flowNo.startsWith) : row.parentId === where.parentId))),
      update: jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { rows.set(where.id, { ...rows.get(where.id), ...data }); return Promise.resolve(view(where.id)); }),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => { const id = `lot-${rows.size}`; rows.set(id, { ...initial, ...data, id }); return Promise.resolve(rows.get(id)); }),
      aggregate: jest.fn().mockImplementation(({ where }: { where: { parentId: string } }) => Promise.resolve({ _sum: { purchasedWeightKg: [...rows.values()].filter(row => row.parentId === where.parentId).reduce((sum, row) => sum + Number(row.purchasedWeightKg), 0) } })),
    },
    fabricFlowExpense: { findMany: jest.fn().mockResolvedValue([]) },
    fabricFlowDelivery: { findFirst: jest.fn().mockResolvedValue(null) },
    knittingRun: { findMany: jest.fn().mockResolvedValue([]) },
    stockTransaction: { groupBy: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn() },
  };
  const db = { $transaction: jest.fn().mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => {
    const before = new Map([...rows.entries()].map(([id, row]) => [id, { ...row }]));
    try { return await work(tx); } catch (error) { rows.clear(); for (const [id, row] of before) rows.set(id, row); throw error; }
  }) };
  const inventory = { issueWithin: jest.fn().mockResolvedValue({ id: 'issue' }) };
  const machines = { stopTaskRunsWithin: jest.fn().mockResolvedValue(undefined) };
  const service = new ProductionService(db as unknown as PrismaService, inventory as unknown as InventoryService, {} as StorageService, machines as unknown as KnittingService);
  return { service, tx, db, rows, inventory, machines };
};
const knitting: FinishKnittingDto = {
  finishedDate: '2020-01-02', rollCount: 5, totalWeightKg: 95, deliveryPlace: 'Colour mill', destination: 'NEXT_PROCESS',
  nextPartyDetails: 'Colour mill', nextMillDetails: 'Colour mill', knittingExpense: 100,
  dyeingStart: { startDate: '2020-01-02', lots: [{ color: 'Navy', kg: 40 }, { color: 'Red' }], notes: 'Dyeing instructions' },
};
const dyeing: UpdateFabricDyeingDto = {
  dyeingDate: '2020-01-02', finishedDate: '2020-01-03', dyeingPartyDetails: 'Colour mill', dyeingMillDetails: 'Colour mill',
  fabricReceivedKg: 95, color: 'Navy', rollCount: 5, dyeingOutputWeightKg: 90, dyeingExpense: 200,
  destination: 'NEXT_PROCESS', nextPartyDetails: 'Compacting mill', nextMillDetails: 'Compacting mill',
  compactingStart: { startDate: '2020-01-03', receivedKg: 90, inwardNo: 'IN-1', notes: 'Compacting instructions' },
};

describe('Completing a process and starting the next one in one request', () => {
  beforeEach(() => jest.clearAllMocks());

  it('finishes knitting and starts each colour as a dyeing lot in the same transaction', async () => {
    const { service, rows, db } = setup();
    const saved = await service.finishKnitting('batch', knitting, user);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(rows.get('batch')).toMatchObject({ knittingFinishedAt: new Date('2020-01-02'), knittingDeliveryKg: 95 });
    expect(saved.lots).toHaveLength(2);
    expect(rows.get('lot-1')).toMatchObject({ flowNo: 'Y1-KT01-DY01', parentId: 'batch', purchasedWeightKg: 40, dyeingDate: new Date('2020-01-02'), dyeingMillDetails: 'Colour mill', fabricReceivedKg: 40, color: 'Navy', dyeingNotes: 'Dyeing instructions' });
    expect(rows.get('lot-2')).toMatchObject({ purchasedWeightKg: 55, color: 'Red' });
    expect(issueChallan).toHaveBeenCalledTimes(1);
    await expect(service.finishKnitting('batch', knitting, user)).rejects.toThrow('moved past knitting');
    expect(rows.size).toBe(3);
  });

  it('keeps own-machine fabric stock handling when dyeing starts with knitting completion', async () => {
    const { service, tx, inventory } = setup({ knittingMillType: 'OWN', knittingMillDetails: 'KN-01' });
    tx.knittingRun.findMany.mockImplementation(({ where }: { where: { status?: string } }) => Promise.resolve(where.status === 'RUNNING' ? [] : [{ runNo: 'Y1-KT01-R1' }]));
    tx.stockTransaction.groupBy.mockResolvedValue([{ itemCode: 'Y1-KT01-R1', itemName: 'Grey fabric', warehouseId: 'warehouse', _sum: { quantityIn: 95, quantityOut: 0 } }]);
    await service.finishKnitting('batch', { ...knitting, dyeingStart: { startDate: '2020-01-02', lots: [{ color: 'Navy' }] } }, user);
    expect(inventory.issueWithin).toHaveBeenCalledWith(tx, expect.objectContaining({ itemCode: 'Y1-KT01-R1', category: 'GREY_FABRIC', quantityOut: 95, txnType: 'DYEING_ISSUE' }));
  });

  it('stops the own-mill machines still knitting the batch in the same transaction as finishing knitting', async () => {
    const { service, tx, rows, machines } = setup({ knittingMillType: 'OWN', knittingMillDetails: '30DIA1' });
    const stop: FinishKnittingDto = { ...knitting, dyeingStart: undefined, machineStops: [{ runId: 'run-1', outputKg: 95, rollCount: 5 }], stopShift: 'DAY', stopWarehouseId: 'warehouse' };
    await service.finishKnitting('batch', stop, user);
    expect(machines.stopTaskRunsWithin).toHaveBeenCalledWith(tx, 'batch', { date: new Date('2020-01-02'), shift: 'DAY', warehouseId: 'warehouse', stops: stop.machineStops }, user);
    expect(rows.get('batch')).toMatchObject({ knittingFinishedAt: new Date('2020-01-02'), knittingDeliveryKg: 95 });
  });

  it('refuses to finish own-mill knitting while a machine is still knitting it, and changes nothing', async () => {
    const { service, tx, rows } = setup({ knittingMillType: 'OWN' });
    tx.knittingRun.findMany.mockImplementation(({ where }: { where: { status?: string } }) => Promise.resolve(where.status === 'RUNNING' ? [{ runNo: 'Y1-KT01-R1' }] : []));
    await expect(service.finishKnitting('batch', knitting, user)).rejects.toThrow('Y1-KT01-R1 is still knitting');
    expect(rows.get('batch')?.knittingFinishedAt).toBeNull();
  });

  it('finishes dyeing and starts compacting with inward, received weight and notes in one transaction', async () => {
    const { service, rows, db } = setup({ dyeingDate: new Date('2020-01-02'), dyeingDeliveryKg: 95, fabricReceivedKg: 95 });
    const saved = await service.updateFabricDyeing('batch', dyeing, user);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({ dyeingFinishedAt: new Date('2020-01-03'), dyeingOutputWeightKg: 90, compactingDate: new Date('2020-01-03'), compactingReceivedKg: 90, compactingMillDetails: 'Compacting mill', compactingInwardNo: 'IN-1', compactingNotes: 'Compacting instructions' });
    expect(issueChallan).toHaveBeenCalledTimes(1);
    await expect(service.updateFabricDyeing('batch', dyeing, user)).rejects.toThrow('Compacting has already started');
    expect(rows.get('batch')?.compactingReceivedKg).toBe(90);
  });

  it('rolls knitting completion back if the colour allocation cannot start', async () => {
    const { service, rows } = setup();
    await expect(service.finishKnitting('batch', { ...knitting, dyeingStart: { startDate: '2020-01-02', lots: [{ color: 'Navy', kg: 96 }] } }, user)).rejects.toThrow('Only 95.000 KG');
    expect(rows.get('batch')?.knittingFinishedAt).toBeNull();
    expect(rows.size).toBe(1);
  });

  it('rolls dyeing completion back if compacting cannot accept its received weight', async () => {
    const { service, rows } = setup({ dyeingDate: new Date('2020-01-02'), dyeingDeliveryKg: 95, fabricReceivedKg: 95 });
    await expect(service.updateFabricDyeing('batch', { ...dyeing, compactingStart: { startDate: '2020-01-03', receivedKg: 250 } }, user)).rejects.toThrow('Weight received at compacting');
    expect(rows.get('batch')?.dyeingFinishedAt).toBeNull();
    expect(rows.get('batch')?.compactingDate).toBeNull();
  });

  it('rejects starts before completion and next-process details on a warehouse delivery', async () => {
    const { service, db } = setup();
    await expect(service.finishKnitting('batch', { ...knitting, dyeingStart: { startDate: '2020-01-01', color: 'Navy' } }, user)).rejects.toThrow('before the previous process');
    await expect(service.finishKnitting('batch', { ...knitting, destination: 'WAREHOUSE' }, user)).rejects.toThrow('sent to dyeing');
    await expect(service.updateFabricDyeing('batch', { ...dyeing, compactingStart: { startDate: '2020-01-01', receivedKg: 90 } }, user)).rejects.toThrow('before the previous process');
    await expect(service.updateFabricDyeing('batch', { ...dyeing, destination: 'WAREHOUSE' }, user)).rejects.toThrow('sent to compacting');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('validates nested start details without changing the completion DTOs of other destinations', async () => {
    expect(await validate(plainToInstance(FinishKnittingDto, knitting))).toHaveLength(0);
    expect(await validate(plainToInstance(UpdateFabricDyeingDto, dyeing))).toHaveLength(0);
    const errors = await validate(plainToInstance(FinishKnittingDto, { ...knitting, dyeingStart: { startDate: 'bad-date', lots: [{ color: '' }] } }));
    expect(errors.some(error => error.property === 'dyeingStart')).toBe(true);
    const compactingErrors = await validate(plainToInstance(UpdateFabricDyeingDto, { ...dyeing, compactingStart: { startDate: '2020-01-03', receivedKg: -1 } }));
    expect(compactingErrors.some(error => error.property === 'compactingStart')).toBe(true);
  });
});
