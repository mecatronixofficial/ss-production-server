import { Prisma } from '@prisma/client';
import { KnittingService } from './knitting.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { AuthUser } from '../common/auth-user';

const user: AuthUser = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'ADMIN' };
const setup = () => {
  const task = { id: 'kt', flowNo: 'Y1-KT01', status: 'KNITTING', knittingMillType: 'OWN', knittingFinishedAt: null, yarnItemCode: 'Y1', yarnWarehouseId: 'warehouse', yarnCount: 'Cotton', yarnRatePerKg: 100, yarnIssueTxnId: 'issue', yarnLotNo: null, fabricType: 'Rib', purchasedWeightKg: 100, yarnReceivedKg: 100 };
  const machine = { id: 'machine', code: 'KN-01', name: 'Machine 1', status: 'IDLE', ratePerKg: 12 };
  const runs: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    fabricProductionFlow: { findFirst: jest.fn().mockResolvedValue(task), findUniqueOrThrow: jest.fn().mockResolvedValue(task), update: jest.fn() },
    machine: { findUnique: jest.fn().mockResolvedValue(machine), update: jest.fn() },
    employee: { findFirst: jest.fn().mockResolvedValue({ id: 'operator' }) },
    knittingRun: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockImplementation(() => Promise.resolve(runs)),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const run = { id: `run-${runs.length + 1}`, status: 'RUNNING', outputKg: null, rollCount: null, knittingCharge: null, yarnKg: 0, yarnCost: 0, finishedAt: null, machine, productionFlow: null, days: [], yarns: [], ...data };
        runs.push(run);
        return Promise.resolve(run);
      }),
    },
    knittingRunYarn: { create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = { $transaction: jest.fn() };
  const service = new KnittingService(db as unknown as PrismaService, {} as InventoryService);
  return { service, tx, db };
};
const assignment = { startDate: '2020-01-01', startShift: 'DAY' as const, machines: [{ machineId: 'machine', operatorId: 'operator', ratePerKg: 15 }] };

describe('Starting knitting machines within the Production transaction', () => {
  it('creates the running machine and yarn link using the supplied transaction without a second request', async () => {
    const { service, tx, db } = setup();
    const runs = await service.assignWithin(tx as unknown as Prisma.TransactionClient, 'kt', assignment, user);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ runNo: 'Y1-KT01-R1', status: 'RUNNING', ratePerKg: 15 });
    expect(tx.knittingRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ productionFlowId: 'kt', machineId: 'machine', operatorId: 'operator', startShift: 'DAY', ratePerKg: 15 }) });
    expect(tx.knittingRunYarn.create).toHaveBeenCalledWith({ data: expect.objectContaining({ runId: 'run-1', itemCode: 'Y1', issueTxnId: 'issue', kg: 0 }) });
    expect(tx.machine.update).toHaveBeenCalledWith({ where: { id: 'machine' }, data: { status: 'RUNNING' } });
    expect(tx.fabricProductionFlow.update).toHaveBeenCalledWith({ where: { id: 'kt' }, data: expect.objectContaining({ knittingMillDetails: 'KN-01' }) });
  });

  it('refuses a machine already knitting without starting another run', async () => {
    const { service, tx } = setup();
    tx.knittingRun.findFirst.mockResolvedValue({ runNo: 'OTHER-R1' });
    await expect(service.assignWithin(tx as unknown as Prisma.TransactionClient, 'kt', assignment, user)).rejects.toThrow('already knitting');
    expect(tx.knittingRun.create).not.toHaveBeenCalled();
  });

  it('refuses machines under maintenance and inactive operators', async () => {
    const { service, tx } = setup();
    tx.machine.findUnique.mockResolvedValue({ id: 'machine', code: 'KN-01', name: 'Machine 1', status: 'MAINTENANCE', ratePerKg: 12 });
    await expect(service.assignWithin(tx as unknown as Prisma.TransactionClient, 'kt', assignment, user)).rejects.toThrow('maintenance');
    tx.machine.findUnique.mockResolvedValue({ id: 'machine', code: 'KN-01', name: 'Machine 1', status: 'IDLE', ratePerKg: 12 });
    tx.employee.findFirst.mockResolvedValue(null);
    await expect(service.assignWithin(tx as unknown as Prisma.TransactionClient, 'kt', assignment, user)).rejects.toThrow('active operator');
    expect(tx.knittingRun.create).not.toHaveBeenCalled();
  });

  it('rejects a future shift before starting machines', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-17T08:00:00Z'));
    try {
      const { service, tx } = setup();
      await expect(service.assignWithin(tx as unknown as Prisma.TransactionClient, 'kt', { ...assignment, startDate: '2026-11-17', startShift: 'NIGHT' }, user)).rejects.toThrow('still to come');
      expect(tx.knittingRun.create).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it('accepts the previous production day night shift before 9 AM IST', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-17T02:00:00Z'));
    try {
      const { service, tx } = setup();
      await expect(service.assignWithin(tx as unknown as Prisma.TransactionClient, 'kt', { ...assignment, startDate: '2026-11-17', startShift: 'DAY' }, user)).rejects.toThrow('still to come');
      await service.assignWithin(tx as unknown as Prisma.TransactionClient, 'kt', { ...assignment, startDate: '2026-11-16', startShift: 'NIGHT' }, user);
      expect(tx.knittingRun.create).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
  });
});
