import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DateRange, ReportBody, ReportContext, ReportDefinition, ReportRow, round } from './report-types';

export const MACHINE_SHIFT_REPORT = 'machine-daily-shifts';
const DAY_MS = 86_400_000;
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const dateOf = (key: string) => new Date(`${key}T00:00:00Z`);
const index = (date: Date, shift: string) => Math.floor(dateOf(dateKey(date)).getTime() / DAY_MS) * 2 + (shift === 'NIGHT' ? 1 : 0);

/** A production day starts at 9 AM IST and includes the following night, to 9 AM next morning. */
export function factoryShift(now: Date) {
  const local = new Date(now.getTime() + 330 * 60_000);
  const hour = local.getUTCHours();
  if (hour < 9) local.setUTCDate(local.getUTCDate() - 1);
  const date = dateKey(local);
  return { date, shift: hour >= 9 && hour < 21 ? 'DAY' : 'NIGHT', index: index(dateOf(date), hour >= 9 && hour < 21 ? 'DAY' : 'NIGHT') };
}

export function machineShiftRange(range: DateRange, now: Date): DateRange {
  const day = range.day ?? (range.from ? dateKey(range.from) : factoryShift(now).date);
  const from = dateOf(day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(from.getTime()) || dateKey(from) !== day)
    throw new BadRequestException('Choose a valid production day');
  if (day > factoryShift(now).date) throw new BadRequestException('Choose the current or an earlier production day');
  const to = new Date(from.getTime() + DAY_MS);
  if (!range.day && range.to && range.to.getTime() !== to.getTime())
    throw new BadRequestException('Choose one production day for the machine shift report');
  return { from, to, day, machineId: range.machineId };
}

const runSelect = {
  id: true,
  machineId: true,
  runNo: true,
  status: true,
  startedAt: true,
  startShift: true,
  finishedAt: true,
  finishShift: true,
  fabricType: true,
  endReason: true,
  outputKg: true,
  yarnKg: true,
  rollCount: true,
  knittingCharge: true,
  ratePerKg: true,
  operator: { select: { code: true, name: true } },
  productionFlow: { select: { flowNo: true, fabricType: true, fabricDiameter: true, fabricGsm: true, color: true } },
  _count: { select: { days: true } },
} satisfies Prisma.KnittingRunSelect;
type Run = Prisma.KnittingRunGetPayload<{ select: typeof runSelect }>;
const endIndex = (run: Run) => (run.finishedAt ? index(run.finishedAt, run.finishShift ?? 'NIGHT') : Infinity);
const shiftName = (shift: string | null) =>
  shift === 'DAY' ? 'Day (9 AM - 9 PM)' : shift === 'NIGHT' ? 'Night (9 PM - 9 AM next day)' : 'Shift not recorded';
const startText = (run: Run) => `${run.runNo}: ${dateKey(run.startedAt)} ${shiftName(run.startShift)}`;
const stopText = (run: Run) =>
  run.finishedAt
    ? `${run.runNo}: ${dateKey(run.finishedAt)} ${shiftName(run.finishShift)}${run.endReason ? ` - ${run.endReason}` : ''}`
    : '';
