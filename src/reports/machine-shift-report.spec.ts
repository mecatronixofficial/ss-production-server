import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MoneyService } from '../finance/money.service';
import { buildMachineShiftReport, factoryShift, machineShiftRange, MACHINE_SHIFT_REPORT } from './machine-shift-report';
import { ReportsService } from './reports.service';
import { toExcel, toPdf } from './report-export';

const dec = (n: number) => new Prisma.Decimal(n);
const day = '2026-07-10';
const context = { timezone: 'Asia/Kolkata', now: new Date('2026-11-19T05:30:00Z') };
const run = (fields: Record<string, unknown> = {}) => ({
  id: 'run',
  machineId: 'm1',
  runNo: 'RUN-ONE',
  status: 'RUNNING',
  startedAt: new Date(day),
  startShift: 'DAY',
  finishedAt: null,
  finishShift: null,
  fabricType: 'Rib',
  endReason: null,
  outputKg: dec(300),
  yarnKg: dec(310),
  rollCount: 15,
  knittingCharge: dec(300),
  ratePerKg: dec(1),
  operator: { code: 'EMP1', name: 'Kumar' },
  productionFlow: { flowNo: 'YARN-KT01', fabricType: 'Rib', fabricDiameter: '30', fabricGsm: '180', color: 'Navy' },
  _count: { days: 1 },
  days: [{ outputKg: dec(50), yarnUsedKg: dec(55), rollCount: 3 }],
  ...fields,
});
const machine = (id = 'm1', fields: Record<string, unknown> = {}) => ({
  id,
  code: id.toUpperCase(),
  name: 'Knitting machine',
  status: 'IDLE',
  knittingRuns: [],
  ...fields,
});
function setup(machines = [machine()], runs = [run()]) {
  const prisma = {
    machine: { findMany: jest.fn().mockResolvedValue(machines) },
    knittingRun: { findMany: jest.fn().mockResolvedValue(runs) },
    systemSetting: { findUnique: jest.fn().mockResolvedValue({ value: { name: 'SS Mills', timezone: 'Asia/Kolkata' } }) },
  };
  return { prisma, db: prisma as unknown as PrismaService };
}
const summary = (report: Awaited<ReturnType<typeof buildMachineShiftReport>>, label: string) =>
  report.summary.find((s) => s.label === label)?.value;

