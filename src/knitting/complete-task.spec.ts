import { Prisma } from '@prisma/client';
import { KnittingService } from './knitting.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { AuthUser } from '../common/auth-user';
import { poolFigures, returnUnusedYarn, settleYarnUsed } from '../production/yarn-return';

jest.mock('../production/process-notify', () => ({ notifyProcessDone: jest.fn() }));

const user: AuthUser = { id: 'manager', name: 'Manager', email: 'manager@example.com', role: 'MANAGER' };

/** An own-mill task given 200 KG of yarn 01SS26, knitted on one machine (now stopped) into 48 KG of fabric. */
const setup = (fields: Record<string, unknown> = {}) => {
  const task = {
    id: 'kt',
    flowNo: '01SS26-KT01',
    status: 'KNITTING',
    fabricType: 'Single jersey',
    purchasedWeightKg: new Prisma.Decimal(200),
    yarnReceivedKg: new Prisma.Decimal(200),
    yarnIssueTxnId: 'issue',
    yarnReturnTxnId: null,
    knittingFinishedAt: null,
    ...fields,
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    fabricProductionFlow: {
      findFirst: jest.fn().mockResolvedValue(task),
      findUniqueOrThrow: jest.fn().mockResolvedValue(task),
      findMany: jest.fn().mockResolvedValue([task]),
      update: jest.fn().mockResolvedValue(task),
    },
    knittingRun: {
      count: jest.fn().mockImplementation(({ where }: { where: { status?: string } }) => Promise.resolve(where.status === 'RUNNING' ? 0 : 1)),
      findMany: jest.fn().mockResolvedValue([{ status: 'FINISHED', outputKg: new Prisma.Decimal(48), knittingCharge: new Prisma.Decimal(480), finishedAt: new Date('2026-11-01'), machine: { code: 'KN-01' } }]),
    },
    stockTransaction: { findUniqueOrThrow: jest.fn().mockResolvedValue({ category: 'YARN', itemCode: '01SS26', itemName: "36'S VL", lotNo: null, warehouseId: 'yarn-store', unit: 'KG' }) },
    auditLog: { create: jest.fn() },
  };
  const inventory = { createTxn: jest.fn().mockResolvedValue({ id: 'return' }), removeInWithin: jest.fn() };
  const db = { $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) };
  const service = new KnittingService(db as unknown as PrismaService, inventory as unknown as InventoryService);
  return { service, tx, inventory };
};

describe('Completing an own-mill knitting task on the Machines page', () => {
  it('records the yarn used and puts the rest back into the warehouse', async () => {
    const { service, tx, inventory } = setup();
    await service.completeTask('kt', { complete: true, yarnUsedKg: 50 }, user);
    expect(inventory.createTxn).toHaveBeenCalledWith(
      expect.objectContaining({ txnType: 'KNITTING_RETURN', itemCode: '01SS26', warehouseId: 'yarn-store', quantityIn: 150, referenceId: 'kt' }),
      tx,
    );
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith({ where: { id: 'kt' }, data: { yarnReturnTxnId: 'return' } });
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ purchasedWeightKg: 50, knittingDeliveryKg: 48 }) }));
  });

  it('refuses more yarn used than was given', async () => {
    const { service } = setup();
    await expect(service.completeTask('kt', { complete: true, yarnUsedKg: 260 }, user)).rejects.toThrow('Only 200.000 KG of yarn was given to 01SS26-KT01');
  });

  it('takes the returned yarn back when the task is opened again', async () => {
    const { service, inventory, tx } = setup({ knittingFinishedAt: new Date('2026-11-01'), purchasedWeightKg: new Prisma.Decimal(50), yarnReturnTxnId: 'return' });
    await service.completeTask('kt', { complete: false }, user);
    expect(inventory.removeInWithin).toHaveBeenCalledWith(tx, 'return', 'manager');
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ purchasedWeightKg: 200, knittingFinishedAt: null }) }));
  });
});

describe('Returning unused yarn', () => {
  it('does nothing when all of it was used and nothing went back before', async () => {
    const inventory = { createTxn: jest.fn(), removeInWithin: jest.fn() };
    const tx = { fabricProductionFlow: { update: jest.fn() } } as unknown as Prisma.TransactionClient;
    expect(await returnUnusedYarn(tx, inventory as unknown as InventoryService, { id: 'kt', flowNo: 'KT', yarnIssueTxnId: 'issue', yarnReturnTxnId: null }, 0)).toBeNull();
    expect(inventory.createTxn).not.toHaveBeenCalled();
  });
});

describe('Fabric types sharing one yarn', () => {
  /** 1,400 KG issued once for KT01 and KT02 (700 each shown until they finish). */
  const batch = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    flowNo: `01SS26-${id.toUpperCase()}`,
    yarnIssueTxnId: 'issue',
    yarnReturnTxnId: null as string | null,
    yarnReceivedKg: new Prisma.Decimal(700),
    purchasedWeightKg: new Prisma.Decimal(700),
    knittingFinishedAt: null as Date | null,
    ...fields,
  });
  const run = (group: ReturnType<typeof batch>[]) => {
    const tx = {
      fabricProductionFlow: { findMany: jest.fn().mockResolvedValue(group), update: jest.fn() },
      stockTransaction: { findUniqueOrThrow: jest.fn().mockResolvedValue({ category: 'YARN', itemCode: '01SS26', itemName: "36'S VL", lotNo: null, warehouseId: 'yarn-store', unit: 'KG' }) },
    } as unknown as Prisma.TransactionClient;
    const inventory = { createTxn: jest.fn().mockResolvedValue({ id: 'return' }), removeInWithin: jest.fn() };
    return { tx, inventory };
  };

  it('lets the first type use more than its share, and returns nothing until the last finishes', async () => {
    const kt1 = batch('kt01');
    const { tx, inventory } = run([kt1, batch('kt02')]);
    expect(await settleYarnUsed(tx, inventory as unknown as InventoryService, kt1, 900)).toBe(900);
    expect(inventory.createTxn).not.toHaveBeenCalled();
  });

  it('puts back what neither used when the last type finishes', async () => {
    const kt2 = batch('kt02');
    const { tx, inventory } = run([batch('kt01', { knittingFinishedAt: new Date(), purchasedWeightKg: new Prisma.Decimal(900) }), kt2]);
    expect(poolFigures(kt2, [batch('kt01', { knittingFinishedAt: new Date(), purchasedWeightKg: new Prisma.Decimal(900) }), kt2])).toMatchObject({ totalKg: 1400, usedByOthersKg: 900, leftForThisKg: 500, othersOpen: 0 });
    await settleYarnUsed(tx, inventory as unknown as InventoryService, kt2, 450);
    expect(inventory.createTxn).toHaveBeenCalledWith(expect.objectContaining({ txnType: 'KNITTING_RETURN', quantityIn: 50, referenceId: 'kt02' }), tx);
  });

  it('refuses more than is left of the shared yarn', async () => {
    const kt2 = batch('kt02');
    const { tx, inventory } = run([batch('kt01', { knittingFinishedAt: new Date(), purchasedWeightKg: new Prisma.Decimal(900) }), kt2]);
    await expect(settleYarnUsed(tx, inventory as unknown as InventoryService, kt2, 600)).rejects.toThrow('Only 500.000 KG of the yarn shared with 01SS26-KT01 is left for 01SS26-KT02');
  });
});
