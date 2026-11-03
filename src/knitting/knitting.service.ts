import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { KnittingShift, MachineStatus, Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { lockKeys } from '../common/locks';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { MACHINE_ROLES } from '../common/roles';
import { notifyRoles } from '../notifications/notify.util';
import { notifyProcessDone } from '../production/process-notify';
import { AssignMachineDto, AssignMachinesDto, CompleteTaskDto, DayEntriesDto, FinishRunDto, MoveRunDto, StartRunDto } from './dto/knitting-run.dto';
import { poolFigures, poolSelect, settleYarnUsed } from '../production/yarn-return';

/**
 * Fabric normally weighs about the yarn knitted, within this. A task knitted to within it of its yarn is taken as
 * fully knitted when its last machine stops.
 */
export const KNITTING_TOLERANCE_KG = 20;

const EMPTY = 0.0005;
const DAY_MS = 86_400_000;
/** Stopped runs the Machines floor loads with the running ones; older ones load on request. */
const BOARD_DAYS = 62;

const runInclude = {
  machine: { select: { id: true, code: true, name: true, type: true } },
  operator: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  yarns: { include: { warehouse: { select: { code: true, name: true } } }, orderBy: { kg: 'desc' as const } },
  productionFlow: {
    select: {
      id: true,
      flowNo: true,
      purchasedWeightKg: true,
      yarnCount: true,
      color: true,
      fabricDiameter: true,
      fabricGsm: true,
      knittingGg: true,
      knittingLl: true,
      knittingExpectedFinishDate: true,
      knittingFinishedAt: true,
      // Every machine on the task, so a run knows where the rest of its task's work is.
      knittingRuns: { select: { id: true, runNo: true, status: true, outputKg: true, machine: { select: { id: true, code: true } } }, orderBy: { createdAt: 'asc' } },
    },
  },
  days: { include: { warehouse: { select: { id: true, code: true, name: true } } }, orderBy: { date: 'desc' as const } },
} satisfies Prisma.KnittingRunInclude;

type RunRow = Prisma.KnittingRunGetPayload<{ include: typeof runInclude }>;

/** A run as changes need it, loaded under its lock. */
const lockedInclude = {
  machine: true,
  yarns: true,
  productionFlow: { select: { id: true, flowNo: true, status: true } },
} satisfies Prisma.KnittingRunInclude;
type LockedRun = Prisma.KnittingRunGetPayload<{ include: typeof lockedInclude }>;

const num = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const SHIFT_LABEL: Record<KnittingShift, string> = { DAY: 'Day', NIGHT: 'Night' };
const OUT_OF_SERVICE: MachineStatus[] = [MachineStatus.DISABLED, MachineStatus.MAINTENANCE, MachineStatus.BREAKDOWN];
const kgText = (value: number) => `${value.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KG`;

/** Shifts in order: the day's Day shift (9 AM–9 PM) comes before its Night shift (9 PM–9 AM). */
const shiftIndex = (date: Date, shift: KnittingShift) => Math.floor(date.getTime() / DAY_MS) * 2 + (shift === 'NIGHT' ? 1 : 0);
const dayIndex = (date: Date) => Math.floor(date.getTime() / DAY_MS);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
/** Dates come as YYYY-MM-DD; a day "still to come" allows for the factory's clock being ahead of UTC. */
const inFuture = (date: Date) => dayIndex(date) > dayIndex(new Date()) + 1;

/** A run with plain numbers and its sums: fabric day by day, average per day, cost per KG. */
function runView(run: RunRow) {
  const yarnKg = Number(run.yarnKg);
  const yarnCost = Number(run.yarnCost);
  const outputKg = num(run.outputKg);
  const knittingCharge = num(run.knittingCharge);
  const totalCost = round(yarnCost + (knittingCharge ?? 0), 2);
  const days = run.days.map((day) => ({ id: day.id, date: isoDay(day.date), outputKg: Number(day.outputKg), rollCount: day.rollCount, yarnUsedKg: num(day.yarnUsedKg), warehouse: day.warehouse, notes: day.notes }));
  const worked = days.filter((day) => day.outputKg > EMPTY);
  const { productionFlow, ...rest } = run;
  return {
    ...rest,
    productionFlow: productionFlow && {
      ...productionFlow,
      purchasedWeightKg: Number(productionFlow.purchasedWeightKg),
      knittedKg: round(productionFlow.knittingRuns.reduce((sum, r) => sum + Number(r.outputKg ?? 0), 0), 3),
      knittingRuns: productionFlow.knittingRuns.map((r) => ({ ...r, outputKg: num(r.outputKg) })),
    },
    yarnKg,
    yarnCost,
    ratePerKg: Number(run.ratePerKg),
    outputKg,
    knittingCharge,
    totalCost,
    costPerKg: outputKg ? round(totalCost / outputKg, 2) : null,
    shifts: run.finishedAt && run.finishShift ? shiftIndex(run.finishedAt, run.finishShift) - shiftIndex(run.startedAt, run.startShift) + 1 : null,
    days,
    /** Fabric per production day the machine knitted. */
    avgPerDayKg: worked.length ? round(worked.reduce((sum, day) => sum + day.outputKg, 0) / worked.length, 3) : null,
    yarns: run.yarns.map((yarn) => {
      const kg = Number(yarn.kg);
      const rate = Number(yarn.ratePerKg);
      return { ...yarn, kg, ratePerKg: rate, cost: round(kg * rate, 2), sharePct: yarnKg ? round((kg / yarnKg) * 100, 2) : run.yarns.length === 1 ? 100 : 0 };
    }),
  };
}

type Production = { outputKg: number; rollCount: number; yarnUsedKg?: number; notes?: string };

@Injectable()
export class KnittingService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  /** Machines, operators, warehouses, and which machines are knitting now. */
  async context() {
    const [machines, operators, warehouses, busy] = await Promise.all([
      this.prisma.machine.findMany({
        where: { status: { not: MachineStatus.DISABLED } },
        select: { id: true, code: true, name: true, type: true, ratePerKg: true, manufacturer: true, status: true, updatedAt: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.employee.findMany({ where: { active: true }, select: { id: true, code: true, name: true, department: true, mobile: true, shift: true }, orderBy: { name: 'asc' } }),
      this.prisma.warehouse.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      this.prisma.knittingRun.findMany({ where: { status: 'RUNNING' }, select: { machineId: true } }),
    ]);
    return {
      machines: machines.map((m) => ({ ...m, ratePerKg: num(m.ratePerKg) ?? 0 })),
      operators,
      warehouses,
      busyMachineIds: busy.map((r) => r.machineId),
      toleranceKg: KNITTING_TOLERANCE_KG,
    };
  }

  /**
   * Everything the Machines floor shows, in one request: the context, the open tasks, the runs knitting now and the
   * runs that stopped in the last `BOARD_DAYS` days (enough for yesterday, this month and the recent register).
   */
  async board() {
    const since = new Date(Date.now() - BOARD_DAYS * DAY_MS);
    const [context, runs, tasks] = await Promise.all([
      this.context(),
      this.prisma.knittingRun.findMany({
        where: { OR: [{ status: 'RUNNING' }, { finishedAt: { gte: since } }] },
        include: runInclude,
        orderBy: [{ status: 'asc' }, { startedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      this.openTasks(),
    ]);
    return { ...context, tasks, runs: runs.map(runView), since: isoDay(since) };
  }

  /** Own-mill Production tasks still being knitted, with the fabric so far and the machines on them now. */
  private async openTasks() {
    const flows = await this.prisma.fabricProductionFlow.findMany({
      where: { status: 'KNITTING', knittingMillType: 'OWN', knittingFinishedAt: null },
      select: {
        id: true,
        flowNo: true,
        yarnItemCode: true,
        yarnCount: true,
        yarnLotNo: true,
        purchasedWeightKg: true,
        fabricType: true,
        fabricDiameter: true,
        fabricGsm: true,
        color: true,
        knittingGg: true,
        knittingLl: true,
        knittingPartyDetails: true,
        knittingDate: true,
        knittingExpectedFinishDate: true,
        // With id, flowNo and purchasedWeightKg above: what its share of a shared yarn needs.
        yarnIssueTxnId: true,
        yarnReturnTxnId: true,
        yarnReceivedKg: true,
        knittingFinishedAt: true,
        knittingRuns: { select: { id: true, runNo: true, status: true, outputKg: true, yarnKg: true, machine: { select: { id: true, code: true, name: true } } }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ knittingExpectedFinishDate: { sort: 'asc', nulls: 'last' } }, { purchaseDate: 'asc' }],
    });
    // Fabric types started together share one yarn: what is left of it for each, from all of them (finished too).
    const issues = [...new Set(flows.map((f) => f.yarnIssueTxnId).filter((id): id is string => !!id))];
    const groups = issues.length ? await this.prisma.fabricProductionFlow.findMany({ where: { yarnIssueTxnId: { in: issues } }, select: poolSelect }) : [];
    return flows.map((flow) => {
      const yarnPool = poolFigures(flow, groups.filter((g) => g.yarnIssueTxnId === flow.yarnIssueTxnId));
      const purchasedWeightKg = Number(flow.purchasedWeightKg);
      const knittingRuns = flow.knittingRuns.map((r) => ({ ...r, outputKg: num(r.outputKg), yarnKg: Number(r.yarnKg) }));
      const knittedKg = round(knittingRuns.reduce((sum, r) => sum + (r.outputKg ?? 0), 0), 3);
      return {
        ...flow,
        purchasedWeightKg,
        knittingRuns,
        knittedKg,
        remainingKg: round(Math.max(0, purchasedWeightKg - knittedKg), 3),
        running: knittingRuns.filter((r) => r.status === 'RUNNING'),
        yarnPool,
        /** Yarn the machines used so far, from their day-end entries. */
        yarnUsedSoFarKg: round(knittingRuns.reduce((sum, r) => sum + r.yarnKg, 0), 3),
        /** The yarn this task can still use: its own, or what is left of the yarn it shares. */
        yarnAvailableKg: yarnPool ? yarnPool.leftForThisKg : Number(flow.yarnReceivedKg ?? flow.purchasedWeightKg),
      };
    });
  }

  /** Runs with their days, the ones knitting now first: one run by code, one machine's, or the latest 1000. */
  async runs(filter: { code?: string; machineId?: string } = {}) {
    const where: Prisma.KnittingRunWhereInput = {
      ...(filter.code ? { runNo: { equals: filter.code.trim(), mode: 'insensitive' } } : {}),
      ...(filter.machineId ? { machineId: filter.machineId } : {}),
    };
    const runs = await this.prisma.knittingRun.findMany({
      where,
      include: runInclude,
      orderBy: [{ status: 'asc' }, { startedAt: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
    return runs.map(runView);
  }

  private async view(tx: Prisma.TransactionClient, id: string) {
    return runView(await tx.knittingRun.findUniqueOrThrow({ where: { id }, include: runInclude }));
  }

  private async loadRun(tx: Prisma.TransactionClient, id: string): Promise<LockedRun> {
    const run = await tx.knittingRun.findUnique({ where: { id }, include: lockedInclude });
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  private async activeWarehouse(tx: Prisma.TransactionClient, id: string) {
    const warehouse = await tx.warehouse.findFirst({ where: { id, active: true }, select: { id: true, code: true } });
    if (!warehouse) throw new BadRequestException('Choose an active warehouse for the fabric');
    return warehouse;
  }

  /** A task's knitting can only change while the batch is at knitting (not yet at dyeing). */
  private assertTaskAtKnitting(run: LockedRun) {
    if (run.productionFlow && run.productionFlow.status !== 'KNITTING') {
      throw new BadRequestException(`${run.productionFlow.flowNo} has moved on to ${run.productionFlow.status.toLowerCase()}; its knitting can't change now`);
    }
  }

  /** An own-mill Production task still being knitted, for putting on machines. */
  private async openTask(tx: Prisma.TransactionClient, flowId: string) {
    const task = await tx.fabricProductionFlow.findFirst({ where: { id: flowId, knittingMillType: 'OWN' } });
    if (!task) throw new NotFoundException('Production knitting task not found');
    if (task.status !== 'KNITTING') throw new BadRequestException(`${task.flowNo} is at ${task.status.toLowerCase()}, not knitting`);
    if (task.knittingFinishedAt) throw new BadRequestException(`${task.flowNo}'s knitting is marked complete; open it again first`);
    if (!task.yarnItemCode || !task.yarnWarehouseId) throw new BadRequestException(`${task.flowNo} has no allocated yarn stock`);
    return task;
  }

  /** A machine that can take work: in service and not knitting another run. */
  private async freeMachine(tx: Prisma.TransactionClient, machineId: string) {
    const machine = await tx.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw new NotFoundException('Machine not found');
    if (OUT_OF_SERVICE.includes(machine.status)) {
      throw new BadRequestException(`${machine.code} is set to ${machine.status.toLowerCase()}; set it back to Idle before giving it work`);
    }
    const busy = await tx.knittingRun.findFirst({ where: { machineId: machine.id, status: 'RUNNING' }, select: { runNo: true } });
    if (busy) throw new BadRequestException(`${machine.code} is already knitting ${busy.runNo}; finish that run or move it first`);
    return machine;
  }

  /** Starts a task on one machine as the task's next round (…-R1, -R2). Nothing is loaded up front: the days record what it knits. */
  private async startOnMachine(
    tx: Prisma.TransactionClient,
    task: Awaited<ReturnType<KnittingService['openTask']>>,
    pick: AssignMachineDto,
    when: { startDate: string; startShift: KnittingShift; notes?: string },
    user: AuthUser,
  ) {
    const machine = await this.freeMachine(tx, pick.machineId);
    if (pick.operatorId && !(await tx.employee.findFirst({ where: { id: pick.operatorId, active: true }, select: { id: true } }))) {
      throw new BadRequestException('Choose an active operator');
    }
    const startedAt = new Date(when.startDate);
    if (inFuture(startedAt)) throw new BadRequestException('The start date is still to come');
    const rounds = await tx.knittingRun.findMany({ where: { productionFlowId: task.id }, select: { runNo: true } });
    const lastRound = rounds.reduce((max, run) => Math.max(max, Number(run.runNo.match(/-R(\d+)$/)?.[1] ?? 0)), 0);
    const runNo = `${task.flowNo}-R${lastRound + 1}`;
    const run = await tx.knittingRun.create({
      data: {
        runNo,
        machineId: machine.id,
        fabricType: task.fabricType ?? null,
        productionFlowId: task.id,
        startedAt,
        startShift: when.startShift,
        operatorId: pick.operatorId || null,
        yarnKg: 0,
        yarnCost: 0,
        ratePerKg: pick.ratePerKg ?? num(machine.ratePerKg) ?? 0,
        notes: when.notes?.trim() || null,
        createdById: user.id,
      },
    });
    await tx.knittingRunYarn.create({
      data: {
        runId: run.id,
        itemCode: task.yarnItemCode!,
        itemName: `${task.yarnCount} yarn`,
        category: 'YARN',
        warehouseId: task.yarnWarehouseId!,
        lotNo: task.yarnLotNo,
        kg: 0,
        ratePerKg: task.yarnRatePerKg,
        issueTxnId: task.yarnIssueTxnId,
      },
    });
    await tx.machine.update({ where: { id: machine.id }, data: { status: MachineStatus.RUNNING } });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'KNITTING_RUN_STARTED',
        module: 'knitting',
        entity: 'KnittingRun',
        entityId: run.id,
        newValue: { runNo, task: task.flowNo, machine: machine.code, shift: when.startShift, date: when.startDate },
      },
    });
    return run.id;
  }

  /**
   * Records (or replaces) one production day of a run: the fabric goes into the warehouse as grey fabric under the
   * run's code that day. A replaced day's fabric comes back out of stock first, which is refused once it's issued on.
   */
  private async recordDay(tx: Prisma.TransactionClient, run: LockedRun, date: Date, line: Production, warehouse: { id: string; code: string }, user: AuthUser) {
    const day = dayIndex(date);
    if (day < dayIndex(run.startedAt)) throw new BadRequestException(`${run.runNo} started on ${isoDay(run.startedAt)}; ${isoDay(date)} is before that`);
    if (run.finishedAt && day > dayIndex(run.finishedAt)) throw new BadRequestException(`${run.runNo} stopped on ${isoDay(run.finishedAt)}; ${isoDay(date)} is after that`);
    if (inFuture(date)) throw new BadRequestException(`${isoDay(date)} is still to come`);
    if (run.stockTxnId) throw new BadRequestException(`${run.runNo} was finished in one go before day entries; undo its finish to enter days`);
    this.assertTaskAtKnitting(run);

    const key = { runId_date: { runId: run.id, date } };
    const existing = await tx.knittingDayEntry.findUnique({ where: key, select: { outputKg: true, warehouseId: true, stockTxnId: true } });
    // Same weight into the same warehouse: the stock stays as it is (it may already be issued on), only rolls and note change.
    if (existing && Math.abs(Number(existing.outputKg) - line.outputKg) < EMPTY && existing.warehouseId === warehouse.id) {
      await tx.knittingDayEntry.update({ where: key, data: { rollCount: line.rollCount, yarnUsedKg: line.yarnUsedKg ?? null, notes: line.notes?.trim() || null } });
      return;
    }
    if (existing?.stockTxnId) await this.inventory.removeInWithin(tx, existing.stockTxnId, user.id);
    const txn =
      line.outputKg > EMPTY
        ? await this.inventory.createTxn(
            {
              category: 'GREY_FABRIC',
              txnType: 'GREY_FABRIC_IN',
              itemCode: run.runNo,
              itemName: `${run.fabricType || run.yarns.map((y) => y.itemName).join(' + ')} grey fabric`,
              warehouseId: warehouse.id,
              quantityIn: line.outputKg,
              unit: 'KG',
              referenceType: 'KNITTING_RUN',
              referenceId: run.id,
              createdById: user.id,
              notes: `${run.runNo} knitted on ${run.machine.code} on ${isoDay(date)}${line.rollCount ? ` · ${line.rollCount} rolls` : ''}`,
              createdAt: date,
            },
            tx,
          )
        : null;
    const data = { outputKg: line.outputKg, rollCount: line.rollCount, yarnUsedKg: line.yarnUsedKg ?? null, warehouseId: warehouse.id, stockTxnId: txn?.id ?? null, notes: line.notes?.trim() || null };
    await tx.knittingDayEntry.upsert({ where: key, create: { runId: run.id, date, createdById: user.id, ...data }, update: data });
  }

  /** A run's totals from its days: fabric, rolls, the yarn used (as entered each day, else as much as the fabric weighs) and charges. */
  private async syncRun(tx: Prisma.TransactionClient, runId: string) {
    const run = await tx.knittingRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        ratePerKg: true,
        stockTxnId: true,
        yarns: { select: { id: true, kg: true, ratePerKg: true } },
        days: { select: { outputKg: true, rollCount: true, yarnUsedKg: true, warehouseId: true }, orderBy: { date: 'desc' } },
      },
    });
    // A run finished before day entries keeps the weight and stock of its single finish.
    if (run.stockTxnId) return;
    const recorded = run.days.length > 0;
    const kg = round(run.days.reduce((sum, day) => sum + Number(day.outputKg), 0), 3);
    const yarnUsed = round(run.days.reduce((sum, day) => sum + Number(day.yarnUsedKg ?? day.outputKg), 0), 3);
    const rolls = run.days.reduce((sum, day) => sum + day.rollCount, 0);
    const yarnKg = run.yarns.reduce((sum, y) => sum + Number(y.kg), 0);
    const yarnRate = yarnKg > EMPTY ? run.yarns.reduce((sum, y) => sum + Number(y.kg) * Number(y.ratePerKg), 0) / yarnKg : Number(run.yarns[0]?.ratePerKg ?? 0);
    await tx.knittingRun.update({
      where: { id: runId },
      data: {
        yarnKg: yarnUsed,
        yarnCost: round(yarnUsed * yarnRate, 2),
        outputKg: recorded ? kg : null,
        rollCount: recorded ? rolls : null,
        knittingCharge: recorded ? round(kg * Number(run.ratePerKg), 2) : null,
        warehouseId: run.days.find((day) => Number(day.outputKg) > EMPTY)?.warehouseId ?? null,
      },
    });
    if (run.yarns.length === 1) await tx.knittingRunYarn.update({ where: { id: run.yarns[0].id }, data: { kg } });
  }

  /**
   * Rolls a task's machine runs back into the Production batch: fabric so far, its rolls, charges, the machines on it, and
   * whether its knitting is complete. Complete needs every machine stopped; `complete` sets it, otherwise it stays
   * as it was (and is cleared whenever a machine is knitting the task).
   */
  private async syncProductionTask(tx: Prisma.TransactionClient, flowId: string, opts: { complete?: boolean; deliveryPlace?: string; yarnUsedKg?: number; actorId?: string } = {}) {
    const flow = await tx.fabricProductionFlow.findUniqueOrThrow({
      where: { id: flowId },
      select: { id: true, flowNo: true, fabricType: true, purchasedWeightKg: true, yarnReceivedKg: true, yarnIssueTxnId: true, yarnReturnTxnId: true, knittingFinishedAt: true },
    });
    const runs = await tx.knittingRun.findMany({
      where: { productionFlowId: flowId },
      select: { status: true, outputKg: true, rollCount: true, knittingCharge: true, finishedAt: true, machine: { select: { code: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const running = runs.filter((run) => run.status === 'RUNNING');
    const output = round(runs.reduce((sum, run) => sum + Number(run.outputKg ?? 0), 0), 3);
    // Rolls as entered day by day on the Machines page (left alone while no run has any entered).
    const rolled = runs.some((run) => run.rollCount !== null);
    const rolls = runs.reduce((sum, run) => sum + (run.rollCount ?? 0), 0);
    const charge = round(runs.reduce((sum, run) => sum + Number(run.knittingCharge ?? 0), 0), 2);
    const complete = runs.length > 0 && running.length === 0 && (opts.complete ?? flow.knittingFinishedAt !== null);
    const lastFinished = runs.reduce<Date | null>((latest, run) => (!run.finishedAt || (latest && latest > run.finishedAt) ? latest : run.finishedAt), null);
    const machines = [...new Set((running.length ? running : runs).map((run) => run.machine.code))].join(', ');
    // The yarn: completing with what it used puts the rest back in its warehouse (shared yarn once its last type is
    // complete); reopening takes that back again.
    let yarnUsed: number | undefined;
    if (complete && opts.yarnUsedKg !== undefined && flow.yarnIssueTxnId) {
      yarnUsed = await settleYarnUsed(tx, this.inventory, flow, opts.yarnUsedKg, opts.actorId);
    } else if (!complete && flow.knittingFinishedAt && flow.yarnIssueTxnId) {
      yarnUsed = await settleYarnUsed(tx, this.inventory, flow, null, opts.actorId);
    }
    await tx.fabricProductionFlow.update({
      where: { id: flowId },
      data: {
        knittingFinishedAt: complete ? lastFinished : null,
        knittingDeliveryKg: output > EMPTY ? output : null,
        ...(rolled ? { knittingBagCount: rolls || null } : {}),
        dyeingDeliveryKg: complete ? output : null,
        knittingExpense: charge,
        knittingMillDetails: machines || 'Pending machine selection',
        ...(opts.deliveryPlace ? { knittingDeliveryPlace: opts.deliveryPlace } : {}),
        ...(yarnUsed !== undefined ? { purchasedWeightKg: yarnUsed } : {}),
      },
    });
    if (!flow.knittingFinishedAt && complete) {
      await notifyProcessDone(tx, {
        process: 'Knitting',
        flowNo: flow.flowNo,
        input: yarnUsed ?? Number(flow.purchasedWeightKg),
        output,
        outputLabel: 'grey fabric',
        details: [flow.fabricType, `${runs.length} machine run${runs.length === 1 ? '' : 's'}`],
        next: 'ready for dyeing',
      });
    }
  }

  /** Puts a Production knitting task on one or more free machines at once. No machine is limited to a load. */
  async assign(flowId: string, dto: AssignMachinesDto, user: AuthUser) {
    const ids = dto.machines.map((m) => m.machineId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('The same machine is chosen twice');
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${flowId}`, ...ids.map((id) => `knitting-machine:${id}`));
      const task = await this.openTask(tx, flowId);
      const created: string[] = [];
      for (const pick of dto.machines) created.push(await this.startOnMachine(tx, task, pick, dto, user));
      await this.syncProductionTask(tx, task.id);
      const runs = await tx.knittingRun.findMany({ where: { id: { in: created } }, include: runInclude, orderBy: { runNo: 'asc' } });
      return runs.map(runView);
    });
  }

  /** One machine for a task (kept for older callers of `POST /knitting/runs`). */
  async start(dto: StartRunDto, user: AuthUser) {
    const [run] = await this.assign(
      dto.productionFlowId,
      { startDate: dto.startDate, startShift: dto.startShift, notes: dto.notes, machines: [{ machineId: dto.machineId, operatorId: dto.operatorId, ratePerKg: dto.ratePerKg }] },
      user,
    );
    return run;
  }

  /** The day-end entry: each machine's fabric KG and rolls for one production day, into one warehouse. */
  async recordDays(dto: DayEntriesDto, user: AuthUser) {
    const ids = dto.entries.map((e) => e.runId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('A run is listed twice');
    const date = new Date(dto.date);
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, ...ids.map((id) => `knitting-run:${id}`));
      const warehouse = await this.activeWarehouse(tx, dto.warehouseId);
      const flows = new Set<string>();
      const saved: Array<{ runNo: string; kg: number; rolls: number }> = [];
      for (const line of dto.entries) {
        const run = await this.loadRun(tx, line.runId);
        await this.recordDay(tx, run, date, line, warehouse, user);
        await this.syncRun(tx, run.id);
        if (run.productionFlowId) flows.add(run.productionFlowId);
        saved.push({ runNo: run.runNo, kg: line.outputKg, rolls: line.rollCount });
      }
      for (const flowId of flows) await this.syncProductionTask(tx, flowId, { deliveryPlace: warehouse.code });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'KNITTING_DAY_RECORDED', module: 'knitting', entity: 'KnittingDayEntry', entityId: dto.date, newValue: { date: dto.date, warehouse: warehouse.code, entries: saved } },
      });
      const runs = await tx.knittingRun.findMany({ where: { id: { in: ids } }, include: runInclude });
      return runs.map(runView);
    });
  }

  /** Removes a recorded day: its fabric comes back out of stock, unless it has already been issued from there. */
  async deleteDay(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.knittingDayEntry.findUnique({ where: { id }, select: { runId: true } });
      if (!found) throw new NotFoundException('Day entry not found');
      await lockKeys(tx, `knitting-run:${found.runId}`);
      const entry = await tx.knittingDayEntry.findUnique({ where: { id } });
      if (!entry) throw new NotFoundException('Day entry not found');
      const run = await this.loadRun(tx, entry.runId);
      this.assertTaskAtKnitting(run);
      if (run.status === 'FINISHED' && (await tx.knittingDayEntry.count({ where: { runId: run.id } })) === 1) {
        throw new BadRequestException(`${run.runNo} is finished and this is its only day; undo the finish first`);
      }
      if (entry.stockTxnId) await this.inventory.removeInWithin(tx, entry.stockTxnId, user.id);
      await tx.knittingDayEntry.delete({ where: { id } });
      await this.syncRun(tx, run.id);
      if (run.productionFlowId) await this.syncProductionTask(tx, run.productionFlowId);
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'KNITTING_DAY_REMOVED',
          module: 'knitting',
          entity: 'KnittingDayEntry',
          entityId: id,
          previousValue: { runNo: run.runNo, date: isoDay(entry.date), outputKg: Number(entry.outputKg), rollCount: entry.rollCount },
        },
      });
      return this.view(tx, run.id);
    });
  }

  /**
   * Stops a machine: records the finish day's production when given, closes the run and frees the machine. When it
   * was the task's last machine, `completeTask` says whether the task's knitting is done.
   */
  private async finishWithin(
    tx: Prisma.TransactionClient,
    run: LockedRun,
    opts: { date: Date; shift: KnittingShift; outputKg?: number; rollCount?: number; warehouseId?: string; ratePerKg?: number; notes?: string; endReason?: string; completeTask?: boolean; yarnUsedKg?: number },
    user: AuthUser,
  ) {
    if (run.status !== 'RUNNING') throw new BadRequestException(`${run.runNo} is already finished`);
    if (shiftIndex(opts.date, opts.shift) < shiftIndex(run.startedAt, run.startShift)) {
      throw new BadRequestException(`${run.runNo} started on the ${SHIFT_LABEL[run.startShift].toLowerCase()} shift of ${isoDay(run.startedAt)}; it can't stop before that`);
    }
    if (inFuture(opts.date)) throw new BadRequestException(`${isoDay(opts.date)} is still to come`);
    if (opts.ratePerKg !== undefined) await tx.knittingRun.update({ where: { id: run.id }, data: { ratePerKg: opts.ratePerKg } });
    let deliveryPlace: string | undefined;
    if (opts.outputKg !== undefined) {
      if (!opts.warehouseId) throw new BadRequestException('Choose the warehouse the fabric goes into');
      const warehouse = await this.activeWarehouse(tx, opts.warehouseId);
      await this.recordDay(tx, run, opts.date, { outputKg: opts.outputKg, rollCount: opts.rollCount ?? 0 }, warehouse, user);
      deliveryPlace = warehouse.code;
    }
    const days = await tx.knittingDayEntry.findMany({ where: { runId: run.id }, select: { date: true }, orderBy: { date: 'desc' } });
    if (!days.length) throw new BadRequestException(`Nothing is recorded for ${run.runNo} yet: enter what it knitted, or cancel the run`);
    if (dayIndex(days[0].date) > dayIndex(opts.date)) {
      throw new BadRequestException(`${run.runNo} has production recorded on ${isoDay(days[0].date)}, after ${isoDay(opts.date)}`);
    }
    await tx.knittingRun.update({
      where: { id: run.id },
      data: {
        status: 'FINISHED',
        finishedAt: opts.date,
        finishShift: opts.shift,
        endReason: opts.endReason ?? null,
        ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
      },
    });
    await this.syncRun(tx, run.id);
    if (run.machine.status === MachineStatus.RUNNING) await tx.machine.update({ where: { id: run.machineId }, data: { status: MachineStatus.IDLE } });

    const done = await tx.knittingRun.findUniqueOrThrow({ where: { id: run.id }, select: { outputKg: true, rollCount: true, warehouse: { select: { code: true } } } });
    const outputKg = Number(done.outputKg ?? 0);
    await notifyRoles(tx, MACHINE_ROLES, {
      title: `Machine stopped · ${run.runNo} on ${run.machine.code}`,
      message: [
        `${kgText(outputKg)} grey fabric in ${days.length} day${days.length === 1 ? '' : 's'}`,
        done.rollCount ? `${done.rollCount} rolls` : null,
        run.fabricType,
        opts.endReason ?? (done.warehouse ? `into ${done.warehouse.code}` : null),
      ]
        .filter(Boolean)
        .join(' · '),
      type: 'JOB_COMPLETED',
      referenceType: 'KnittingRun',
      referenceId: run.runNo,
    });
    if (run.productionFlowId) await this.syncProductionTask(tx, run.productionFlowId, { complete: opts.completeTask, deliveryPlace, yarnUsedKg: opts.completeTask ? opts.yarnUsedKg : undefined, actorId: user.id });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'KNITTING_RUN_FINISHED',
        module: 'knitting',
        entity: 'KnittingRun',
        entityId: run.id,
        newValue: { runNo: run.runNo, outputKg, rollCount: done.rollCount, days: days.length, endReason: opts.endReason ?? null, completeTask: opts.completeTask ?? null },
      },
    });
  }

  async finish(id: string, dto: FinishRunDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-run:${id}`);
      const run = await this.loadRun(tx, id);
      if (run.productionFlowId) await lockKeys(tx, `production-batch:${run.productionFlowId}`);
      await this.finishWithin(tx, run, { ...dto, date: new Date(dto.finishDate), shift: dto.finishShift }, user);
      return this.view(tx, id);
    });
  }

  /**
   * Moves a run to another machine when its machine breaks down or needs repair. The first machine's run stops
   * with what it knitted (its last day's production can be given) and the task carries on as a new run on the
   * new machine. A run with nothing knitted yet just changes machine.
   */
  async move(id: string, dto: MoveRunDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-run:${id}`, `knitting-machine:${dto.machineId}`);
      const run = await this.loadRun(tx, id);
      if (run.status !== 'RUNNING') throw new BadRequestException(`${run.runNo} is finished`);
      if (!run.productionFlowId) throw new BadRequestException('Only a Production task can move to another machine');
      if (run.machineId === dto.machineId) throw new BadRequestException(`${run.runNo} is already on ${run.machine.code}; choose another machine`);
      await lockKeys(tx, `production-batch:${run.productionFlowId}`, `knitting-machine:${run.machineId}`);
      const target = await this.freeMachine(tx, dto.machineId);
      const date = new Date(dto.date);
      if (shiftIndex(date, dto.shift) < shiftIndex(run.startedAt, run.startShift)) {
        throw new BadRequestException(`${run.runNo} started on the ${SHIFT_LABEL[run.startShift].toLowerCase()} shift of ${isoDay(run.startedAt)}; it can't move before that`);
      }
      const why = dto.machineStatus === 'IDLE' ? 'stopped' : dto.machineStatus.toLowerCase();
      const reason = [`Moved to ${target.code}`, why, dto.notes?.trim()].filter(Boolean).join(' · ');
      const knitted = (await tx.knittingDayEntry.count({ where: { runId: id } })) > 0 || (dto.outputKg ?? 0) > EMPTY;

      let runId = run.id;
      if (knitted) {
        await this.finishWithin(tx, run, { date, shift: dto.shift, outputKg: dto.outputKg, rollCount: dto.rollCount, warehouseId: dto.warehouseId, endReason: reason, completeTask: false }, user);
        const task = await this.openTask(tx, run.productionFlowId);
        runId = await this.startOnMachine(
          tx,
          task,
          { machineId: target.id, operatorId: dto.operatorId ?? run.operatorId ?? undefined, ratePerKg: num(target.ratePerKg) || Number(run.ratePerKg) },
          { startDate: dto.date, startShift: dto.shift, notes: `Moved from ${run.machine.code} (${run.runNo})${dto.notes?.trim() ? ` · ${dto.notes.trim()}` : ''}` },
          user,
        );
      } else {
        // Nothing knitted on the first machine yet: the same run carries on on the new one.
        await tx.knittingRun.update({
          where: { id: run.id },
          data: {
            machineId: target.id,
            startedAt: date,
            startShift: dto.shift,
            ...(dto.operatorId ? { operatorId: dto.operatorId } : {}),
            ratePerKg: num(target.ratePerKg) || Number(run.ratePerKg),
            notes: [run.notes, `Moved from ${run.machine.code}`, dto.notes?.trim()].filter(Boolean).join(' · '),
          },
        });
        await tx.machine.update({ where: { id: target.id }, data: { status: MachineStatus.RUNNING } });
      }
      await tx.machine.update({ where: { id: run.machineId }, data: { status: dto.machineStatus } });
      await this.syncProductionTask(tx, run.productionFlowId);
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'KNITTING_RUN_MOVED',
          module: 'knitting',
          entity: 'KnittingRun',
          entityId: runId,
          newValue: { from: run.machine.code, to: target.code, runNo: run.runNo, machineStatus: dto.machineStatus, date: dto.date, shift: dto.shift },
        },
      });
      return this.view(tx, runId);
    });
  }

  /** Marks a task's knitting complete (every machine on it stopped) or open again for more machine work. */
  async completeTask(flowId: string, dto: CompleteTaskDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${flowId}`);
      const flow = await tx.fabricProductionFlow.findFirst({ where: { id: flowId, knittingMillType: 'OWN' }, select: { id: true, flowNo: true, status: true } });
      if (!flow) throw new NotFoundException('Production knitting task not found');
      if (flow.status !== 'KNITTING') throw new BadRequestException(`${flow.flowNo} is at ${flow.status.toLowerCase()}; its knitting can't change now`);
      if (dto.complete) {
        const running = await tx.knittingRun.count({ where: { productionFlowId: flowId, status: 'RUNNING' } });
        if (running) throw new BadRequestException(`${running} machine${running === 1 ? ' is' : 's are'} still knitting ${flow.flowNo}; finish ${running === 1 ? 'it' : 'them'} first`);
        const knitted = await tx.knittingRun.count({ where: { productionFlowId: flowId, outputKg: { gt: 0 } } });
        if (!knitted) throw new BadRequestException(`Nothing has been knitted for ${flow.flowNo} yet`);
      }
      await this.syncProductionTask(tx, flowId, { complete: dto.complete, yarnUsedKg: dto.complete ? dto.yarnUsedKg : undefined, actorId: user.id });
      await tx.auditLog.create({
        data: { actorId: user.id, action: dto.complete ? 'KNITTING_TASK_COMPLETED' : 'KNITTING_TASK_REOPENED', module: 'knitting', entity: 'FabricProductionFlow', entityId: flowId, newValue: { flowNo: flow.flowNo } },
      });
      return { ok: true };
    });
  }

  /**
   * Undoes a finish: the run is knitting again with its days. A run finished before day entries also takes its
   * fabric back out of stock, unless it has already been issued.
   */
  async reopen(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-run:${id}`);
      const run = await this.loadRun(tx, id);
      if (run.status !== 'FINISHED') throw new BadRequestException(`${run.runNo} is still knitting`);
      this.assertTaskAtKnitting(run);
      await lockKeys(tx, `knitting-machine:${run.machineId}`);
      if (OUT_OF_SERVICE.includes(run.machine.status)) {
        throw new BadRequestException(`${run.machine.code} is set to ${run.machine.status.toLowerCase()}; set it back to Idle first`);
      }
      const other = await tx.knittingRun.findFirst({ where: { machineId: run.machineId, status: 'RUNNING' }, select: { runNo: true } });
      if (other) throw new BadRequestException(`${run.machine.code} is knitting ${other.runNo} now; finish that run first`);
      if (run.stockTxnId) {
        await this.inventory.removeInWithin(tx, run.stockTxnId, user.id);
        await tx.knittingRun.update({ where: { id }, data: { outputKg: null, rollCount: null, knittingCharge: null, warehouseId: null, stockTxnId: null } });
      }
      await tx.knittingRun.update({ where: { id }, data: { status: 'RUNNING', finishedAt: null, finishShift: null, endReason: null } });
      await this.syncRun(tx, id);
      if (run.productionFlowId) await this.syncProductionTask(tx, run.productionFlowId);
      if (run.machine.status === MachineStatus.IDLE) await tx.machine.update({ where: { id: run.machineId }, data: { status: MachineStatus.RUNNING } });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'KNITTING_RUN_REOPENED', module: 'knitting', entity: 'KnittingRun', entityId: id, previousValue: { runNo: run.runNo, outputKg: num(run.outputKg) } },
      });
      return this.view(tx, id);
    });
  }

  /** Cancels a run with nothing recorded on it: the run is removed and its machine is free again. */
  async cancel(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-run:${id}`);
      const run = await this.loadRun(tx, id);
      if (run.status !== 'RUNNING') throw new BadRequestException(`${run.runNo} is finished; undo the finish first`);
      const days = await tx.knittingDayEntry.count({ where: { runId: id } });
      if (days) throw new BadRequestException(`${run.runNo} has ${days} day${days === 1 ? '' : 's'} of production recorded; finish it instead, or remove those days first`);
      // Runs loaded from stock before Production tasks took their yarn out; that yarn goes back.
      const issues = run.productionFlowId ? [] : run.yarns.flatMap((y) => (y.issueTxnId ? [y.issueTxnId] : []));
      await this.inventory.deleteWithin(tx, issues, user.id);
      await tx.knittingRun.delete({ where: { id } });
      if (run.productionFlowId) await this.syncProductionTask(tx, run.productionFlowId);
      if (run.machine.status === MachineStatus.RUNNING) await tx.machine.update({ where: { id: run.machineId }, data: { status: MachineStatus.IDLE } });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'KNITTING_RUN_CANCELLED', module: 'knitting', entity: 'KnittingRun', entityId: id, previousValue: { runNo: run.runNo, machine: run.machine.code } },
      });
    });
    return { ok: true };
  }
}