describe('Daily company machine shifts', () => {
  it('shows the jobs, operator, construction and running status separately for both shifts', async () => {
    const { db } = setup();
    const report = await buildMachineShiftReport(db, { day }, context);
    const row = report.rows[0];
    expect(row).toMatchObject({
      dayStatus: 'RUNNING',
      nightStatus: 'RUNNING',
      status: 'RUNNING',
      fabricKg: 50,
      yarnKg: 55,
      rolls: 3,
      charges: 50,
    });
    expect(row.dayWork).toContain('YARN-KT01');
    expect(row.nightWork).toContain('Kumar');
    expect(row.dayWork).toContain('30 dia');
    expect(summary(report, 'Fabric knitted')).toBe(50); // one daily figure, never repeated for each shift
    expect(summary(report, 'Day shift machines')).toBe(1);
    expect(summary(report, 'Night shift machines')).toBe(1);
  });
  it('keeps historical status running even if the run has since finished', async () => {
    const { db } = setup([machine()], [run({ status: 'FINISHED', finishedAt: new Date('2026-07-12'), finishShift: 'DAY' })]);
    expect((await buildMachineShiftReport(db, { day }, context)).rows[0].status).toBe('RUNNING');
  });
  it('shows a day-shift stop and the following stopped night, without copying the run lifetime total', async () => {
    const { db } = setup(
      [machine()],
      [
        run({
          startedAt: new Date('2026-07-09'),
          status: 'FINISHED',
          finishedAt: new Date(day),
          finishShift: 'DAY',
          _count: { days: 3 },
          endReason: 'Moved to M2',
        }),
      ],
    );
    const row = (await buildMachineShiftReport(db, { day }, context)).rows[0];
    expect(row).toMatchObject({ dayStatus: 'STOPPED', nightStatus: 'STOPPED', status: 'STOPPED', fabricKg: 50 });
    expect(row.stopped).toContain('Moved to M2');
    expect(row.nightWork).toBe('No recorded run in this shift.');
  });
  it('shows a night-only start and the morning shift without an invented job', async () => {
    const { db } = setup([machine()], [run({ startShift: 'NIGHT' })]);
    const row = (await buildMachineShiftReport(db, { day }, context)).rows[0];
    expect(row).toMatchObject({ dayStatus: 'NO_RECORDED_RUN', nightStatus: 'RUNNING', status: 'RUNNING' });
    expect(row.started).toContain('Night');
  });
  it('preserves multiple jobs and shift changeovers on the same machine', async () => {
    const first = run({
      runNo: 'RUN-FIRST',
      status: 'FINISHED',
      finishedAt: new Date(day),
      finishShift: 'DAY',
      days: [{ outputKg: dec(20), yarnUsedKg: null, rollCount: 1 }],
    });
    const second = run({
      id: 'run2',
      runNo: 'RUN-SECOND',
      status: 'FINISHED',
      finishedAt: new Date(day),
      finishShift: 'NIGHT',
      days: [{ outputKg: dec(30), yarnUsedKg: null, rollCount: 2 }],
    });
    const { db } = setup([machine()], [first, second]);
    const report = await buildMachineShiftReport(db, { day }, context);
    const row = report.rows[0];
    expect(row).toMatchObject({ dayStatus: 'RUNNING', nightStatus: 'STOPPED', status: 'STOPPED', fabricKg: 50, rolls: 3 });
    expect(row.dayWork).toContain('RUN-FIRST');
    expect(row.dayWork).toContain('RUN-SECOND');
    expect(row.nightWork).not.toContain('RUN-FIRST');
    expect(summary(report, 'Runs started / stopped')).toBe('2 / 2');
  });
  it('includes stopped and unassigned machines, and includes disabled machines only with activity', async () => {
    const machines = [
      machine('m1'),
      machine('m2', { knittingRuns: [{ id: 'old' }] }),
      machine('m3'),
      machine('m4', { status: 'DISABLED' }),
      machine('m5', { status: 'DISABLED' }),
    ];
    const { db } = setup(machines, [run(), run({ id: 'disabled-run', machineId: 'm5' })]);
    const report = await buildMachineShiftReport(db, { day }, context);
    expect(report.rows).toHaveLength(4);
    expect(report.rows.find((r) => String(r.machine).startsWith('M2'))?.status).toBe('STOPPED');
    expect(report.rows.find((r) => String(r.machine).startsWith('M3'))).toMatchObject({
      status: 'NO_RECORDED_RUN',
      fabricKg: null,
      productionEntry: 'No work recorded',
    });
    expect(summary(report, 'Fabric knitted')).toBe(100);
  });
  it('does not turn an unentered day into zero production', async () => {
    const { db } = setup([machine()], [run({ days: [] })]);
    const report = await buildMachineShiftReport(db, { day }, context);
    expect(report.rows[0]).toMatchObject({ fabricKg: null, yarnKg: null, rolls: null, productionEntry: 'Not entered' });
    expect(summary(report, 'Production not entered')).toBe(1);
  });
  it('counts legacy completion once and marks missing historical stop shifts unknown', async () => {
    const { db } = setup(
      [machine()],
      [
        run({
          status: 'FINISHED',
          finishedAt: new Date(day),
          finishShift: null,
          _count: { days: 0 },
          days: [],
          outputKg: dec(100),
          yarnKg: dec(105),
          knittingCharge: dec(25),
        }),
      ],
    );
    const report = await buildMachineShiftReport(db, { day }, context);
    expect(report.rows[0]).toMatchObject({
      status: 'UNKNOWN',
      fabricKg: 100,
      yarnKg: 105,
      charges: 25,
      productionEntry: 'Includes legacy completion',
    });
    expect(summary(report, 'Fabric knitted')).toBe(100);
  });
  it('marks the unstarted night as future and uses the current day-shift snapshot', async () => {
    const { db } = setup();
    const report = await buildMachineShiftReport(db, { day }, { ...context, now: new Date('2026-07-10T06:00:00Z') });
    expect(report.rows[0]).toMatchObject({ dayStatus: 'RUNNING', nightStatus: 'NOT_STARTED', status: 'RUNNING' });
    expect(summary(report, 'Night shift machines')).toBe(0);
  });
  it('attributes the after-midnight night shift to its production day, including the 9 AM boundary', () => {
    expect(factoryShift(new Date('2026-07-11T03:29:00Z'))).toMatchObject({ date: '2026-07-10', shift: 'NIGHT' });
    expect(factoryShift(new Date('2026-07-11T03:30:00Z'))).toMatchObject({ date: '2026-07-11', shift: 'DAY' });
    expect(factoryShift(new Date('2026-07-11T15:30:00Z'))).toMatchObject({ date: '2026-07-11', shift: 'NIGHT' });
  });
  it('filters the database and report to one machine', async () => {
    const { db, prisma } = setup();
    await buildMachineShiftReport(db, { day, machineId: 'm1' }, context);
    expect(prisma.machine.findMany.mock.calls[0][0].where).toEqual({ id: 'm1' });
    expect(prisma.knittingRun.findMany.mock.calls[0][0].where.machineId).toBe('m1');
    const none = setup([], []);
    await expect(buildMachineShiftReport(none.db, { day, machineId: 'missing' }, context)).rejects.toThrow('Machine not found');
  });
  it('rejects impossible, future, and multi-day selections instead of silently reporting another date', () => {
    expect(() => machineShiftRange({ day: '2026-02-30' }, context.now)).toThrow('valid production day');
    expect(() => machineShiftRange({ day: '2026-12-01' }, context.now)).toThrow('earlier production day');
    expect(() => machineShiftRange({ from: new Date(day), to: new Date('2026-07-12') }, context.now)).toThrow('one production day');
  });
  it('uses decimal charges and does not multiply the whole run charge by its number of shifts', async () => {
    const { db } = setup([machine()], [run({ ratePerKg: dec(0.1), days: [{ outputKg: dec(0.05), yarnUsedKg: null, rollCount: 1 }] })]);
    expect((await buildMachineShiftReport(db, { day }, context)).rows[0].charges).toBe(0.01);
  });
  it('registers in Reports and exports the same machine/day data to Excel and a complete PDF', async () => {
    const { db } = setup();
    const service = new ReportsService(db, {} as MoneyService);
    expect(service.catalog()).toEqual(expect.arrayContaining([expect.objectContaining({ key: MACHINE_SHIFT_REPORT, group: 'Machines' })]));
    const report = await service.run(MACHINE_SHIFT_REPORT, { day, machineId: 'm1' });
    expect(report).toMatchObject({
      from: '2026-07-10T00:00:00.000Z',
      to: '2026-07-11T00:00:00.000Z',
      machineId: 'm1',
      totals: { fabricKg: 50, yarnKg: 55, rolls: 3 },
      top: null,
    });
    const excel = await toExcel(report);
    expect(excel.subarray(0, 2).toString()).toBe('PK');
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(excel as unknown as Parameters<typeof book.xlsx.load>[0]);
    const sheet = book.worksheets[0];
    const workIndex = report.columns.findIndex((c) => c.key === 'dayWork') + 1;
    expect(sheet.getRow(7).getCell(workIndex).value).toContain('Operator EMP1 Kumar');
    expect(sheet.getRow(7).getCell(workIndex).alignment.wrapText).toBe(true);
    const pdf = await toPdf(report);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(2000);
  });
});
