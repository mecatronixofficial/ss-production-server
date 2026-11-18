import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MachineReportQueryDto } from './dto/machine-report.dto';
import { machineProductionReport, machineReportDates } from './machine-production-report';

const dec = (value: number) => new Prisma.Decimal(value);
const period = { from: '2024-02-01', to: '2024-02-29' };
function database() {
  return {
    machine: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'a', code: 'KN-01', name: 'One', status: 'RUNNING' },
        { id: 'b', code: 'KN-02', name: 'Two', status: 'DISABLED' },
        { id: 'c', code: 'KN-03', name: 'Three', status: 'IDLE' },
        { id: 'd', code: 'KN-04', name: 'Four', status: 'DISABLED' },
      ]),
    },
    knittingDayEntry: {
      findMany: jest.fn().mockResolvedValue([
        { date: new Date('2024-02-01'), outputKg: dec(10), yarnUsedKg: null, rollCount: 2, run: { machineId: 'a', ratePerKg: dec(2) } },
        { date: new Date('2024-02-01'), outputKg: dec(5), yarnUsedKg: dec(6), rollCount: 1, run: { machineId: 'a', ratePerKg: dec(2) } },
        { date: new Date('2024-02-02'), outputKg: dec(20), yarnUsedKg: dec(22), rollCount: 4, run: { machineId: 'b', ratePerKg: dec(3) } },
      ]),
    },
    knittingRun: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          {
            machineId: 'a',
            finishedAt: new Date('2024-02-29T23:59:59.999Z'),
            outputKg: dec(4),
            yarnKg: dec(5),
            rollCount: 1,
            knittingCharge: dec(8),
          },
        ]),
      groupBy: jest.fn().mockResolvedValue([
        { machineId: 'a', _count: { _all: 2 } },
        { machineId: 'b', _count: { _all: 1 } },
      ]),
    },
  };
}

describe('machine production reports', () => {
  it('includes the whole end date and a leap day', () => {
    const range = machineReportDates('2024-02-28', '2024-02-29');
    expect(range.gte.toISOString()).toBe('2024-02-28T00:00:00.000Z');
    expect(range.lt.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });

  it.each([
    ['2026-02-30', '2026-03-01'],
    ['', '2026-03-01'],
    ['2026-03-01T00:00:00Z', '2026-03-02'],
    ['2026-03-02', '2026-03-01'],
    ['0000-01-01', '0000-01-02'],
  ])('rejects invalid ranges %s to %s', (from, to) => {
    expect(() => machineReportDates(from, to)).toThrow();
  });

  it('combines production and old one-go finishes, counting each machine date once', async () => {
    const db = database();
    const report = await machineProductionReport(db as unknown as PrismaService, period, true);
    expect(report.totals).toEqual({
      fabricKg: 39,
      yarnKg: 43,
      rolls: 8,
      daysWorked: 3,
      machinesWorked: 2,
      kgPerDay: 13,
      runsFinished: 3,
      charges: 98,
    });
    expect(report.rows.find((row) => row.id === 'a')).toMatchObject({ fabricKg: 19, yarnKg: 21, daysWorked: 2, kgPerDay: 9.5 });
    expect(report.daily[0]).toMatchObject({ date: '2024-02-01', fabricKg: 15, yarnKg: 16, rolls: 3, machinesWorked: 1 });
    expect(report.rows.some((row) => row.id === 'b')).toBe(true);
    expect(report.rows.some((row) => row.id === 'd')).toBe(false);
    expect(db.knittingDayEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { date: { gte: new Date('2024-02-01'), lt: new Date('2024-03-01') } } }),
    );
    expect(db.knittingRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'FINISHED', days: { none: {} } }) }),
    );
    expect(db.knittingDayEntry.findMany.mock.calls[0][0]).not.toHaveProperty('take');
  });

  it('does not expose charges to viewers without price access', async () => {
    const report = await machineProductionReport(database() as unknown as PrismaService, period, false);
    expect(report.pricesShown).toBe(false);
    expect(report.totals.charges).toBeNull();
    expect(report.rows.every((row) => row.charges === null)).toBe(true);
    expect(report.daily.every((day) => day.charges === null)).toBe(true);
  });

  it('filters day entries, old finishes and finished-run counts by machine', async () => {
    const db = database();
    await machineProductionReport(db as unknown as PrismaService, { ...period, machineId: 'b' }, true);
    expect(db.knittingDayEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ run: { machineId: 'b' } }) }),
    );
    expect(db.knittingRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ machineId: 'b' }) }));
    expect(db.knittingRun.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ machineId: 'b' }) }));
  });

  it('rejects an unknown machine', async () => {
    await expect(
      machineProductionReport(database() as unknown as PrismaService, { ...period, machineId: 'missing' }, true),
    ).rejects.toThrow('Machine not found');
  });

  it('returns zeros for a period without production', async () => {
    const db = database();
    db.knittingDayEntry.findMany.mockResolvedValue([]);
    db.knittingRun.findMany.mockResolvedValue([]);
    db.knittingRun.groupBy.mockResolvedValue([]);
    const report = await machineProductionReport(db as unknown as PrismaService, period, true);
    expect(report.totals).toEqual({
      fabricKg: 0,
      yarnKg: 0,
      rolls: 0,
      daysWorked: 0,
      machinesWorked: 0,
      kgPerDay: 0,
      runsFinished: 0,
      charges: 0,
    });
    expect(report.daily).toEqual([]);
  });

  it('validates machine IDs in query requests', async () => {
    const errors = await validate(plainToInstance(MachineReportQueryDto, { ...period, machineId: 'invalid' }));
    expect(errors.some((error) => error.property === 'machineId')).toBe(true);
  });
});
