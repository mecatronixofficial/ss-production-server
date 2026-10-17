import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { KnittingShift, MachineStatus, Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { lockKeys } from '../common/locks';
import { batchCode } from '../common/numbering';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { MACHINE_ROLES } from '../common/roles';
import { notifyRoles } from '../notifications/notify.util';
import { notifyProcessDone, weightChange } from '../production/process-notify';
import { FinishRunDto, StartRunDto } from './dto/knitting-run.dto';

/** Yarn one load takes when a machine has no capacity of its own. */
export const DEFAULT_CAPACITY_KG = 240;
/**
 * Fabric normally comes off within this of the yarn loaded (200 KG in → 180–220 KG out), mostly the same or a
 * little less. Any weight can be saved; outside this range the page points it out.
 */
export const KNITTING_TOLERANCE_KG = 20;

const EMPTY = 0.0005;

const runInclude = {
  machine: { select: { id: true, code: true, name: true, type: true, capacityKg: true } },
  operator: { select: { id: true, code: true, name: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  yarns: { include: { warehouse: { select: { code: true, name: true } } }, orderBy: { kg: 'desc' as const } },
  productionFlow: { select: { id: true, flowNo: true, fabricDiameter: true, fabricGsm: true, knittingGg: true, knittingLl: true } },
} satisfies Prisma.KnittingRunInclude;

type RunRow = Prisma.KnittingRunGetPayload<{ include: typeof runInclude }>;

const num = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const SHIFT_LABEL: Record<KnittingShift, string> = { DAY: 'Day', NIGHT: 'Night' };

/** Shifts in order: the day's Day shift (9 AM–9 PM) comes before its Night shift (9 PM–9 AM). */
const shiftIndex = (date: Date, shift: KnittingShift) => Math.floor(date.getTime() / 86_400_000) * 2 + (shift === 'NIGHT' ? 1 : 0);

/** A run with plain numbers and its sums: yarn mix, weight change against the normal range, cost per KG. */
function runView(run: RunRow) {
  const yarnKg = Number(run.yarnKg);
  const yarnCost = Number(run.yarnCost);
  const outputKg = num(run.outputKg);
  const knittingCharge = num(run.knittingCharge);
  const totalCost = round(yarnCost + (knittingCharge ?? 0), 2);
  return {
    ...run,
    machine: { ...run.machine, capacityKg: num(run.machine.capacityKg) ?? DEFAULT_CAPACITY_KG },
    yarnKg,
    yarnCost,
    ratePerKg: Number(run.ratePerKg),
    outputKg,
    knittingCharge,
    changeKg: outputKg === null ? null : round(outputKg - yarnKg, 3),
    expectedMinKg: round(Math.max(0, yarnKg - KNITTING_TOLERANCE_KG), 3),
    expectedMaxKg: round(yarnKg + KNITTING_TOLERANCE_KG, 3),
    totalCost,
    costPerKg: outputKg ? round(totalCost / outputKg, 2) : null,
    shifts: run.finishedAt && run.finishShift ? shiftIndex(run.finishedAt, run.finishShift) - shiftIndex(run.startedAt, run.startShift) + 1 : null,
    yarns: run.yarns.map((yarn) => {
      const kg = Number(yarn.kg);
      const rate = Number(yarn.ratePerKg);
      return { ...yarn, kg, ratePerKg: rate, cost: round(kg * rate, 2), sharePct: yarnKg ? round((kg / yarnKg) * 100, 2) : 0 };
    }),
  };
}

@Injectable()
export class KnittingService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  /** What the Machines page needs to load a machine: machines, operators, warehouses and the yarn in stock with its last price. */
  async context() {
    const [machines, operators, warehouses, stock, fabricTypes] = await Promise.all([
      this.prisma.machine.findMany({
        where: { status: { not: MachineStatus.DISABLED } },
        select: { id: true, code: true, name: true, type: true, capacityKg: true, ratePerKg: true, manufacturer: true, status: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.employee.findMany({ where: { active: true }, select: { id: true, code: true, name: true, department: true }, orderBy: { name: 'asc' } }),
      this.prisma.warehouse.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      this.inventory.balance({ category: 'YARN' }),
      this.prisma.knittingRun.findMany({ where: { fabricType: { not: null } }, distinct: ['fabricType'], select: { fabricType: true } }),
    ]);
    const active = new Set(warehouses.map((w) => w.id));
    const yarnStock = stock
      .filter((row) => row.unit === 'KG' && row.balanceKg > EMPTY && active.has(row.warehouseId))
      .sort((a, b) => a.itemCode.localeCompare(b.itemCode));
    // The yarn's latest purchase price per KG, to price what is loaded.
    const codes = [...new Set(yarnStock.map((row) => row.itemCode))];
    const lines = codes.length
      ? await this.prisma.purchaseOrderItem.findMany({
          where: { itemCode: { in: codes }, unit: 'KG' },
          select: { itemCode: true, rate: true },
          orderBy: { purchaseOrder: { orderDate: 'desc' } },
        })
      : [];
    const lastRate = new Map<string, number>();
    for (const line of lines) if (line.itemCode && !lastRate.has(line.itemCode)) lastRate.set(line.itemCode, Number(line.rate));
    return {
      machines: machines.map((m) => ({ ...m, capacityKg: num(m.capacityKg) ?? DEFAULT_CAPACITY_KG, ratePerKg: num(m.ratePerKg) ?? 0 })),
      operators,
      warehouses,
      yarnStock: yarnStock.map((row) => ({ ...row, lastRate: lastRate.get(row.itemCode) ?? null })),
      fabricTypes: fabricTypes.map((f) => f.fabricType!).sort((a, b) => a.localeCompare(b)),
      toleranceKg: KNITTING_TOLERANCE_KG,
      defaultCapacityKg: DEFAULT_CAPACITY_KG,
    };
  }

  /** Every run, the ones knitting now first. */
  async runs() {
    const runs = await this.prisma.knittingRun.findMany({
      include: runInclude,
      orderBy: [{ status: 'asc' }, { startedAt: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
    return runs.map(runView);
  }

  private async view(tx: Prisma.TransactionClient, id: string) {
    return runView(await tx.knittingRun.findUniqueOrThrow({ where: { id }, include: runInclude }));
  }

  /** Rolls all machine rounds back into their parent Production task. */
  private async syncProductionTask(tx: Prisma.TransactionClient, flowId: string) {
    const flow = await tx.fabricProductionFlow.findUniqueOrThrow({ where: { id: flowId }, select: { purchasedWeightKg: true } });
    const runs = await tx.knittingRun.findMany({ where: { productionFlowId: flowId }, select: { status: true, yarnKg: true, outputKg: true, knittingCharge: true, finishedAt: true } });
    const allocated = runs.reduce((sum, run) => sum + Number(run.yarnKg), 0);
    const finished = runs.filter((run) => run.status === 'FINISHED');
    const output = round(finished.reduce((sum, run) => sum + Number(run.outputKg ?? 0), 0), 3);
    const charge = round(finished.reduce((sum, run) => sum + Number(run.knittingCharge ?? 0), 0), 2);
    const complete = allocated >= Number(flow.purchasedWeightKg) - EMPTY && runs.length > 0 && finished.length === runs.length;
    const lastFinished = finished.reduce<Date | null>((latest, run) => !run.finishedAt || (latest && latest > run.finishedAt) ? latest : run.finishedAt, null);
    await tx.fabricProductionFlow.update({
      where: { id: flowId },
      data: {
        knittingFinishedAt: complete ? lastFinished : null,
        knittingDeliveryKg: output > EMPTY ? output : null,
        dyeingDeliveryKg: complete ? output : null,
        knittingExpense: charge,
      },
    });
  }

  /**
   * Loads a machine: takes each yarn out of its warehouse by item code (never more than is in stock) and starts
   * the run under a new SS code, all in one transaction. A machine knits one run at a time, up to its capacity.
   */
  async start(dto: StartRunDto, user: AuthUser) {
    if (!dto.productionFlowId) throw new BadRequestException('Select a Production knitting order before starting a machine');
    const productionTask = dto.productionFlowId
      ? await this.prisma.fabricProductionFlow.findFirst({ where: { id: dto.productionFlowId, knittingMillType: 'OWN', knittingFinishedAt: null } })
      : null;
    if (dto.productionFlowId && !productionTask) throw new NotFoundException('Production knitting task not found');
    if (!productionTask && !dto.yarns?.length) throw new BadRequestException('Pick at least one yarn, or select a production task');
    const yarns = (dto.yarns ?? []).map((y) => ({ ...y, itemCode: y.itemCode.trim(), lotNo: y.lotNo?.trim() || null }));
    const keys = yarns.map((y) => [y.itemCode, y.warehouseId, y.lotNo ?? ''].join('|'));
    if (new Set(keys).size !== keys.length) throw new BadRequestException('The same yarn is listed twice; put all its KG on one line');
    const manualYarnKg = round(yarns.reduce((sum, y) => sum + y.kg, 0), 3);

    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-machine:${dto.machineId}`);
      const machine = await tx.machine.findUnique({ where: { id: dto.machineId } });
      if (!machine) throw new NotFoundException('Machine not found');
      if (machine.status === MachineStatus.DISABLED || machine.status === MachineStatus.MAINTENANCE || machine.status === MachineStatus.BREAKDOWN) {
        throw new BadRequestException(`${machine.code} is set to ${machine.status.toLowerCase()}; set it back to Idle before loading yarn`);
      }
      const busy = await tx.knittingRun.findFirst({ where: { machineId: machine.id, status: 'RUNNING' }, select: { runNo: true } });
      if (busy) throw new BadRequestException(`${machine.code} is already knitting ${busy.runNo}; finish that run first`);
      const capacity = num(machine.capacityKg) ?? DEFAULT_CAPACITY_KG;
      let yarnKg = manualYarnKg;
      let taskRunNo: string | null = null;
      if (productionTask) {
        await lockKeys(tx, `production-batch:${productionTask.id}`);
        const current = await tx.fabricProductionFlow.findUniqueOrThrow({ where: { id: productionTask.id }, include: { knittingRuns: { select: { runNo: true, yarnKg: true } } } });
        const allocated = current.knittingRuns.reduce((sum, run) => sum + Number(run.yarnKg), 0);
        const remaining = round(Number(current.purchasedWeightKg) - allocated, 3);
        if (remaining <= EMPTY) throw new BadRequestException(`${current.flowNo} is already fully allocated to machines`);
        yarnKg = round(dto.productionYarnKg ?? Math.min(remaining, capacity), 3);
        if (yarnKg > remaining + EMPTY) throw new BadRequestException(`Only ${remaining.toFixed(3)} KG remains on ${current.flowNo}`);
        const lastRound = current.knittingRuns.reduce((max, run) => Math.max(max, Number(run.runNo.match(/-R(\d+)$/)?.[1] ?? 0)), 0);
        taskRunNo = `${current.flowNo}-R${lastRound + 1}`;
      }
      if (yarnKg > capacity + EMPTY) {
        throw new BadRequestException(`${machine.code} takes at most ${capacity.toFixed(3)} KG of yarn; ${yarnKg.toFixed(3)} KG was loaded`);
      }
      if (dto.operatorId && !(await tx.employee.findFirst({ where: { id: dto.operatorId, active: true }, select: { id: true } }))) {
        throw new BadRequestException('Choose an active operator');
      }

      const runNo = taskRunNo ?? await batchCode(tx);
      const run = await tx.knittingRun.create({
        data: {
          runNo,
          machineId: machine.id,
          fabricType: productionTask?.fabricType ?? dto.fabricType?.trim() ?? null,
          productionFlowId: productionTask?.id,
          startedAt: new Date(dto.startDate),
          startShift: dto.startShift,
          operatorId: dto.operatorId || null,
          yarnKg,
          yarnCost: productionTask ? round(yarnKg * Number(productionTask.yarnRatePerKg), 2) : round(yarns.reduce((sum, y) => sum + y.kg * y.ratePerKg, 0), 2),
          ratePerKg: dto.ratePerKg ?? num(machine.ratePerKg) ?? 0,
          notes: dto.notes?.trim() || null,
          createdById: user.id,
        },
      });

      if (productionTask) {
        if (!productionTask.yarnItemCode || !productionTask.yarnWarehouseId) throw new BadRequestException('The production task has no allocated yarn stock');
        await tx.knittingRunYarn.create({ data: { runId: run.id, itemCode: productionTask.yarnItemCode, itemName: `${productionTask.yarnCount} yarn`, category: 'YARN', warehouseId: productionTask.yarnWarehouseId, lotNo: productionTask.yarnLotNo, kg: yarnKg, ratePerKg: productionTask.yarnRatePerKg, issueTxnId: productionTask.yarnIssueTxnId } });
        await tx.fabricProductionFlow.update({ where: { id: productionTask.id }, data: { knittingMillDetails: machine.code, knittingPartyDetails: 'Own mill' } });
      }
      for (const yarn of productionTask ? [] : yarns) {
        const lot = yarn.lotNo ? ` lot ${yarn.lotNo}` : '';
        const warehouse = await tx.warehouse.findFirst({ where: { id: yarn.warehouseId, active: true }, select: { code: true } });
        if (!warehouse) throw new BadRequestException(`Choose an active warehouse for ${yarn.itemCode}`);
        const position = { itemCode: yarn.itemCode, warehouseId: yarn.warehouseId, category: 'YARN' as const, lotNo: yarn.lotNo };
        const latest = await tx.stockTransaction.findFirst({ where: position, orderBy: { createdAt: 'desc' }, select: { itemName: true } });
        if (!latest) throw new BadRequestException(`There is no yarn ${yarn.itemCode}${lot} in ${warehouse.code}`);
        if (await tx.stockTransaction.findFirst({ where: { ...position, unit: { not: 'KG' } }, select: { id: true } })) {
          throw new BadRequestException(`${yarn.itemCode} is kept in another unit than KG; machines take yarn by KG`);
        }
        const issue = await this.inventory.issueWithin(tx, {
          ...position,
          lotNo: yarn.lotNo ?? undefined,
          txnType: 'KNITTING_ISSUE',
          itemName: latest.itemName,
          quantityOut: yarn.kg,
          unit: 'KG',
          referenceType: 'KNITTING_RUN',
          referenceId: run.id,
          createdById: user.id,
          notes: `${runNo} knitting on ${machine.code}`,
        });
        await tx.knittingRunYarn.create({
          data: {
            runId: run.id,
            itemCode: yarn.itemCode,
            itemName: latest.itemName,
            category: 'YARN',
            warehouseId: yarn.warehouseId,
            lotNo: yarn.lotNo,
            kg: yarn.kg,
            ratePerKg: yarn.ratePerKg,
            issueTxnId: issue.id,
          },
        });
      }

      await tx.machine.update({ where: { id: machine.id }, data: { status: MachineStatus.RUNNING } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'KNITTING_RUN_STARTED',
          module: 'knitting',
          entity: 'KnittingRun',
          entityId: run.id,
          newValue: { runNo, machine: machine.code, yarnKg, yarns: yarns.map((y) => ({ itemCode: y.itemCode, kg: y.kg })), shift: dto.startShift },
        },
      });
      return this.view(tx, run.id);
    });
  }

  /** Takes the fabric off: its weight goes into a warehouse as grey fabric stock under the run's code. */
  async finish(id: string, dto: FinishRunDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-run:${id}`);
      const run = await tx.knittingRun.findUnique({ where: { id }, include: { machine: true, yarns: true } });
      if (!run) throw new NotFoundException('Run not found');
      if (run.status !== 'RUNNING') throw new BadRequestException(`${run.runNo} is already finished`);
      const finishedAt = new Date(dto.finishDate);
      if (shiftIndex(finishedAt, dto.finishShift) < shiftIndex(run.startedAt, run.startShift)) {
        throw new BadRequestException(`${run.runNo} started on the ${SHIFT_LABEL[run.startShift].toLowerCase()} shift of ${run.startedAt.toISOString().slice(0, 10)}; it can't finish before that`);
      }
      const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { code: true } });
      if (!warehouse) throw new BadRequestException('Choose an active warehouse for the fabric');

      const yarnNames = run.yarns.map((y) => y.itemName).join(' + ');
      const txn = await this.inventory.createTxn(
        {
          category: 'GREY_FABRIC',
          txnType: 'GREY_FABRIC_IN',
          itemCode: run.runNo,
          itemName: `${run.fabricType || yarnNames} grey fabric`,
          warehouseId: dto.warehouseId,
          quantityIn: dto.outputKg,
          unit: 'KG',
          referenceType: 'KNITTING_RUN',
          referenceId: run.id,
          createdById: user.id,
          notes: `${run.runNo} knitted on ${run.machine.code} from ${Number(run.yarnKg).toFixed(3)} KG yarn`,
          createdAt: finishedAt,
        },
        tx,
      );
      await tx.knittingRun.update({
        where: { id },
        data: {
          status: 'FINISHED',
          finishedAt,
          finishShift: dto.finishShift,
          outputKg: dto.outputKg,
          rollCount: dto.rollCount ?? null,
          ratePerKg: dto.ratePerKg,
          knittingCharge: round(dto.outputKg * dto.ratePerKg, 2),
          warehouseId: dto.warehouseId,
          stockTxnId: txn.id,
          ...(dto.notes?.trim() ? { notes: dto.notes.trim() } : {}),
        },
      });
      // The machine round itself: what came off the machine, into which warehouse.
      const yarnKg = Number(run.yarnKg);
      await notifyRoles(tx, MACHINE_ROLES, {
        title: `Knitting run finished · ${run.runNo} on ${run.machine.code}`,
        message: [
          `${dto.outputKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KG grey fabric from ${yarnKg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KG yarn, ${weightChange(yarnKg, dto.outputKg)}`,
          dto.rollCount ? `${dto.rollCount} rolls` : null,
          run.fabricType,
          `into ${warehouse.code}`,
        ]
          .filter(Boolean)
          .join(' · '),
        type: 'JOB_COMPLETED',
        referenceType: 'KnittingRun',
        referenceId: run.runNo,
      });
      if (run.productionFlowId) {
        const before = await tx.fabricProductionFlow.findUniqueOrThrow({ where: { id: run.productionFlowId }, select: { knittingFinishedAt: true } });
        await tx.fabricProductionFlow.update({ where: { id: run.productionFlowId }, data: { knittingDeliveryPlace: warehouse.code, status: 'KNITTING' } });
        await this.syncProductionTask(tx, run.productionFlowId);
        // This round was the batch's last: its whole knitting task is complete.
        const after = await tx.fabricProductionFlow.findUniqueOrThrow({
          where: { id: run.productionFlowId },
          select: { flowNo: true, fabricType: true, purchasedWeightKg: true, knittingDeliveryKg: true, knittingFinishedAt: true, _count: { select: { knittingRuns: true } } },
        });
        if (!before.knittingFinishedAt && after.knittingFinishedAt) {
          await notifyProcessDone(tx, {
            process: 'Knitting',
            flowNo: after.flowNo,
            input: Number(after.purchasedWeightKg),
            output: Number(after.knittingDeliveryKg ?? 0),
            outputLabel: 'grey fabric',
            details: [after.fabricType, `${after._count.knittingRuns} machine round${after._count.knittingRuns === 1 ? '' : 's'}`],
            next: 'ready for dyeing',
          });
        }
      }
      if (run.machine.status === MachineStatus.RUNNING) {
        await tx.machine.update({ where: { id: run.machineId }, data: { status: MachineStatus.IDLE } });
      }
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'KNITTING_RUN_FINISHED',
          module: 'knitting',
          entity: 'KnittingRun',
          entityId: id,
          newValue: { runNo: run.runNo, yarnKg: Number(run.yarnKg), outputKg: dto.outputKg, warehouse: warehouse.code, ratePerKg: dto.ratePerKg },
        },
      });
      return this.view(tx, id);
    });
  }

  /** Undoes a finish (e.g. a wrong weight): the fabric comes back out of stock, unless it has already been issued. */
  async reopen(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-run:${id}`);
      const run = await tx.knittingRun.findUnique({ where: { id }, include: { machine: true } });
      if (!run) throw new NotFoundException('Run not found');
      if (run.status !== 'FINISHED') throw new BadRequestException(`${run.runNo} is still knitting`);
      await lockKeys(tx, `knitting-machine:${run.machineId}`);
      const other = await tx.knittingRun.findFirst({ where: { machineId: run.machineId, status: 'RUNNING' }, select: { runNo: true } });
      if (other) throw new BadRequestException(`${run.machine.code} is knitting ${other.runNo} now; finish that run first`);
      if (run.stockTxnId) await this.inventory.removeInWithin(tx, run.stockTxnId, user.id);
      await tx.knittingRun.update({
        where: { id },
        data: { status: 'RUNNING', finishedAt: null, finishShift: null, outputKg: null, rollCount: null, knittingCharge: null, warehouseId: null, stockTxnId: null },
      });
      if (run.productionFlowId) {
        await this.syncProductionTask(tx, run.productionFlowId);
      }
      if (run.machine.status === MachineStatus.IDLE) await tx.machine.update({ where: { id: run.machineId }, data: { status: MachineStatus.RUNNING } });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'KNITTING_RUN_REOPENED', module: 'knitting', entity: 'KnittingRun', entityId: id, previousValue: { runNo: run.runNo, outputKg: num(run.outputKg) } },
      });
      return this.view(tx, id);
    });
  }

  /** Cancels a run still knitting: its yarn goes back into stock and the run is removed. */
  async cancel(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `knitting-run:${id}`);
      const run = await tx.knittingRun.findUnique({ where: { id }, include: { machine: true, yarns: true } });
      if (!run) throw new NotFoundException('Run not found');
      if (run.status !== 'RUNNING') throw new BadRequestException(`${run.runNo} is finished; undo the finish first`);
      const issues = run.productionFlowId ? [] : run.yarns.flatMap((y) => (y.issueTxnId ? [y.issueTxnId] : []));
      await this.inventory.deleteWithin(tx, issues, user.id);
      await tx.knittingRun.delete({ where: { id } });
      if (run.productionFlowId) {
        await this.syncProductionTask(tx, run.productionFlowId);
        const left = await tx.knittingRun.count({ where: { productionFlowId: run.productionFlowId } });
        if (!left) await tx.fabricProductionFlow.update({ where: { id: run.productionFlowId }, data: { knittingMillDetails: 'Pending machine selection' } });
      }
      if (run.machine.status === MachineStatus.RUNNING) await tx.machine.update({ where: { id: run.machineId }, data: { status: MachineStatus.IDLE } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'KNITTING_RUN_CANCELLED',
          module: 'knitting',
          entity: 'KnittingRun',
          entityId: id,
          previousValue: { runNo: run.runNo, machine: run.machine.code, yarns: run.yarns.map((y) => ({ itemCode: y.itemCode, kg: Number(y.kg) })) },
        },
      });
    });
    return { ok: true };
  }
}