function workText(run: Run) {
  const f = run.productionFlow;
  return [
    run.runNo,
    f?.flowNo,
    [run.fabricType || f?.fabricType, f?.fabricDiameter && `${f.fabricDiameter} dia`, f?.fabricGsm && `${f.fabricGsm} GSM`, f?.color]
      .filter(Boolean)
      .join(' / '),
    run.operator ? `Operator ${run.operator.code} ${run.operator.name}` : 'Operator not recorded',
    `Started ${dateKey(run.startedAt)} ${shiftName(run.startShift)}`,
    run.finishedAt
      ? `Stopped ${dateKey(run.finishedAt)} ${shiftName(run.finishShift)}${run.endReason ? ` - ${run.endReason}` : ''}`
      : 'Run remains open',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Recorded activity, not estimated runtime or a guessed split of full-day production. */
export async function buildMachineShiftReport(prisma: PrismaService, requested: DateRange, context: ReportContext): Promise<ReportBody> {
  const range = machineShiftRange(requested, context.now);
  const day = range.day!;
  const now = factoryShift(context.now);
  const scope = range.machineId ? { machineId: range.machineId } : {};
  const [machines, runs] = await Promise.all([
    prisma.machine.findMany({
      where: range.machineId ? { id: range.machineId } : {},
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        knittingRuns: { where: { finishedAt: { lt: range.from! } }, take: 1, select: { id: true } },
      },
      orderBy: { code: 'asc' },
    }),
    prisma.knittingRun.findMany({
      where: { ...scope, startedAt: { lt: range.to! }, OR: [{ finishedAt: null }, { finishedAt: { gte: range.from! } }] },
      select: {
        ...runSelect,
        days: { where: { date: { gte: range.from!, lt: range.to! } }, select: { outputKg: true, yarnUsedKg: true, rollCount: true } },
      },
      orderBy: [{ startedAt: 'asc' }, { startShift: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);
  if (range.machineId && !machines.length) throw new NotFoundException('Machine not found');
  const rows: ReportRow[] = [];
  let dayWorked = 0,
    nightWorked = 0,
    starts = 0,
    stops = 0,
    missing = 0;
  for (const machine of machines) {
    const own = runs.filter((r) => r.machineId === machine.id);
    const active = own.filter(
      (r) => index(r.startedAt, r.startShift) <= index(range.from!, 'NIGHT') && endIndex(r) >= index(range.from!, 'DAY'),
    );
    if (machine.status === 'DISABLED' && !active.length) continue;
    const shift = (name: 'DAY' | 'NIGHT') => {
      const at = index(range.from!, name);
      if (at > now.index) return { state: 'NOT_STARTED', work: 'This shift has not started.', worked: false };
      const working = active.filter((r) => index(r.startedAt, r.startShift) <= at && endIndex(r) >= at);
      const uncertain = working.some(
        (r) => (r.finishedAt && dateKey(r.finishedAt) === day && !r.finishShift) || (r.status === 'FINISHED' && !r.finishedAt),
      );
      const running = working.some((r) => (endIndex(r) > at && r.status === 'RUNNING') || (r.finishedAt && endIndex(r) > at));
      const stopped = working.length > 0 || machine.knittingRuns.length > 0 || own.some((r) => endIndex(r) < at);
      return {
        state: uncertain ? 'UNKNOWN' : running ? 'RUNNING' : stopped ? 'STOPPED' : 'NO_RECORDED_RUN',
        work: working.map(workText).join('\n\n') || 'No recorded run in this shift.',
        worked: working.length > 0,
      };
    };
    const dayShift = shift('DAY'),
      nightShift = shift('NIGHT');
    if (dayShift.worked) dayWorked++;
    if (nightShift.worked) nightWorked++;
    const began = active.filter((r) => dateKey(r.startedAt) === day && index(r.startedAt, r.startShift) <= now.index);
    const ended = active.filter((r) => r.finishedAt && dateKey(r.finishedAt) === day && endIndex(r) <= now.index);
    starts += began.length;
    stops += ended.length;
    let fabric = 0,
      yarn = 0,
      rolls = 0,
      charge = new Prisma.Decimal(0),
      entered = false,
      legacy = false;
    for (const run of own) {
      for (const entry of run.days) {
        entered = true;
        fabric += Number(entry.outputKg);
        yarn += Number(entry.yarnUsedKg ?? entry.outputKg);
        rolls += entry.rollCount;
        charge = charge.add(entry.outputKg.mul(run.ratePerKg).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP));
      }
      if (
        run.status === 'FINISHED' &&
        run.finishedAt &&
        dateKey(run.finishedAt) === day &&
        run._count.days === 0 &&
        run.outputKg !== null
      ) {
        entered = true;
        legacy = true;
        fabric += Number(run.outputKg);
        yarn += Number(run.yarnKg);
        rolls += run.rollCount ?? 0;
        charge = charge.add(run.knittingCharge ?? 0);
      }
    }
    if (active.length && !entered) missing++;
    rows.push({
      date: range.from!.toISOString(),
      machine: `${machine.code} · ${machine.name}`,
      dayStatus: dayShift.state,
      dayWork: dayShift.work,
      nightStatus: nightShift.state,
      nightWork: nightShift.work,
      status: nightShift.state === 'NOT_STARTED' ? dayShift.state : nightShift.state,
      started: began.map(startText).join('\n') || '—',
      stopped: ended.map(stopText).join('\n') || '—',
      productionEntry: entered
        ? legacy
          ? 'Includes legacy completion'
          : 'Recorded daily total'
        : active.length
          ? 'Not entered'
          : 'No work recorded',
      fabricKg: entered ? round(fabric) : null,
      yarnKg: entered ? round(yarn) : null,
      rolls: entered ? rolls : null,
      charges: entered ? Number(charge.toFixed(2)) : null,
      currentCondition: machine.status,
    });
  }
  const total = (key: string) => round(rows.reduce((s, r) => s + Number(r[key] ?? 0), 0));
  const snapshot = day === now.date ? 'At report generation' : 'At the close of the selected day';
  return {
    columns: [
      { key: 'date', label: 'Production day', type: 'date' },
      { key: 'machine', label: 'Machine', type: 'text' },
      { key: 'dayStatus', label: 'Day shift status', type: 'status' },
      { key: 'dayWork', label: 'Day shift work · 9 AM - 9 PM', type: 'text' },
      { key: 'nightStatus', label: 'Night shift status', type: 'status' },
      { key: 'nightWork', label: 'Night shift work · 9 PM - 9 AM', type: 'text' },
      { key: 'status', label: 'Day snapshot', type: 'status' },
      { key: 'started', label: 'Started this day', type: 'text' },
      { key: 'stopped', label: 'Stopped this day', type: 'text' },
      { key: 'productionEntry', label: 'Production entry', type: 'text' },
      { key: 'fabricKg', label: 'Full-day fabric KG', type: 'kg', total: true },
      { key: 'yarnKg', label: 'Full-day yarn KG', type: 'kg', total: true },
      { key: 'rolls', label: 'Full-day rolls', type: 'number', total: true },
      { key: 'charges', label: 'Knitting charges', type: 'money', total: true },
      { key: 'currentCondition', label: 'Machine condition now', type: 'status' },
    ],
    rows,
    summary: [
      { label: 'Machines', value: rows.length, type: 'number' },
      { label: 'Running', value: rows.filter((r) => r.status === 'RUNNING').length, type: 'number', hint: snapshot },
      { label: 'Stopped', value: rows.filter((r) => r.status === 'STOPPED').length, type: 'number', hint: snapshot },
      { label: 'No recorded run', value: rows.filter((r) => r.status === 'NO_RECORDED_RUN').length, type: 'number' },
      { label: 'Unknown shift status', value: rows.filter((r) => r.status === 'UNKNOWN').length, type: 'number' },
      { label: 'Day shift machines', value: dayWorked, type: 'number' },
      { label: 'Night shift machines', value: nightWorked, type: 'number' },
      { label: 'Fabric knitted', value: total('fabricKg'), type: 'kg', hint: 'Recorded full-day totals' },
      { label: 'Yarn used', value: total('yarnKg'), type: 'kg' },
      { label: 'Rolls', value: total('rolls'), type: 'number' },
      { label: 'Runs started / stopped', value: `${starts} / ${stops}`, type: 'text' },
      { label: 'Production not entered', value: missing, type: 'number', hint: 'Machines with activity but no daily entry' },
    ],
    note: `Production day ${day}: Day 9 AM - 9 PM IST; Night 9 PM - 9 AM the following morning. Status is derived from recorded run start/stop shifts; exact clock times and operating hours are not recorded. Production is one full-day total, counted once across both shifts; a blank means not entered. Future shifts show Not started, and missing legacy stop shifts show Unknown. Machine condition now is the current master status, including on historical reports. ${snapshot}.`,
  };
}

export const machineShiftDefinition = (prisma: PrismaService): ReportDefinition => ({
  key: MACHINE_SHIFT_REPORT,
  title: 'Daily machine & shift report',
  group: 'Machines',
  description:
    'Every machine for one full production day: day/night jobs, operators, start and stop shifts, running or stopped status, and company production totals.',
  dateLabel: 'Production day',
  top: null,
  build: (range, ctx) => buildMachineShiftReport(prisma, range, ctx),
});
