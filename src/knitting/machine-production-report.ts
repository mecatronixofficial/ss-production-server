import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MachineReportQueryDto } from './dto/machine-report.dto';

const EMPTY = 0.0005;
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const iso = (value: Date) => value.toISOString().slice(0, 10);

/** Dates include the whole final production day, even when a finish has a time component. */
export function machineReportDates(from: string, to: string) {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1)
      throw new BadRequestException('Choose dates in YYYY-MM-DD format');
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || iso(date) !== value) throw new BadRequestException('Choose valid calendar dates');
    return date;
  };
  const gte = parse(from);
  const end = parse(to);
  if (gte > end) throw new BadRequestException('The from date must be on or before the to date');
  const lt = new Date(end);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte, lt };
}

type Work = { days: Set<string>; fabricKg: number; yarnKg: number; rolls: number; charges: Prisma.Decimal };
type Daily = { date: string; machines: Set<string>; fabricKg: number; yarnKg: number; rolls: number; charges: Prisma.Decimal };

/** Uncapped date-filtered production; independent of the recent board and runs register. */
export async function machineProductionReport(prisma: PrismaService, query: MachineReportQueryDto, pricesShown: boolean) {
  const date = machineReportDates(query.from, query.to);
  const scope = query.machineId ? { machineId: query.machineId } : {};
  const [machines, entries, oneGo, finished] = await Promise.all([
    prisma.machine.findMany({ select: { id: true, code: true, name: true, status: true }, orderBy: { code: 'asc' } }),
    prisma.knittingDayEntry.findMany({
      where: { date, ...(query.machineId ? { run: scope } : {}) },
      select: { date: true, outputKg: true, yarnUsedKg: true, rollCount: true, run: { select: { machineId: true, ratePerKg: true } } },
    }),
    prisma.knittingRun.findMany({
      where: { ...scope, status: 'FINISHED', finishedAt: date, days: { none: {} } },
      select: { machineId: true, finishedAt: true, outputKg: true, yarnKg: true, rollCount: true, knittingCharge: true },
    }),
    prisma.knittingRun.groupBy({ by: ['machineId'], where: { ...scope, status: 'FINISHED', finishedAt: date }, _count: { _all: true } }),
  ]);
  if (query.machineId && !machines.some((machine) => machine.id === query.machineId)) throw new NotFoundException('Machine not found');
  const work = new Map<string, Work>();
  const daily = new Map<string, Daily>();
  const add = (machineId: string, when: Date, fabricKg: number, yarnKg: number, rolls: number, charges: Prisma.Decimal) => {
    const key = iso(when);
    const machine = work.get(machineId) ?? { days: new Set<string>(), fabricKg: 0, yarnKg: 0, rolls: 0, charges: new Prisma.Decimal(0) };
    const day = daily.get(key) ?? {
      date: key,
      machines: new Set<string>(),
      fabricKg: 0,
      yarnKg: 0,
      rolls: 0,
      charges: new Prisma.Decimal(0),
    };
    if (fabricKg > EMPTY) {
      machine.days.add(key);
      day.machines.add(machineId);
    }
    machine.fabricKg += fabricKg;
    machine.yarnKg += yarnKg;
    machine.rolls += rolls;
    machine.charges = machine.charges.add(charges);
    day.fabricKg += fabricKg;
    day.yarnKg += yarnKg;
    day.rolls += rolls;
    day.charges = day.charges.add(charges);
    work.set(machineId, machine);
    daily.set(key, day);
  };
  for (const entry of entries) {
    const fabricKg = Number(entry.outputKg);
    const charges = entry.outputKg.mul(entry.run.ratePerKg).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    add(entry.run.machineId, entry.date, fabricKg, Number(entry.yarnUsedKg ?? entry.outputKg), entry.rollCount, charges);
  }
  // A historical finish counts once, only when that run has no day entries.
  for (const run of oneGo)
    if (run.finishedAt) {
      add(
        run.machineId,
        run.finishedAt,
        Number(run.outputKg ?? 0),
        Number(run.yarnKg),
        run.rollCount ?? 0,
        run.knittingCharge ?? new Prisma.Decimal(0),
      );
    }
  const finishedBy = new Map(finished.map((row) => [row.machineId, row._count._all]));
  const rows = machines
    .filter(
      (machine) =>
        (!query.machineId || machine.id === query.machineId) &&
        (machine.status !== 'DISABLED' || work.has(machine.id) || finishedBy.has(machine.id)),
    )
    .map((machine) => {
      const value = work.get(machine.id);
      const fabricKg = round(value?.fabricKg ?? 0);
      const daysWorked = value?.days.size ?? 0;
      return {
        ...machine,
        fabricKg,
        yarnKg: round(value?.yarnKg ?? 0),
        rolls: value?.rolls ?? 0,
        daysWorked,
        kgPerDay: daysWorked ? round(fabricKg / daysWorked) : 0,
        runsFinished: finishedBy.get(machine.id) ?? 0,
        charges: pricesShown ? Number(value?.charges.toFixed(2) ?? 0) : null,
      };
    });
  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  const fabricKg = round(rows.reduce((sum, row) => sum + row.fabricKg, 0));
  const daysWorked = days.filter((day) => day.machines.size > 0).length;
  return {
    from: query.from,
    to: query.to,
    machineId: query.machineId ?? null,
    pricesShown,
    machines,
    rows,
    daily: days.map((day) => ({
      date: day.date,
      fabricKg: round(day.fabricKg),
      yarnKg: round(day.yarnKg),
      rolls: day.rolls,
      machinesWorked: day.machines.size,
      charges: pricesShown ? Number(day.charges.toFixed(2)) : null,
    })),
    totals: {
      fabricKg,
      yarnKg: round(rows.reduce((sum, row) => sum + row.yarnKg, 0)),
      rolls: rows.reduce((sum, row) => sum + row.rolls, 0),
      daysWorked,
      machinesWorked: rows.filter((row) => row.daysWorked > 0).length,
      kgPerDay: daysWorked ? round(fabricKg / daysWorked) : 0,
      runsFinished: rows.reduce((sum, row) => sum + row.runsFinished, 0),
      charges: pricesShown ? Number(days.reduce((sum, day) => sum.add(day.charges), new Prisma.Decimal(0)).toFixed(2)) : null,
    },
  };
}
