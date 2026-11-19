import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { StorageService } from '../storage/storage.service';
import { KnittingService } from '../knitting/knitting.service';
import { AuthUser } from '../common/auth-user';
import { ProductionService } from './production.service';

jest.mock('./process-notify', () => ({ notifyProcessDone: jest.fn() }));

const user: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'ADMIN' };

const setup = (overrides: Record<string, unknown> = {}, counts: Partial<Record<'lots' | 'deliveries' | 'expenses' | 'challans', number>> = {}) => {
  const flow = {
    id: 'batch', flowNo: 'Y1-KT01', parentId: null, piNo: 'PI-7', status: 'KNITTING', knittingFinishedAt: null,
    yarnItemCode: 'Y1', yarnLotNo: null, yarnReceivedKg: 100, purchasedWeightKg: 100, knittingMillType: 'OWN', knittingMillDetails: 'Own mill',
    yarnIssueTxnId: 'issue-1', yarnReturnTxnId: null, greyReturnTxnId: null, dyedReturnTxnId: null, dyeingIssueTxnId: null, compactingIssueTxnId: null,
    ...overrides,
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    fabricProductionFlow: {
      findUnique: jest.fn().mockResolvedValue(flow),
      count: jest.fn().mockResolvedValue(counts.lots ?? 0),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(flow),
    },
    fabricFlowDelivery: { count: jest.fn().mockResolvedValue(counts.deliveries ?? 0) },
    fabricFlowExpense: { count: jest.fn().mockResolvedValue(counts.expenses ?? 0) },
    processChallan: { count: jest.fn().mockResolvedValue(counts.challans ?? 0) },
    stockTransaction: { findFirst: jest.fn().mockResolvedValue(null) },
    fabricFlowAttachment: { findMany: jest.fn().mockResolvedValue([{ objectKey: 'files/a.pdf' }]) },
    auditLog: { create: jest.fn() },
  };
  const db = { $transaction: jest.fn().mockImplementation((work: (client: typeof tx) => Promise<unknown>) => work(tx)) };
  const inventory = { deleteWithin: jest.fn().mockResolvedValue(undefined) };
  const knitting = { cancelTaskRunsWithin: jest.fn().mockResolvedValue(undefined) };
  const storage = { remove: jest.fn().mockResolvedValue(undefined) };
  const service = new ProductionService(
    db as unknown as PrismaService,
    inventory as unknown as InventoryService,
    storage as unknown as StorageService,
    knitting as unknown as KnittingService,
  );
  return { service, tx, inventory, knitting, storage };
};

describe('Deleting a production batch', () => {
  it('returns the yarn, removes idle machine runs and files, and deletes a batch still knitting', async () => {
    const { service, tx, inventory, knitting, storage } = setup();
    await expect(service.deleteBatch('batch', user)).resolves.toEqual({ deleted: true });
    expect(knitting.cancelTaskRunsWithin).toHaveBeenCalledWith(tx, 'batch', user);
    expect(inventory.deleteWithin).toHaveBeenCalledWith(tx, ['issue-1'], 'admin');
    expect(tx.fabricProductionFlow.delete).toHaveBeenCalledWith({ where: { id: 'batch' } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PRODUCTION_BATCH_DELETED' }) }));
    expect(storage.remove).toHaveBeenCalledWith('files/a.pdf');
  });

  it.each([
    ['finished knitting', { knittingFinishedAt: new Date('2020-01-02') }, {}, 'has finished knitting'],
    ['moved on to dyeing', { status: 'DYEING' }, {}, 'has finished knitting'],
    ['a colour lot', { parentId: 'root' }, {}, 'is a colour lot'],
    ['colour lots', {}, { lots: 2 }, 'has colour lots'],
    ['deliveries', {}, { deliveries: 1 }, 'has deliveries recorded'],
    ['expenses', {}, { expenses: 1 }, 'has expenses recorded'],
    ['challans', {}, { challans: 1 }, 'has challans'],
    ['yarn returned', { yarnReturnTxnId: 'ret-1' }, {}, 'has stock returned or issued on'],
  ])('refuses a batch with %s and changes nothing', async (_label, overrides, counts, message) => {
    const { service, tx, inventory, knitting } = setup(overrides, counts);
    await expect(service.deleteBatch('batch', user)).rejects.toThrow(message);
    expect(knitting.cancelTaskRunsWithin).not.toHaveBeenCalled();
    expect(inventory.deleteWithin).not.toHaveBeenCalled();
    expect(tx.fabricProductionFlow.delete).not.toHaveBeenCalled();
  });

  it('refuses a batch that shares one yarn issue with other fabric types', async () => {
    const { service, tx, inventory } = setup();
    tx.fabricProductionFlow.findMany.mockResolvedValue([{ flowNo: 'Y1-KT02' }]);
    await expect(service.deleteBatch('batch', user)).rejects.toThrow('shares its yarn with Y1-KT02');
    expect(inventory.deleteWithin).not.toHaveBeenCalled();
  });

  it('refuses a batch with other stock movements of its own', async () => {
    const { service, tx } = setup();
    tx.stockTransaction.findFirst.mockResolvedValue({ id: 'other' });
    await expect(service.deleteBatch('batch', user)).rejects.toThrow('has other stock movements');
    expect(tx.fabricProductionFlow.delete).not.toHaveBeenCalled();
  });
});
