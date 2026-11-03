import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FabricDeliveryDestination, FabricProductionFlow, FabricSource, Prisma, ProcessDeliveryDestination, Role } from '@prisma/client';
import { fabricFlowView } from './fabric-flow-view';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { lockKeys } from '../common/locks';
import { InventoryService } from '../inventory/inventory.service';
import { GODOWN_ROLES } from '../common/roles';
import { notifyRoles } from '../notifications/notify.util';
import { notifyProcessDone } from './process-notify';
import { cancelChallan, hasChallan, issueChallan, issueWarehouseName } from './process-challans';
import { StorageService } from '../storage/storage.service';
import { dyeingLotCode, knittingCode } from '../common/numbering';
import { checkText } from '../common/packages';
import { poolFigures, poolSelect, settleYarnUsed } from './yarn-return';
import {
  CreateFabricExpenseDto,
  FinishKnittingDto,
  KnittingDetailsDto,
  ReceiveFabricDto,
  RecordDeliveryDto,
  StartCompactingDto,
  StartDyeingDto,
  StartKnittingDto,
  StartStockProcessDto,
  UpdateFabricCompactingDto,
  UpdateFabricDyeingDto,
} from './dto/fabric-flow.dto';

/**
 * How far a process's output may be above its input. Weight goes up or down by up to this much in each
 * process (1000 KG in may come out anywhere from about 900 to 1100 KG); losses beyond it are allowed but flagged.
 */
export const WEIGHT_TOLERANCE_KG = 100;

/** Processes a document or photo can be attached to. */
export const ATTACHMENT_STAGES = ['KNITTING', 'DYEING', 'COMPACTING', 'FINAL'] as const;

const attachmentSelect = { id: true, stage: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } as const;
/** A knitting batch's dyeing lots: where each is, for the batch's page and the list. */
const lotSelect = {
  select: { id: true, flowNo: true, status: true, color: true, purchasedWeightKg: true, dyeingDate: true, dyeingMillDetails: true, dyeingOutputWeightKg: true, compactingDate: true, officeDeliveryKg: true, finalDeliveredKg: true },
  orderBy: { flowNo: 'asc' as const },
};
const parentSelect = { select: { id: true, flowNo: true } };
const flowInclude = {
  lots: lotSelect,
  parent: parentSelect,
  expenses: { orderBy: { expenseDate: 'asc' as const } },
  knittingRuns: { select: { id: true, runNo: true, status: true, yarnKg: true, outputKg: true, rollCount: true, machine: { select: { id: true, code: true, name: true } } }, orderBy: { createdAt: 'asc' as const } },
  attachments: { select: attachmentSelect, orderBy: { createdAt: 'asc' as const } },
  challans: {
    select: { id: true, challanNo: true, handOff: true, date: true, material: true, fromName: true, toKind: true, toName: true, weightKg: true, packages: true, packageUnit: true, vehicleNo: true, cancelledAt: true },
    orderBy: { createdAt: 'asc' as const },
  },
  yarnWarehouse: { select: { code: true, name: true } },
  deliveries: {
    include: { warehouse: { select: { code: true, name: true } } },
    orderBy: { deliveredAt: 'asc' as const },
  },
};

/**
 * What the Production front needs for every batch: its own fields, the hand-offs and deliveries (where it is), the
 * expense amounts (its cost) and its challans' state. No files, machine runs or challan details: those load with
 * the one batch that is opened.
 */
const flowListInclude = {
  lots: lotSelect,
  parent: parentSelect,
  expenses: { select: { amount: true } },
  yarnWarehouse: { select: { code: true, name: true } },
  deliveries: {
    select: { id: true, deliveredAt: true, destination: true, processStage: true, partyName: true, weightKg: true, amount: true, expense: true, receivedAt: true, receivedWeightKg: true, warehouse: { select: { code: true, name: true } } },
    orderBy: { deliveredAt: 'asc' as const },
  },
  challans: { select: { id: true, cancelledAt: true } },
} satisfies Prisma.FabricProductionFlowInclude;

/** Who knitted a batch, as a challan's sender: the own mill's machines or the other mill. */
const knitter = (flow: FabricProductionFlow) =>
  flow.knittingMillType === 'OWN' ? `Own mill${flow.knittingMillDetails && flow.knittingMillDetails !== 'Pending machine selection' ? ` · ${flow.knittingMillDetails}` : ''}` : flow.knittingMillDetails || flow.knittingPartyDetails || 'Knitting mill';

/** Finished fabric put into a warehouse is stock under the batch's own code. */
const fabricName = (flow: FabricProductionFlow) => `${flow.yarnCount} fabric${flow.color ? ` · ${flow.color}` : ''}`;

@Injectable()
export class ProductionService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private storage: StorageService,
  ) {}

  // ─── Standalone fabric flow ─────────────────────────────────────────────

  private async requireFabricFlow(id: string, db: PrismaService | Prisma.TransactionClient = this.prisma) {
    const flow = await db.fabricProductionFlow.findUnique({ where: { id } });
    if (!flow) throw new NotFoundException('Yarn batch not found. Refresh the page and select an existing batch.');
    return flow;
  }

  /** Fabric can gain weight in a process (moisture, chemicals), up to WEIGHT_TOLERANCE_KG over what went in. */
  private assertWeight(label: string, output: number, input: number) {
    if (output > input + WEIGHT_TOLERANCE_KG + 0.001) {
      throw new BadRequestException(
        `${label} can be at most ${WEIGHT_TOLERANCE_KG} KG more than the ${input.toFixed(3)} KG that went in (up to ${(input + WEIGHT_TOLERANCE_KG).toFixed(3)} KG)`,
      );
    }
  }

  private fabricFlowView(flow: FabricProductionFlow, user?: AuthUser) {
    const raw = flow as FabricProductionFlow & { deliveries?: Array<{ processStage: string }> };
    const base = fabricFlowView(flow);
    const view = {
      ...base,
      deliveries: raw.deliveries?.filter((delivery) => delivery.processStage === 'FINAL') ?? [],
      processDeliveries: raw.deliveries?.filter((delivery) => delivery.processStage !== 'FINAL') ?? [],
    };
    if (user?.role !== Role.MANAGER) return view;
    return {
      ...view,
      yarnRatePerKg: 0,
      purchaseOtherCost: 0,
      knittingExpense: 0,
      dyeingExpense: 0,
      compactingExpense: 0,
      collectedAmount: 0,
      otherExpense: 0,
      expenses: [],
      deliveries: [],
      processDeliveries: [],
      metrics: { ...view.metrics, yarnAmount: 0, totalSpent: 0, additionalExpenses: 0, profit: 0 },
    };
  }

  /**
   * The floor at a glance for the Production front: every machine with its status and operator, what each running
   * one is knitting (and its last day entry), the KG knitted per production day this month and the last two weeks,
   * the fabric knitted so far on each batch still knitting, and the material in stock by kind (yarn, grey, dyed and
   * finished fabric) with every code, its name and the warehouses holding it. One request.
   */
  async overview() {
    const kinds = ['YARN', 'GREY_FABRIC', 'DYED_FABRIC', 'FINISHED_FABRIC'] as const;
    // Production days are stored as dates; from the 1st of this month, or two weeks back if that is earlier.
    const today = new Date();
    const since = new Date(Math.min(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1), Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 15)));
    // One round of reads: the warehouses are few, so all of them come along, and the running runs' totals follow the
    // runs straight away instead of waiting for everything else.
    const [machines, [running, runTotals], positions, days, knitted, warehouses] = await Promise.all([
      this.prisma.machine.findMany({
        where: { status: { not: 'DISABLED' } },
        select: { id: true, code: true, name: true, type: true, status: true, operator: { select: { name: true, mobile: true } } },
        orderBy: { code: 'asc' },
      }),
      this.prisma.knittingRun.findMany({
        where: { status: 'RUNNING' },
        select: {
          id: true,
          runNo: true,
          outputKg: true,
          rollCount: true,
          startedAt: true,
          startShift: true,
          yarnKg: true,
          machine: { select: { id: true, code: true, name: true } },
          operator: { select: { name: true, mobile: true } },
          productionFlow: { select: { flowNo: true, fabricType: true, fabricDiameter: true, fabricGsm: true, color: true, yarnItemCode: true, yarnCount: true } },
          days: { select: { date: true, outputKg: true, rollCount: true }, orderBy: { date: 'desc' }, take: 1 },
        },
        orderBy: { machine: { code: 'asc' } },
      }).then(async (runs) => [
        runs,
        // What each running run has knitted so far, over how many days.
        runs.length
          ? await this.prisma.knittingDayEntry.groupBy({ by: ['runId'], where: { runId: { in: runs.map((r) => r.id) } }, _sum: { outputKg: true, rollCount: true }, _count: { _all: true } })
          : [],
      ] as const),
      this.prisma.stockTransaction.groupBy({
        by: ['category', 'itemCode', 'itemName', 'warehouseId'],
        where: { category: { in: [...kinds] }, unit: { equals: 'KG', mode: 'insensitive' } },
        _sum: { quantityIn: true, quantityOut: true },
      }),
      this.prisma.knittingDayEntry.groupBy({
        by: ['date'],
        where: { date: { gte: since } },
        _sum: { outputKg: true, rollCount: true },
        _count: { _all: true },
        orderBy: { date: 'asc' },
      }),
      // Grey fabric already knitted (and in stock) on batches whose knitting isn't complete.
      this.prisma.knittingRun.groupBy({
        by: ['productionFlowId'],
        where: { productionFlowId: { not: null }, productionFlow: { knittingFinishedAt: null } },
        _sum: { outputKg: true },
      }),
      this.prisma.warehouse.findMany({ select: { id: true, code: true, name: true } }),
    ]);
    const held = positions
      .map((p) => ({ category: p.category, itemCode: p.itemCode, itemName: p.itemName, warehouseId: p.warehouseId, kg: Number(p._sum.quantityIn ?? 0) - Number(p._sum.quantityOut ?? 0) }))
      .filter((p) => p.kg > 0.0005);
    const totalOf = new Map(runTotals.map((t) => [t.runId, t]));
    const warehouseOf = new Map(warehouses.map((w) => [w.id, w]));
    const round3 = (v: number) => Math.round(v * 1000) / 1000;
    const byStatus: Record<string, number> = {};
    for (const m of machines) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    return {
      machines: {
        total: machines.length,
        byStatus,
        list: machines,
        running: running.map(({ days: [last], ...r }) => ({
          ...r,
          yarnKg: Number(r.yarnKg),
          outputKg: r.outputKg === null ? round3(Number(totalOf.get(r.id)?._sum.outputKg ?? 0)) : Number(r.outputKg),
          rollCount: r.rollCount ?? totalOf.get(r.id)?._sum.rollCount ?? 0,
          dayCount: totalOf.get(r.id)?._count._all ?? 0,
          lastDay: last ? { date: last.date.toISOString().slice(0, 10), outputKg: Number(last.outputKg), rollCount: last.rollCount } : null,
        })),
      },
      knitting: {
        days: days.map((d) => ({ date: d.date.toISOString().slice(0, 10), kg: round3(Number(d._sum.outputKg ?? 0)), rolls: d._sum.rollCount ?? 0, machines: d._count._all })),
        knittedByFlow: knitted.flatMap((k) => (k.productionFlowId ? [{ flowId: k.productionFlowId, kg: round3(Number(k._sum.outputKg ?? 0)) }] : [])),
      },
      stock: kinds.map((category) => {
        const rows = held.filter((p) => p.category === category);
        const byCode = new Map<string, { itemName: string; kg: number; warehouses: Map<string, number> }>();
        const byWarehouse = new Map<string, number>();
        for (const r of rows) {
          const item = byCode.get(r.itemCode) ?? { itemName: r.itemName, kg: 0, warehouses: new Map<string, number>() };
          item.kg += r.kg;
          if (!item.itemName) item.itemName = r.itemName;
          item.warehouses.set(r.warehouseId, (item.warehouses.get(r.warehouseId) ?? 0) + r.kg);
          byCode.set(r.itemCode, item);
          byWarehouse.set(r.warehouseId, (byWarehouse.get(r.warehouseId) ?? 0) + r.kg);
        }
        return {
          category,
          kg: round3(rows.reduce((sum, r) => sum + r.kg, 0)),
          codes: byCode.size,
          warehouses: [...byWarehouse]
            .map(([id, kg]) => ({ id, code: warehouseOf.get(id)?.code ?? 'Warehouse', name: warehouseOf.get(id)?.name ?? '', kg: round3(kg) }))
            .sort((a, b) => b.kg - a.kg),
          // Every code held (the largest first), with where it is.
          items: [...byCode]
            .map(([itemCode, item]) => ({
              itemCode,
              itemName: item.itemName,
              kg: round3(item.kg),
              warehouses: [...item.warehouses]
                .map(([id, kg]) => ({ id, code: warehouseOf.get(id)?.code ?? 'Warehouse', name: warehouseOf.get(id)?.name ?? '', kg: round3(kg) }))
                .sort((a, b) => b.kg - a.kg),
            }))
            .sort((a, b) => b.kg - a.kg)
            .slice(0, 300),
        };
      }),
    };
  }

  /** One batch with everything (files, machine runs, challans), for its own page; managers only see knitting tasks. */
  async fabricFlowByCode(flowNo: string, user?: AuthUser) {
    const flow = await this.prisma.fabricProductionFlow.findFirst({ where: { flowNo: { equals: flowNo.trim(), mode: 'insensitive' } }, include: flowInclude });
    if (!flow || (user?.role === Role.MANAGER && !(flow.status === 'KNITTING' && flow.knittingMillType === 'OWN' && !flow.parentId))) {
      throw new NotFoundException(`No batch with code ${flowNo.trim().toUpperCase()}`);
    }
    const group = flow.yarnIssueTxnId ? await this.prisma.fabricProductionFlow.findMany({ where: { yarnIssueTxnId: flow.yarnIssueTxnId }, select: poolSelect }) : [];
    return { ...this.fabricFlowView(flow, user), yarnPool: poolFigures(flow, group) };
  }

  /** Every batch; `light` leaves out what only a batch's own page shows (files, machine runs, challan details). */
  async fabricFlows(user?: AuthUser, light = false) {
    const flows = await this.prisma.fabricProductionFlow.findMany({ include: light ? flowListInclude : flowInclude, orderBy: [{ status: 'asc' }, { purchaseDate: 'desc' }] });
    // Fabric types started together share one yarn issue.
    const byIssue = new Map<string, typeof flows>();
    for (const f of flows) if (f.yarnIssueTxnId) byIssue.set(f.yarnIssueTxnId, [...(byIssue.get(f.yarnIssueTxnId) ?? []), f]);
    const data = flows
      .filter((flow) => user?.role !== Role.MANAGER || (flow.status === 'KNITTING' && flow.knittingMillType === 'OWN' && !flow.parentId))
      .map((flow) => ({ ...this.fabricFlowView(flow, user), yarnPool: poolFigures(flow, byIssue.get(flow.yarnIssueTxnId ?? '') ?? []) }));
    const summary = data.reduce(
      (totals, flow) => ({
        activeBatches: totals.activeBatches + (flow.status === 'DELIVERED' ? 0 : 1),
        purchasedKg: totals.purchasedKg + (flow.parentId ? 0 : flow.purchasedWeightKg),
        currentKg: totals.currentKg + flow.metrics.currentWeightKg,
        totalLossKg: totals.totalLossKg + flow.metrics.totalLossKg,
        totalSpent: totals.totalSpent + flow.metrics.totalSpent,
        collectedAmount: totals.collectedAmount + flow.collectedAmount,
        profit: totals.profit + flow.metrics.profit,
      }),
      { activeBatches: 0, purchasedKg: 0, currentKg: 0, totalLossKg: 0, totalSpent: 0, collectedAmount: 0, profit: 0 },
    );
    return { data, summary };
  }

  async addExpense(id: string, dto: CreateFabricExpenseDto, user: AuthUser) {
    const flow = await this.prisma.$transaction(async (tx) => {
      const current = await tx.fabricProductionFlow.findUnique({ where: { id }, select: { flowNo: true } });
      if (!current) throw new NotFoundException('Production batch not found');
      const expense = await tx.fabricFlowExpense.create({
        data: { flowId: id, expenseDate: new Date(dto.expenseDate), category: dto.category.trim(), description: dto.description?.trim() || null, amount: dto.amount, createdById: user.id },
      });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'PRODUCTION_EXPENSE_ADDED', module: 'production', entity: 'FabricProductionFlow', entityId: id, newValue: { flowNo: current.flowNo, expenseId: expense.id, category: expense.category, amount: dto.amount } } });
      return tx.fabricProductionFlow.findUniqueOrThrow({ where: { id }, include: flowInclude });
    });
    return this.fabricFlowView(flow);
  }

  async deleteExpense(id: string, expenseId: string, user: AuthUser) {
    const flow = await this.prisma.$transaction(async (tx) => {
      const expense = await tx.fabricFlowExpense.findFirst({ where: { id: expenseId, flowId: id }, include: { flow: { select: { flowNo: true } } } });
      if (!expense) throw new NotFoundException('Production expense not found');
      await tx.fabricFlowExpense.delete({ where: { id: expenseId } });
      await tx.auditLog.create({ data: { actorId: user.id, action: 'PRODUCTION_EXPENSE_DELETED', module: 'production', entity: 'FabricProductionFlow', entityId: id, previousValue: { flowNo: expense.flow.flowNo, category: expense.category, amount: Number(expense.amount) } } });
      return tx.fabricProductionFlow.findUniqueOrThrow({ where: { id }, include: flowInclude });
    });
    return this.fabricFlowView(flow);
  }

  private dedupeNames(values: (string | null | undefined)[]) {
    const seen = new Map<string, string>();
    for (const raw of values) {
      const value = (raw || '').trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (!seen.has(key)) seen.set(key, value);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }

  async fabricFlowDirectory() {
    const [flows, masterMills] = await Promise.all([
      this.prisma.fabricProductionFlow.findMany({ select: {
        partyDetails: true,
        millDetails: true,
        knittingPartyDetails: true,
        knittingMillDetails: true,
        knittingYarnStock: true,
        knittingFabricStock: true,
        dyeingPartyDetails: true,
        dyeingMillDetails: true,
        compactingPartyDetails: true,
        compactingMillDetails: true,
      } }),
      this.prisma.mill.findMany({ where: { active: true }, select: { name: true, services: true }, orderBy: { name: 'asc' } }),
    ]);
    const [deliveredTo, distributors, textiles] = await Promise.all([
      this.prisma.fabricFlowDelivery.findMany({ where: { partyName: { not: null } }, select: { partyName: true }, distinct: ['partyName'] }),
      this.prisma.supplier.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } }),
      this.prisma.textile.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } }),
    ]);
    // Parties and mills of every process, suggested in each process's form.
    const dealers = this.dedupeNames(flows.flatMap((f) => [f.partyDetails, f.knittingPartyDetails, f.dyeingPartyDetails, f.compactingPartyDetails]));
    const mills = this.dedupeNames(flows.flatMap((f) => [f.millDetails, f.knittingMillDetails, f.dyeingMillDetails, f.compactingMillDetails]));
    const yarnStocks = this.dedupeNames(flows.map((f) => f.knittingYarnStock));
    const fabricStocks = this.dedupeNames(flows.map((f) => f.knittingFabricStock));
    const forProcess = (process: string) => masterMills.filter((mill) => mill.services.split(',').includes(process)).map((mill) => mill.name);
    // Who finished fabric was delivered to before, the textiles and the distributors, suggested when recording a delivery.
    const deliveryParties = this.dedupeNames([...deliveredTo.map((d) => d.partyName), ...textiles.map((t) => t.name), ...distributors.map((d) => d.name)]);
    return { dealers, mills, knittingMills: forProcess('KNITTING'), dyeingMills: forProcess('DYEING'), compactingMills: forProcess('COMPACTING'), yarnStocks, fabricStocks, deliveryParties };
  }

  /** The next number after `prefix` among batch codes (…-KT01, -KT02 or …-DY01…), ignoring longer codes under them. */
  private async nextSuffix(tx: Prisma.TransactionClient, prefix: string) {
    const taken = await tx.fabricProductionFlow.findMany({ where: { flowNo: { startsWith: prefix } }, select: { flowNo: true } });
    const numbers = taken.map((f) => f.flowNo.slice(prefix.length)).filter((s) => /^\d+$/.test(s)).map(Number);
    return Math.max(0, ...numbers) + 1;
  }

  /** Each knitting of a yarn is a knitting batch under the yarn's code: 01SS26-KT01, -KT02… */
  private async batchCodeFor(tx: Prisma.TransactionClient, itemCode: string) {
    return knittingCode(itemCode, await this.nextSuffix(tx, `${itemCode}-KT`));
  }

  /**
   * Splits what is left of a knitting batch's grey fabric into dyeing lots, one per colour, each its own batch from
   * here on (01SS26-KT01-DY01…): dyeing starts for each at the mill, and compacting and delivery follow on it. A lot
   * takes on its share of the knitting batch's cost as its grey fabric cost. One colour may leave its KG out to take
   * all that is left. `take` takes a lot's fabric out of stock (and says from which warehouse) when it is there.
   */
  private async createDyeingLots(
    tx: Prisma.TransactionClient,
    parent: FabricProductionFlow,
    lines: Array<{ color?: string; kg?: number }>,
    availableKg: number,
    start: { date: Date; party: string; mill: string; notes: string | null },
    take: (kg: number, lot: { id: string; flowNo: string }) => Promise<{ txnId: string | null; store: string | null }>,
    user?: AuthUser,
  ) {
    await lockKeys(tx, `batch-code:${parent.flowNo}`);
    const blanks = lines.filter((line) => line.kg === undefined).length;
    if (blanks > 1) throw new BadRequestException('Enter the KG of every colour but one; that one takes the rest');
    const typed = lines.reduce((sum, line) => sum + (line.kg ?? 0), 0);
    if (typed > availableKg + 0.0005) throw new BadRequestException(`Only ${availableKg.toFixed(3)} KG of ${parent.flowNo} grey fabric is left for dyeing`);
    const rest = Math.round((availableKg - typed) * 1000) / 1000;
    if (blanks && rest < 0.001) throw new BadRequestException(`No ${parent.flowNo} grey fabric is left for the colour without a KG`);

    // The knitting batch's full cost so far (yarn, knitting, its expenses) per KG of grey fabric.
    const expenses = await tx.fabricFlowExpense.findMany({ where: { flowId: parent.id }, select: { amount: true } });
    const { costPerKg } = fabricFlowView({ ...parent, expenses }).metrics;
    // A knitting batch sent straight to the dyeing mill already has its challan there.
    const challanDone = parent.knittingDestination === ProcessDeliveryDestination.NEXT_PROCESS && !parent.knittingDestinationWarehouseId && (await hasChallan(tx, parent.id, 'KNITTING'));
    let n = await this.nextSuffix(tx, `${parent.flowNo}-DY`);
    const created: Array<{ id: string; flowNo: string; kg: number; color: string | null }> = [];
    for (const line of lines) {
      const kg = Math.round((line.kg ?? rest) * 1000) / 1000;
      const flowNo = dyeingLotCode(parent.flowNo, n++);
      const color = line.color?.trim() || null;
      const lot = await tx.fabricProductionFlow.create({
        data: {
          flowNo,
          parentId: parent.id,
          status: 'KNITTING',
          source: FabricSource.STOCK,
          yarnItemCode: parent.yarnItemCode,
          yarnLotNo: parent.yarnLotNo,
          yarnCount: parent.yarnCount,
          fabricType: parent.fabricType,
          fabricDiameter: parent.fabricDiameter,
          fabricGsm: parent.fabricGsm,
          purchaseDate: start.date,
          bagCount: 0,
          // The lot's input is its grey fabric, at what a KG of it cost the knitting batch.
          purchasedWeightKg: kg,
          yarnRatePerKg: Math.round(costPerKg * 100) / 100,
          knittingMillType: parent.knittingMillType,
          knittingPartyDetails: parent.knittingPartyDetails,
          knittingMillDetails: parent.knittingMillDetails,
          knittingGg: parent.knittingGg,
          knittingLl: parent.knittingLl,
          knittingDate: parent.knittingDate,
          knittingFinishedAt: parent.knittingFinishedAt ?? start.date,
          knittingDeliveryKg: kg,
          knittingDestination: ProcessDeliveryDestination.NEXT_PROCESS,
          dyeingDeliveryKg: kg,
          dyeingDate: start.date,
          dyeingPartyDetails: start.party,
          dyeingMillDetails: start.mill,
          fabricReceivedKg: kg,
          color,
          dyeingNotes: start.notes,
        },
      });
      const taken = await take(kg, lot);
      if (taken.txnId) await tx.fabricProductionFlow.update({ where: { id: lot.id }, data: { dyeingIssueTxnId: taken.txnId } });
      if (!challanDone) {
        await issueChallan(tx, {
          flowId: lot.id,
          handOff: 'DYEING_IN',
          date: start.date,
          material: 'Grey fabric',
          from: taken.store ? { kind: 'WAREHOUSE', name: taken.store } : { kind: 'PROCESS', name: knitter(parent) },
          to: { kind: 'PROCESS', name: start.mill },
          weightKg: kg,
          packages: null,
          packageUnit: 'rolls',
          notes: [color && `Dye ${color} · lot ${flowNo}`, start.notes].filter(Boolean).join(' · ') || null,
          createdById: user?.id,
        });
      }
      created.push({ id: lot.id, flowNo, kg, color });
    }
    // The knitting batch is past knitting now; once all its fabric is in lots, its own part is done.
    const lotsKg = await tx.fabricProductionFlow.aggregate({ where: { parentId: parent.id }, _sum: { purchasedWeightKg: true } });
    const knitted = Number(parent.knittingDeliveryKg ?? parent.dyeingDeliveryKg ?? 0);
    const left = knitted - Number(lotsKg._sum.purchasedWeightKg ?? 0);
    await tx.fabricProductionFlow.update({ where: { id: parent.id }, data: { status: left > 0.0005 ? 'DYEING' : 'DELIVERED' } });
    await tx.auditLog.create({
      data: {
        actorId: user?.id,
        action: 'DYEING_LOTS_STARTED',
        module: 'production',
        entity: 'FabricProductionFlow',
        entityId: parent.id,
        newValue: { flowNo: parent.flowNo, mill: start.mill, lots: created.map((lot) => ({ flowNo: lot.flowNo, kg: lot.kg, color: lot.color })) },
      },
    });
    return created;
  }

  /**
   * Takes a lot's grey fabric of a knitting batch out of stock where it is in stock: under the batch's own code (grey
   * fabric a dyeing lot didn't use came back there) first, then (own mill) the machines' run codes (…-R1, -R2) they
   * put it in under day by day, the fullest first. What isn't in stock (at the mill, or taken out by hand) is left; the
   * lot keeps its weight.
   */
  private async takeRunFabric(tx: Prisma.TransactionClient, parent: FabricProductionFlow, kg: number, lot: { id: string; flowNo: string }, user?: AuthUser) {
    const runs = await tx.knittingRun.findMany({ where: { productionFlowId: parent.id }, select: { runNo: true } });
    const positions = await tx.stockTransaction.groupBy({
      by: ['itemCode', 'itemName', 'warehouseId'],
      where: { category: 'GREY_FABRIC', itemCode: { in: [parent.flowNo, ...runs.map((r) => r.runNo)] }, lotNo: null, unit: 'KG' },
      _sum: { quantityIn: true, quantityOut: true },
    });
    const held = positions
      .map((p) => ({ ...p, kg: Number(p._sum.quantityIn ?? 0) - Number(p._sum.quantityOut ?? 0) }))
      .filter((p) => p.kg > 0.0005)
      .sort((a, b) => Number(b.itemCode === parent.flowNo) - Number(a.itemCode === parent.flowNo) || b.kg - a.kg);
    let left = kg;
    let first: string | null = null;
    for (const p of held) {
      if (left <= 0.0005) break;
      const out = Math.round(Math.min(left, p.kg) * 1000) / 1000;
      const issue = await this.inventory.issueWithin(tx, {
        category: 'GREY_FABRIC',
        itemCode: p.itemCode,
        warehouseId: p.warehouseId,
        txnType: 'DYEING_ISSUE',
        itemName: p.itemName,
        quantityOut: out,
        unit: 'KG',
        referenceType: 'PRODUCTION_BATCH',
        referenceId: lot.id,
        createdById: user?.id,
        notes: `${p.itemCode} to dyeing as ${lot.flowNo}`,
      });
      first ??= issue.id;
      left -= out;
    }
    return { txnId: first, store: first ? await issueWarehouseName(tx, first) : null };
  }

  /** A batch that dyes in lots: a knitting batch whose own row has no dyeing (older batches dyed on themselves). */
  private dyesInLots(flow: FabricProductionFlow) {
    return !flow.parentId && flow.dyeingDate === null && !flow.dyeingIssueTxnId && flow.dyeingOutputWeightKg === null;
  }

  /** Knitting details are editable until the batch reaches dyeing (or, delivered to a party, until anything follows). */
  private assertKnittingOpen(flow: FabricProductionFlow) {
    const soldAtKnitting = flow.status === 'DELIVERED' && flow.knittingDestination === ProcessDeliveryDestination.PARTY && flow.dyeingDate === null;
    if ((flow.status !== 'KNITTING' && !soldAtKnitting) || flow.fabricReceivedKg !== null) {
      throw new BadRequestException(`${flow.flowNo} has moved past knitting; its knitting can no longer be changed`);
    }
  }

  private async assertProcessNotReceived(flowId: string, stage: 'KNITTING' | 'DYEING', db: PrismaService | Prisma.TransactionClient = this.prisma) {
    if (await db.fabricFlowDelivery.findFirst({ where: { flowId, processStage: stage, receivedAt: { not: null } }, select: { id: true } })) {
      throw new BadRequestException(`${stage.toLowerCase()} material has been received by the warehouse and can no longer be changed`);
    }
  }

  private knittingDetails(dto: KnittingDetailsDto) {
    return {
      knittingDate: new Date(dto.startDate),
      purchaseDate: new Date(dto.startDate),
      knittingExpectedFinishDate: dto.expectedFinishDate ? new Date(dto.expectedFinishDate) : null,
      knittingPartyDetails: dto.partyDetails?.trim() || dto.millDetails.trim(),
      knittingMillDetails: dto.millDetails.trim(),
      knittingGg: dto.gg?.trim() || null,
      knittingLl: dto.ll?.trim() || null,
      ...(dto.yarnRatePerKg !== undefined ? { yarnRatePerKg: dto.yarnRatePerKg } : {}),
    };
  }

  /** The latest purchase price per KG of an item, for a yarn whose price isn't typed. */
  private async lastPurchaseRate(tx: Prisma.TransactionClient, itemCode: string) {
    // Yarn received in the register carries its own rate.
    const received = await tx.yarnReceiptLine.findUnique({ where: { itemCode }, select: { ratePerKg: true } });
    if (received?.ratePerKg) return Number(received.ratePerKg);
    const line = await tx.purchaseOrderItem.findFirst({ where: { itemCode, unit: 'KG' }, orderBy: { purchaseOrder: { orderDate: 'desc' } }, select: { rate: true } });
    return line ? Number(line.rate) : 0;
  }

  private async requireDestinationWarehouse(destination: ProcessDeliveryDestination, warehouseId?: string) {
    if (destination !== ProcessDeliveryDestination.WAREHOUSE) return null;
    const warehouse = warehouseId && await this.prisma.warehouse.findFirst({ where: { id: warehouseId, active: true }, select: { id: true, code: true, name: true } });
    if (!warehouse) throw new BadRequestException('Choose an active delivery warehouse');
    return warehouse;
  }

  /**
   * Keeps a process's hand-off to a warehouse in step with its record until the warehouse receives it: made when the
   * fabric goes to a warehouse, its warehouse / weight / date corrected on later saves, and removed when the fabric
   * goes on to the next process instead. Runs under the batch lock that receiving takes too.
   */
  private async syncWarehouseHandOff(
    tx: Prisma.TransactionClient,
    flowId: string,
    stage: 'KNITTING' | 'DYEING',
    warehouse: { id: string } | null,
    data: { deliveredAt: Date; weightKg: number; notes: string | null; createdById?: string },
  ) {
    const existing = await tx.fabricFlowDelivery.findFirst({ where: { flowId, processStage: stage } });
    if (existing?.receivedAt) {
      throw new BadRequestException(`${stage.toLowerCase()} material has been received by the warehouse and can no longer be changed`);
    }
    if (!warehouse) {
      if (existing) await tx.fabricFlowDelivery.delete({ where: { id: existing.id } });
      return;
    }
    if (existing) {
      await tx.fabricFlowDelivery.update({
        where: { id: existing.id },
        data: { warehouseId: warehouse.id, deliveredAt: data.deliveredAt, weightKg: data.weightKg, notes: data.notes },
      });
      return;
    }
    await tx.fabricFlowDelivery.create({
      data: {
        flowId,
        deliveredAt: data.deliveredAt,
        destination: FabricDeliveryDestination.WAREHOUSE,
        processStage: stage,
        warehouseId: warehouse.id,
        weightKg: data.weightKg,
        createdById: data.createdById,
        notes: data.notes,
      },
    });
  }

  /**
   * Starts a batch: takes the yarn out of its warehouse (never more than is in stock) and begins knitting it,
   * all in one transaction. The batch is known by the yarn's item code.
   */
  async startKnitting(dto: StartKnittingDto, user: AuthUser) {
    const itemCode = dto.yarnItemCode.trim();
    const lotNo = dto.yarnLotNo?.trim() || null;
    const responsibleParty = dto.partyDetails?.trim() || dto.millDetails.trim();
    // Each fabric type is a knitting batch of its own; without a list, the one type given.
    const types = dto.fabrics?.length
      ? dto.fabrics
      : [{ fabricType: dto.fabricType, fabricDiameter: dto.fabricDiameter, fabricGsm: dto.fabricGsm, gg: dto.gg, ll: dto.ll, yarnKg: dto.yarnKg }];
    const flows = await this.prisma.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { code: true } });
      if (!warehouse) throw new BadRequestException('Choose an active warehouse');
      const position = { itemCode, warehouseId: dto.warehouseId, category: dto.yarnCategory, lotNo };
      const latest = await tx.stockTransaction.findFirst({ where: position, orderBy: { createdAt: 'desc' }, select: { itemName: true } });
      if (!latest) throw new BadRequestException(`There is no ${itemCode}${lotNo ? ` lot ${lotNo}` : ''} in ${warehouse.code}`);
      if (await tx.stockTransaction.findFirst({ where: { ...position, unit: { not: 'KG' } }, select: { id: true } })) {
        throw new BadRequestException(`${itemCode} is kept in another unit than KG; knitting takes yarn by KG`);
      }

      // No weight is typed at the start: all the yarn of that position goes (shared by the types); what was used is
      // entered when each finishes, and the rest goes back.
      const available = await this.inventory.availableWithin(tx, position);
      const where = `${itemCode}${lotNo ? ` lot ${lotNo}` : ''}`;
      if (!(available > 0.0005)) throw new BadRequestException(`No ${where} is left in ${warehouse.code}`);
      const blanks = types.filter((t) => t.yarnKg === undefined).length;
      // Types with no yarn KG at all share the yarn; typing some means every one but one (that one takes the rest).
      if (types.length > 1 && blanks > 1 && blanks < types.length) throw new BadRequestException('Enter the yarn KG of every fabric type but one; that one takes the rest');
      const typed = types.reduce((sum, t) => sum + (t.yarnKg ?? 0), 0);
      if (typed > available + 0.0005) throw new BadRequestException(`Only ${available.toFixed(3)} KG of ${where} is in ${warehouse.code}`);
      const rest = Math.round((available - typed) * 1000) / 1000;
      if (blanks && !(rest > 0.0005)) throw new BadRequestException(`No ${where} is left for the fabric type without a yarn KG`);
      if (dto.plannedFabricKg !== undefined && types.length === 1 && dto.plannedFabricKg > (types[0].yarnKg ?? available) + 0.0005) {
        throw new BadRequestException(`${dto.plannedFabricKg} KG of fabric needs more than the yarn sent`);
      }
      const yarnRatePerKg = dto.yarnRatePerKg ?? (await this.lastPurchaseRate(tx, itemCode));

      await lockKeys(tx, `batch-code:${itemCode}`);
      // Several types with no yarn KG share all of it (one issue); each is shown an equal share until it finishes
      // with the yarn it used. Otherwise each type takes its own KG (one without takes the rest).
      const shared = types.length > 1 && types.every((t) => t.yarnKg === undefined);
      const share = (index: number) => {
        const each = Math.floor((available / types.length) * 1000) / 1000;
        return index === types.length - 1 ? Math.round((available - each * (types.length - 1)) * 1000) / 1000 : each;
      };
      const ids: string[] = [];
      for (const [index, type] of types.entries()) {
        const yarnKg = shared ? share(index) : Math.round((type.yarnKg ?? rest) * 1000) / 1000;
        const flowNo = await this.batchCodeFor(tx, itemCode);
        const created = await tx.fabricProductionFlow.create({
          data: {
            ...this.knittingDetails(dto),
            knittingGg: type.gg?.trim() || null,
            knittingLl: type.ll?.trim() || null,
            flowNo,
            status: 'KNITTING',
            source: FabricSource.STOCK,
            knittingMillType: dto.millType,
            yarnItemCode: itemCode,
            fabricType: type.fabricType.trim(),
            fabricDiameter: type.fabricDiameter.trim(),
            fabricGsm: type.fabricGsm?.trim() || null,
            yarnWarehouseId: dto.warehouseId,
            yarnLotNo: lotNo,
            yarnCount: latest.itemName,
            bagCount: 0,
            yarnRatePerKg,
            purchasedWeightKg: yarnKg,
            yarnReceivedKg: yarnKg,
            plannedFabricKg: types.length === 1 ? (dto.plannedFabricKg ?? null) : null,
          },
        });
        if (!shared) {
          const issue = await this.inventory.issueWithin(tx, {
            ...position,
            lotNo: lotNo ?? undefined,
            txnType: 'KNITTING_ISSUE',
            itemName: latest.itemName,
            quantityOut: yarnKg,
            unit: 'KG',
            referenceType: 'PRODUCTION_BATCH',
            referenceId: created.id,
            createdById: user.id,
            notes: `${flowNo} ${type.fabricType.trim()} · ${dto.millType === 'OWN' ? 'own-mill knitting task' : 'other-mill knitting'} · ${responsibleParty}`,
          });
          await tx.fabricProductionFlow.update({ where: { id: created.id }, data: { yarnIssueTxnId: issue.id } });
        }
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'KNITTING_STARTED',
            module: 'production',
            entity: 'FabricProductionFlow',
            entityId: created.id,
            newValue: { flowNo, millType: dto.millType, yarnItemCode: itemCode, fabricType: type.fabricType.trim(), fabricDiameter: type.fabricDiameter.trim(), fabricGsm: type.fabricGsm?.trim() || null, warehouse: warehouse.code, lotNo, yarnKg, types: types.length, party: responsibleParty },
          },
        });
        ids.push(created.id);
      }
      if (shared) {
        // All of the yarn goes out once, for every type; each batch points at that issue.
        const codes = (await tx.fabricProductionFlow.findMany({ where: { id: { in: ids } }, select: { flowNo: true }, orderBy: { flowNo: 'asc' } })).map((f) => f.flowNo);
        const issue = await this.inventory.issueWithin(tx, {
          ...position,
          lotNo: lotNo ?? undefined,
          txnType: 'KNITTING_ISSUE',
          itemName: latest.itemName,
          quantityOut: Math.round(available * 1000) / 1000,
          unit: 'KG',
          referenceType: 'PRODUCTION_BATCH',
          referenceId: ids[0],
          createdById: user.id,
          notes: `${codes.join(' + ')} share this yarn · ${dto.millType === 'OWN' ? 'own-mill knitting' : 'other-mill knitting'} · ${responsibleParty}`,
        });
        await tx.fabricProductionFlow.updateMany({ where: { id: { in: ids } }, data: { yarnIssueTxnId: issue.id } });
      }
      return tx.fabricProductionFlow.findMany({ where: { id: { in: ids } }, include: flowInclude, orderBy: { flowNo: 'asc' } });
    });
    // The first batch, and every batch started (one per fabric type).
    return { ...this.fabricFlowView(flows[0]), started: flows.map((f) => ({ flowNo: f.flowNo, fabricType: f.fabricType, yarnKg: Number(f.purchasedWeightKg) })) };
  }

  /** Takes an existing batch's grey/dyed fabric out of a warehouse and opens its next recorded process. */
  async startStockProcess(dto: StartStockProcessDto, user: AuthUser) {
    const itemCode = dto.itemCode.trim();
    const category = dto.process === 'dyeing' ? 'GREY_FABRIC' : 'DYED_FABRIC';
    const field = dto.process === 'dyeing' ? 'dyeingIssueTxnId' : 'compactingIssueTxnId';
    // Grey fabric is in stock under its batch's code, or (own-mill knitting) under the machine run's.
    let flow = await this.prisma.fabricProductionFlow.findUnique({ where: { flowNo: itemCode } });
    if (!flow && dto.process === 'dyeing') {
      const run = await this.prisma.knittingRun.findUnique({ where: { runNo: itemCode }, select: { productionFlowId: true } });
      if (run?.productionFlowId) flow = await this.prisma.fabricProductionFlow.findUnique({ where: { id: run.productionFlowId } });
    }
    if (!flow) throw new BadRequestException(`${itemCode} is not linked to a production fabric code`);
    if (dto.process === 'dyeing' && this.dyesInLots(flow)) return this.startLotsFromStock(flow, itemCode, dto, user);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${flow.id}`);
      const current = await this.requireFabricFlow(flow.id, tx);
      if (dto.process === 'dyeing' && current.knittingFinishedAt === null) throw new BadRequestException('Complete knitting before starting dyeing');
      if (dto.process === 'compacting' && current.dyeingOutputWeightKg === null) throw new BadRequestException('Complete dyeing before starting compacting');
      if (current[field]) throw new BadRequestException(`${dto.process} has already been started from warehouse stock`);
      if (dto.process === 'dyeing' ? current.dyeingDate || current.dyeingFinishedAt : current.compactingDate || current.compactingFinishedAt) {
        throw new BadRequestException(`${dto.process} has already been recorded for this batch`);
      }
      const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { id: true } });
      if (!warehouse) throw new BadRequestException('Choose an active warehouse');
      const latest = await tx.stockTransaction.findFirst({ where: { itemCode, warehouseId: dto.warehouseId, category, unit: 'KG', lotNo: null }, orderBy: { createdAt: 'desc' }, select: { itemName: true } });
      if (!latest) throw new BadRequestException(`${itemCode} is not available as ${category.toLowerCase().replace('_', ' ')}`);
      const available = await this.inventory.availableWithin(tx, { category, itemCode, warehouseId: dto.warehouseId, lotNo: null });
      const quantityKg = Math.round((dto.quantityKg ?? available) * 1000) / 1000;
      if (!(quantityKg > 0.0005)) throw new BadRequestException(`No ${itemCode} is left in that warehouse`);
      const issue = await this.inventory.issueWithin(tx, {
        category,
        itemCode,
        warehouseId: dto.warehouseId,
        txnType: dto.process === 'dyeing' ? 'DYEING_ISSUE' : 'PRODUCTION_ISSUE',
        itemName: latest.itemName,
        quantityOut: quantityKg,
        unit: 'KG',
        referenceType: 'PRODUCTION_BATCH',
        referenceId: flow.id,
        createdById: user.id,
        notes: `${itemCode} started ${dto.process}`,
      });
      // With the mill given, the process starts there now and the fabric leaves the warehouse with its challan.
      const mill = dto.millDetails?.trim() || dto.partyDetails?.trim();
      const startedAt = dto.startDate ? new Date(dto.startDate) : new Date();
      const started = mill
        ? dto.process === 'dyeing'
          ? { dyeingDate: startedAt, dyeingPartyDetails: dto.partyDetails?.trim() || mill, dyeingMillDetails: mill, color: dto.color?.trim() || current.color, dyeingNotes: dto.notes?.trim() || null }
          : { compactingDate: startedAt, compactingPartyDetails: dto.partyDetails?.trim() || mill, compactingMillDetails: mill, compactingInwardNo: dto.inwardNo?.trim() || null, compactingNotes: dto.notes?.trim() || null }
        : {};
      if (mill) {
        const store = await issueWarehouseName(tx, issue.id);
        await issueChallan(tx, {
          flowId: flow.id,
          handOff: dto.process === 'dyeing' ? 'DYEING_IN' : 'COMPACTING_IN',
          date: startedAt,
          material: dto.process === 'dyeing' ? 'Grey fabric' : 'Dyed fabric',
          from: { kind: 'WAREHOUSE', name: store ?? 'Warehouse' },
          to: { kind: 'PROCESS', name: mill },
          weightKg: quantityKg,
          packages: dto.process === 'dyeing' ? current.knittingBagCount : current.rollCount,
          packageUnit: 'rolls',
          notes: dto.notes?.trim() || null,
          createdById: user.id,
        });
      }
      return tx.fabricProductionFlow.update({
        where: { id: flow.id },
        data: dto.process === 'dyeing'
          ? { dyeingIssueTxnId: issue.id, dyeingDeliveryKg: quantityKg, fabricReceivedKg: quantityKg, ...started }
          : { compactingIssueTxnId: issue.id, compactingDeliveryKg: quantityKg, compactingReceivedKg: quantityKg, ...started },
        include: flowInclude,
      });
    });
    return this.fabricFlowView(updated);
  }

  /** Grey fabric of a knitting batch taken from a warehouse into dyeing lots, one per colour; answers the first lot. */
  private async startLotsFromStock(flow: FabricProductionFlow, itemCode: string, dto: StartStockProcessDto, user: AuthUser) {
    const mill = dto.millDetails?.trim() || dto.partyDetails?.trim();
    if (!mill) throw new BadRequestException('Choose the dyeing mill');
    const first = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${flow.id}`);
      const current = await this.requireFabricFlow(flow.id, tx);
      if (current.knittingFinishedAt === null) throw new BadRequestException('Complete knitting before starting dyeing');
      const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { id: true } });
      if (!warehouse) throw new BadRequestException('Choose an active warehouse');
      const position = { category: 'GREY_FABRIC' as const, itemCode, warehouseId: dto.warehouseId, lotNo: null };
      const latest = await tx.stockTransaction.findFirst({ where: { ...position, unit: 'KG' }, orderBy: { createdAt: 'desc' }, select: { itemName: true } });
      if (!latest) throw new BadRequestException(`${itemCode} is not available as grey fabric`);
      const available = Math.round((dto.quantityKg ?? (await this.inventory.availableWithin(tx, position))) * 1000) / 1000;
      if (!(available > 0.0005)) throw new BadRequestException(`No ${itemCode} is left in that warehouse`);
      const lots = await this.createDyeingLots(
        tx,
        current,
        dto.lots ?? [{ color: dto.color }],
        available,
        { date: dto.startDate ? new Date(dto.startDate) : new Date(), party: dto.partyDetails?.trim() || mill, mill, notes: dto.notes?.trim() || null },
        async (kg, lot) => {
          const issue = await this.inventory.issueWithin(tx, {
            ...position,
            lotNo: undefined,
            txnType: 'DYEING_ISSUE',
            itemName: latest.itemName,
            quantityOut: kg,
            unit: 'KG',
            referenceType: 'PRODUCTION_BATCH',
            referenceId: lot.id,
            createdById: user.id,
            notes: `${itemCode} to dyeing as ${lot.flowNo}`,
          });
          return { txnId: issue.id, store: await issueWarehouseName(tx, issue.id) };
        },
        user,
      );
      return tx.fabricProductionFlow.findUniqueOrThrow({ where: { id: lots[0].id }, include: flowInclude });
    });
    return this.fabricFlowView(first);
  }

  /** Corrects dates, party, mill, construction and yarn price while knitting; the yarn taken stays as it is. */
  async updateKnitting(id: string, dto: KnittingDetailsDto) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      this.assertKnittingOpen(await this.requireFabricFlow(id, tx));
      await this.assertProcessNotReceived(id, 'KNITTING', tx);
      return tx.fabricProductionFlow.update({ where: { id }, data: this.knittingDetails(dto), include: flowInclude });
    });
    return this.fabricFlowView(updated);
  }

  /** Knitting done: the rolls and total weight go on to dyeing. Can be corrected until dyeing receives it. */
  async finishKnitting(id: string, dto: FinishKnittingDto, user?: AuthUser) {
    const warehouse = await this.requireDestinationWarehouse(dto.destination, dto.warehouseId);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const flow = await this.requireFabricFlow(id, tx);
      this.assertKnittingOpen(flow);
      await this.assertProcessNotReceived(id, 'KNITTING', tx);
      if (user?.role === Role.MANAGER && flow.knittingMillType !== 'OWN') {
        throw new ForbiddenException('Other-mill knitting is recorded manually by an administrator');
      }
      // The yarn given to knitting; what it used is entered now and the rest goes back into stock.
      let yarnUsed = Number(flow.yarnReceivedKg ?? flow.purchasedWeightKg);
      if (dto.yarnUsedKg !== undefined) {
        if (!flow.yarnIssueTxnId) throw new BadRequestException(`${flow.flowNo} did not take its yarn from stock, so its yarn used can't change`);
        yarnUsed = await settleYarnUsed(tx, this.inventory, flow, dto.yarnUsedKg, user?.id);
      }
      this.assertWeight('Knitted total weight', dto.totalWeightKg, yarnUsed);
      const toParty = dto.destination === ProcessDeliveryDestination.PARTY;
      if (toParty && !user) throw new ForbiddenException('Sign in to deliver fabric to a party');
      // An earlier delivery to a party is taken back; it is made again below if the fabric still goes to one.
      if (flow.knittingDestination === ProcessDeliveryDestination.PARTY) await this.undoProcessSale(tx, id, user);
      await tx.fabricProductionFlow.update({
        where: { id },
        data: {
          status: 'KNITTING',
          knittingFinishedAt: new Date(dto.finishedDate),
          ...(dto.yarnUsedKg !== undefined ? { purchasedWeightKg: yarnUsed } : {}),
          ...(dto.yarnRatePerKg !== undefined && user?.role !== Role.MANAGER ? { yarnRatePerKg: dto.yarnRatePerKg } : {}),
          // The grey fabric's rolls (the column keeps its old name).
          knittingBagCount: dto.rollCount,
          knittingDeliveryKg: dto.totalWeightKg,
          // Warehouse delivery ends knitting only. Dyeing opens later when this stock is selected from Start.
          dyeingDeliveryKg: dto.destination === ProcessDeliveryDestination.NEXT_PROCESS ? dto.totalWeightKg : null,
          knittingDeliveryPlace: warehouse ? `${warehouse.code} · ${warehouse.name}` : toParty ? dto.partyName!.trim() : dto.deliveryPlace.trim(),
          knittingDestination: dto.destination,
          knittingDestinationWarehouseId: warehouse?.id ?? null,
          dyeingPartyDetails: dto.nextPartyDetails?.trim() || null,
          dyeingMillDetails: dto.nextMillDetails?.trim() || null,
          // Managers record physical completion only; financial values remain admin-controlled.
          knittingExpense: user?.role === Role.MANAGER ? flow.knittingExpense : dto.knittingExpense,
          knittingNotes: dto.notes?.trim() || null,
        },
      });
      await this.syncWarehouseHandOff(tx, flow.id, 'KNITTING', warehouse, { deliveredAt: new Date(dto.finishedDate), weightKg: dto.totalWeightKg, notes: dto.notes?.trim() || null, createdById: user?.id });
      // The grey fabric leaves the knitting mill with a delivery challan: to dyeing or a warehouse, or (to a party) the
      // delivery's own challan.
      if (toParty) {
        await cancelChallan(tx, flow.id, 'KNITTING', 'Delivered to a party');
        const current = await tx.fabricProductionFlow.findUniqueOrThrow({ where: { id } });
        await this.deliverWithin(
          tx,
          current,
          { deliveredDate: dto.finishedDate, destination: FabricDeliveryDestination.CUSTOMER, partyName: dto.partyName, weightKg: dto.totalWeightKg, amount: dto.amount, expense: dto.deliveryExpense, notes: dto.notes },
          user!,
          { availableKg: dto.totalWeightKg, material: 'Grey fabric', from: knitter(flow), packages: dto.rollCount, packageUnit: 'rolls' },
        );
      } else {
        // The grey fabric leaves the knitting mill with a delivery challan, to dyeing or a warehouse.
        await issueChallan(tx, {
          flowId: flow.id,
          handOff: 'KNITTING',
          date: new Date(dto.finishedDate),
          material: 'Grey fabric',
          from: { kind: 'PROCESS', name: knitter(flow) },
          to: warehouse ? { kind: 'WAREHOUSE', name: `${warehouse.code} · ${warehouse.name}` } : { kind: 'PROCESS', name: dto.nextMillDetails?.trim() || dto.nextPartyDetails?.trim() || 'Dyeing mill' },
          weightKg: dto.totalWeightKg,
          packages: dto.rollCount,
          packageUnit: 'rolls',
          createdById: user?.id,
        });
      }
      // The first completion is news; later corrections of it are not.
      if (!flow.knittingFinishedAt) {
        await notifyProcessDone(tx, {
          process: 'Knitting',
          flowNo: flow.flowNo,
          input: yarnUsed,
          output: dto.totalWeightKg,
          outputLabel: 'grey fabric',
          details: [`${dto.rollCount} roll${dto.rollCount === 1 ? '' : 's'}`, flow.fabricType, flow.knittingMillDetails && `knitted at ${flow.knittingMillDetails}`],
          next: warehouse ? `sent to warehouse ${warehouse.code}` : toParty ? `delivered to ${dto.partyName?.trim()}` : `sent to dyeing at ${dto.nextPartyDetails?.trim() || 'the dyeing mill'}`,
        });
      }
      // Read back after the hand-off, so the answer shows where the fabric went.
      return tx.fabricProductionFlow.findUniqueOrThrow({ where: { id }, include: flowInclude });
    });
    return this.fabricFlowView(updated, user);
  }

  // ─── Attachments ────────────────────────────────────────────────────────

  async addAttachment(id: string, stage: string, file: Express.Multer.File | undefined, user: AuthUser) {
    if (!(ATTACHMENT_STAGES as readonly string[]).includes(stage)) throw new BadRequestException(`Stage must be one of ${ATTACHMENT_STAGES.join(', ')}`);
    await this.requireFabricFlow(id);
    const stored = await this.storage.upload(file);
    return this.prisma.fabricFlowAttachment.create({
      data: {
        flowId: id,
        stage,
        objectKey: stored.objectKey,
        fileName: file!.originalname.slice(-200),
        mimeType: file!.mimetype,
        sizeBytes: file!.size,
        uploadedById: user.id,
      },
      select: attachmentSelect,
    });
  }

  private async requireAttachment(id: string, attachmentId: string) {
    const attachment = await this.prisma.fabricFlowAttachment.findFirst({ where: { id: attachmentId, flowId: id } });
    if (!attachment) throw new NotFoundException('Attachment not found');
    return attachment;
  }

  async attachmentFile(id: string, attachmentId: string) {
    const attachment = await this.requireAttachment(id, attachmentId);
    return { attachment, body: await this.storage.download(attachment.objectKey) };
  }

  async deleteAttachment(id: string, attachmentId: string) {
    const attachment = await this.requireAttachment(id, attachmentId);
    await this.prisma.fabricFlowAttachment.delete({ where: { id: attachment.id } });
    await this.storage.remove(attachment.objectKey);
    return { deleted: true };
  }

  /** A completion date can't be before the process started. */
  private finishDate(label: string, startDate: string, finishedDate?: string) {
    const finished = new Date(finishedDate ?? startDate);
    if (finished < new Date(startDate)) throw new BadRequestException(`${label} can't be completed before it started`);
    return finished;
  }

  /** Dyeing started: the grey fabric is at the dyeing party and mill. Can be corrected until dyeing is completed. */
  async startDyeing(id: string, dto: StartDyeingDto, user?: AuthUser) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const flow = await this.requireFabricFlow(id, tx);
      if (flow.dyeingDeliveryKg === null) throw new BadRequestException('Complete knitting and send the grey fabric to dyeing first');
      if (flow.dyeingFinishedAt) throw new BadRequestException(`Dyeing of ${flow.flowNo} is already completed`);
      if (this.dyesInLots(flow)) {
        const lotsKg = await tx.fabricProductionFlow.aggregate({ where: { parentId: id }, _sum: { purchasedWeightKg: true } });
        const left = Math.round((Number(flow.dyeingDeliveryKg) - Number(lotsKg._sum.purchasedWeightKg ?? 0)) * 1000) / 1000;
        if (left < 0.001) throw new BadRequestException(`All of ${flow.flowNo} grey fabric is already in dyeing lots`);
        await this.createDyeingLots(
          tx,
          flow,
          dto.lots ?? [{ color: dto.color, kg: dto.fabricReceivedKg }],
          left,
          { date: new Date(dto.startDate), party: dto.partyDetails.trim(), mill: dto.millDetails.trim() || dto.partyDetails.trim(), notes: dto.notes?.trim() || null },
          // Grey fabric in stock for it: a dyeing balance back under the batch's code, or own machines' runs.
          (kg, lot) => this.takeRunFabric(tx, flow, kg, lot, user),
          user,
        );
        return tx.fabricProductionFlow.findUniqueOrThrow({ where: { id }, include: flowInclude });
      }
      if (dto.fabricReceivedKg === undefined) throw new BadRequestException('Enter the fabric received at dyeing');
      this.assertWeight('Fabric received at dyeing', dto.fabricReceivedKg, Number(flow.dyeingDeliveryKg));
      // Knitting's own challan already took the fabric straight to dyeing; from a warehouse or the own mill it needs one now.
      if (!(flow.knittingDestination === ProcessDeliveryDestination.NEXT_PROCESS && (await hasChallan(tx, id, 'KNITTING')))) {
        const store = await issueWarehouseName(tx, flow.dyeingIssueTxnId);
        await issueChallan(tx, {
          flowId: id,
          handOff: 'DYEING_IN',
          date: new Date(dto.startDate),
          material: 'Grey fabric',
          from: store ? { kind: 'WAREHOUSE', name: store } : { kind: 'PROCESS', name: knitter(flow) },
          to: { kind: 'PROCESS', name: dto.millDetails.trim() || dto.partyDetails.trim() },
          weightKg: Number(flow.dyeingDeliveryKg),
          packages: flow.knittingBagCount,
          packageUnit: 'rolls',
          createdById: user?.id,
        });
      }
      return tx.fabricProductionFlow.update({
        where: { id },
        data: {
          dyeingDate: new Date(dto.startDate),
          dyeingPartyDetails: dto.partyDetails.trim(),
          dyeingMillDetails: dto.millDetails.trim(),
          fabricReceivedKg: dto.fabricReceivedKg,
          color: dto.color?.trim() || flow.color,
          dyeingNotes: dto.notes?.trim() || null,
        },
        include: flowInclude,
      });
    });
    return this.fabricFlowView(updated);
  }

  /** Compacting started: the dyed fabric is at the compacting party and mill. Can be corrected until compacting is completed. */
  async startCompacting(id: string, dto: StartCompactingDto, user?: AuthUser) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const flow = await this.requireFabricFlow(id, tx);
      if (flow.compactingDeliveryKg === null) throw new BadRequestException('Complete dyeing and send the dyed fabric to compacting first');
      if (flow.compactingFinishedAt) throw new BadRequestException(`Compacting of ${flow.flowNo} is already completed`);
      this.assertWeight('Weight received at compacting', dto.receivedKg, Number(flow.compactingDeliveryKg));
      // Dyeing's challan already took it straight to compacting; from a warehouse it needs one now.
      if (!(flow.dyeingDestination === ProcessDeliveryDestination.NEXT_PROCESS && (await hasChallan(tx, id, 'DYEING')))) {
        const store = await issueWarehouseName(tx, flow.compactingIssueTxnId);
        await issueChallan(tx, {
          flowId: id,
          handOff: 'COMPACTING_IN',
          date: new Date(dto.startDate),
          material: 'Dyed fabric',
          from: store ? { kind: 'WAREHOUSE', name: store } : { kind: 'PROCESS', name: flow.dyeingMillDetails || flow.dyeingPartyDetails || 'Dyeing mill' },
          to: { kind: 'PROCESS', name: dto.millDetails.trim() || dto.partyDetails.trim() },
          weightKg: Number(flow.compactingDeliveryKg),
          packages: flow.rollCount,
          packageUnit: 'rolls',
          createdById: user?.id,
        });
      }
      return tx.fabricProductionFlow.update({
        where: { id },
        data: {
          compactingDate: new Date(dto.startDate),
          compactingPartyDetails: dto.partyDetails.trim(),
          compactingMillDetails: dto.millDetails.trim(),
          compactingInwardNo: dto.inwardNo?.trim() || null,
          compactingReceivedKg: dto.receivedKg,
          compactingNotes: dto.notes?.trim() || null,
        },
        include: flowInclude,
      });
    });
    return this.fabricFlowView(updated);
  }

  /** Completes dyeing (or corrects it until a warehouse receives its output): the dyed fabric goes on to compacting or a warehouse. */
  async updateFabricDyeing(id: string, dto: UpdateFabricDyeingDto, user?: AuthUser) {
    const warehouse = await this.requireDestinationWarehouse(dto.destination, dto.warehouseId);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const flow = await this.requireFabricFlow(id, tx);
      await this.assertProcessNotReceived(id, 'DYEING', tx);
      if (flow.dyeingDeliveryKg === null) throw new BadRequestException('Complete the knitting stage before dyeing');
      if (flow.compactingDate || flow.compactingFinishedAt || flow.officeDeliveryKg !== null) {
        throw new BadRequestException('Compacting has already started; dyeing can no longer be changed');
      }
      const finishedAt = this.finishDate('Dyeing', dto.dyeingDate, dto.finishedDate);
      const delivered = Number(flow.dyeingDeliveryKg);
      this.assertWeight('Fabric received at dyeing', dto.fabricReceivedKg, delivered);
      this.assertWeight('Dyed fabric output', dto.dyeingOutputWeightKg, dto.fabricReceivedKg);
      // All of the dyed fabric goes on unless a different weight is given.
      const sentOn = dto.compactingDeliveryKg ?? dto.dyeingOutputWeightKg;
      this.assertWeight('Delivery to compacting', sentOn, dto.dyeingOutputWeightKg);
      // Grey fabric dyeing didn't use goes back into a warehouse: a lot's under its knitting batch's code (it can be dyed
      // in another colour from there), and the lot keeps only what it used.
      const balanceKg = Math.round((dto.balanceKg ?? 0) * 1000) / 1000;
      if (balanceKg > 0.0005 && dto.fabricReceivedKg + balanceKg > delivered + 0.0005) {
        throw new BadRequestException(`Grey fabric used (${dto.fabricReceivedKg.toFixed(3)}) and its balance (${balanceKg.toFixed(3)}) are more than the ${delivered.toFixed(3)} KG sent to dyeing`);
      }
      const parent = flow.parentId ? await tx.fabricProductionFlow.findUnique({ where: { id: flow.parentId }, select: { id: true, flowNo: true } }) : null;
      const greyBack = await this.returnBalance(
        tx,
        flow,
        { kg: balanceKg, warehouseId: dto.balanceWarehouseId, category: 'GREY_FABRIC', itemCode: parent?.flowNo ?? flow.flowNo, earlierTxnId: flow.greyReturnTxnId },
        user,
      );
      const toParty = dto.destination === ProcessDeliveryDestination.PARTY;
      if (toParty && !user) throw new ForbiddenException('Sign in to deliver fabric to a party');
      // An earlier delivery to a party is taken back; it is made again below if the fabric still goes to one.
      if (flow.dyeingDestination === ProcessDeliveryDestination.PARTY) await this.undoProcessSale(tx, id, user);
      await tx.fabricProductionFlow.update({
        where: { id },
        data: {
          dyeingBalanceKg: balanceKg > 0.0005 ? balanceKg : null,
          greyReturnTxnId: greyBack?.id ?? null,
          // A lot's grey fabric (and its cost) is what it used; the balance is the knitting batch's again.
          ...(parent ? { purchasedWeightKg: Math.round((delivered - balanceKg) * 1000) / 1000 } : {}),
          status: 'DYEING',
          dyeingDate: new Date(dto.dyeingDate),
          dyeingFinishedAt: finishedAt,
          dyeingPartyDetails: dto.dyeingPartyDetails,
          dyeingMillDetails: dto.dyeingMillDetails,
          fabricReceivedKg: dto.fabricReceivedKg,
          dyeingGreyWeightKg: dto.dyeingGreyWeightKg ?? dto.fabricReceivedKg,
          color: dto.color.trim(),
          dyeingCount: dto.dyeingCount?.trim() || flow.dyeingCount || flow.yarnCount,
          rollCount: dto.rollCount,
          dyeingOutputWeightKg: dto.dyeingOutputWeightKg,
          dyeingExpense: dto.dyeingExpense,
          dyeingNotes: dto.dyeingNotes?.trim() || null,
          // Warehouse delivery ends dyeing only. Compacting opens when dyed stock is selected from Start.
          compactingDeliveryKg: dto.destination === ProcessDeliveryDestination.NEXT_PROCESS ? sentOn : null,
          dyeingDestination: dto.destination,
          dyeingDestinationWarehouseId: warehouse?.id ?? null,
          compactingPartyDetails: dto.nextPartyDetails?.trim() || null,
          compactingMillDetails: dto.nextMillDetails?.trim() || (warehouse ? `${warehouse.code} · ${warehouse.name}` : null),
        },
      });
      await this.syncWarehouseHandOff(tx, flow.id, 'DYEING', warehouse, { deliveredAt: finishedAt, weightKg: sentOn, notes: dto.dyeingNotes?.trim() || null });
      // The dyed fabric leaves the dyeing mill with a delivery challan: to compacting or a warehouse, or (to a party)
      // the delivery's own challan.
      if (toParty) {
        await cancelChallan(tx, flow.id, 'DYEING', 'Delivered to a party');
        const current = await tx.fabricProductionFlow.findUniqueOrThrow({ where: { id } });
        await this.deliverWithin(
          tx,
          current,
          { deliveredDate: finishedAt.toISOString(), destination: FabricDeliveryDestination.CUSTOMER, partyName: dto.partyName, weightKg: sentOn, amount: dto.amount, expense: dto.deliveryExpense, notes: dto.dyeingNotes },
          user!,
          { availableKg: sentOn, material: 'Dyed fabric', from: dto.dyeingMillDetails?.trim() || dto.dyeingPartyDetails.trim(), packages: dto.rollCount, packageUnit: 'rolls' },
        );
      } else {
        // The dyed fabric leaves the dyeing mill with a delivery challan, to compacting or a warehouse.
        await issueChallan(tx, {
          flowId: flow.id,
          handOff: 'DYEING',
          date: finishedAt,
          material: 'Dyed fabric',
          from: { kind: 'PROCESS', name: dto.dyeingMillDetails?.trim() || dto.dyeingPartyDetails.trim() },
          to: warehouse ? { kind: 'WAREHOUSE', name: `${warehouse.code} · ${warehouse.name}` } : { kind: 'PROCESS', name: dto.nextMillDetails?.trim() || dto.nextPartyDetails?.trim() || 'Compacting mill' },
          weightKg: sentOn,
          packages: dto.rollCount,
          packageUnit: 'rolls',
          createdById: user?.id,
        });
      }
      if (parent) await this.refreshKnittingBatchStatus(tx, parent.id);
      if (flow.dyeingOutputWeightKg === null) {
        await notifyProcessDone(tx, {
          process: 'Dyeing',
          flowNo: flow.flowNo,
          input: dto.fabricReceivedKg,
          output: dto.dyeingOutputWeightKg,
          outputLabel: 'dyed fabric',
          details: [dto.color, `${dto.rollCount} roll${dto.rollCount === 1 ? '' : 's'}`, `dyed at ${dto.dyeingPartyDetails}`],
          next: warehouse ? `sent to warehouse ${warehouse.code}` : toParty ? `delivered to ${dto.partyName?.trim()}` : `sent to compacting at ${dto.nextPartyDetails?.trim() || 'the compacting mill'}`,
        });
      }
      return tx.fabricProductionFlow.findUniqueOrThrow({ where: { id }, include: flowInclude });
    });
    return this.fabricFlowView(updated);
  }

  /**
   * Completes compacting (or corrects it): the compacted weight is the finished fabric. With `delivery`, all of it goes
   * on at once, to a party or a warehouse, with its delivery challan (only while nothing has been delivered yet).
   */
  async updateFabricCompacting(id: string, dto: UpdateFabricCompactingDto, user?: AuthUser) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const flow = await this.requireFabricFlow(id, tx);
      if (flow.compactingDeliveryKg === null) throw new BadRequestException('Complete the dyeing stage before compacting');
      const finishedAt = this.finishDate('Compacting', dto.compactingDate, dto.finishedDate);
      const delivered = Number(flow.compactingDeliveryKg);
      this.assertWeight('Weight received at compacting', dto.compactingReceivedKg, delivered);
      this.assertWeight('Compacted weight', dto.officeDeliveryKg, dto.compactingReceivedKg);
      // Read under the delivery lock so a concurrent delivery cannot invalidate this floor.
      const alreadyDelivered = Number(flow.finalDeliveredKg ?? 0);
      if (dto.officeDeliveryKg < alreadyDelivered - 0.0005) {
        throw new BadRequestException(`${alreadyDelivered.toFixed(3)} KG has already been delivered; the compacted weight can't be less`);
      }
      // Dyed fabric compacting didn't use goes back into a warehouse under the batch's code.
      const balanceKg = Math.round((dto.balanceKg ?? 0) * 1000) / 1000;
      if (balanceKg > 0.0005 && dto.compactingReceivedKg + balanceKg > delivered + 0.0005) {
        throw new BadRequestException(`Dyed fabric used (${dto.compactingReceivedKg.toFixed(3)}) and its balance (${balanceKg.toFixed(3)}) are more than the ${delivered.toFixed(3)} KG sent to compacting`);
      }
      const dyedBack = await this.returnBalance(
        tx,
        flow,
        { kg: balanceKg, warehouseId: dto.balanceWarehouseId, category: 'DYED_FABRIC', itemCode: flow.flowNo, earlierTxnId: flow.dyedReturnTxnId },
        user,
      );
      const saved = await tx.fabricProductionFlow.update({
        where: { id },
        data: {
          compactingBalanceKg: balanceKg > 0.0005 ? balanceKg : null,
          dyedReturnTxnId: dyedBack?.id ?? null,
          // AT_OFFICE: compacted and ready to deliver (the name is from when fabric went to an office first).
          status: alreadyDelivered >= dto.officeDeliveryKg - 0.0005 ? 'DELIVERED' : 'AT_OFFICE',
          compactingDate: new Date(dto.compactingDate),
          compactingFinishedAt: finishedAt,
          compactingPartyDetails: dto.compactingPartyDetails.trim(),
          compactingMillDetails: dto.compactingMillDetails.trim(),
          compactingInwardNo: dto.compactingInwardNo?.trim() || null,
          compactingReceivedKg: dto.compactingReceivedKg,
          compactingOutwardNo: dto.compactingOutwardNo?.trim() || null,
          officeDeliveryKg: dto.officeDeliveryKg,
          compactingExpense: dto.compactingExpense,
          compactingNotes: dto.compactingNotes?.trim() || null,
        },
        include: flowInclude,
      });
      if (flow.officeDeliveryKg === null) {
        await notifyProcessDone(tx, {
          process: 'Compacting',
          flowNo: flow.flowNo,
          input: dto.compactingReceivedKg,
          output: dto.officeDeliveryKg,
          outputLabel: 'finished fabric',
          details: [flow.color, `compacted at ${dto.compactingPartyDetails.trim()}`, dto.compactingOutwardNo?.trim() && `outward ${dto.compactingOutwardNo.trim()}`],
          next: dto.delivery ? (dto.delivery.destination === FabricDeliveryDestination.CUSTOMER ? `delivered to ${dto.delivery.partyName?.trim()}` : 'sent to a warehouse') : 'ready to deliver',
        });
      }
      if (dto.delivery && alreadyDelivered < 0.0005) {
        if (!user) throw new ForbiddenException('Sign in to deliver the fabric');
        return this.deliverWithin(
          tx,
          saved,
          { ...dto.delivery, deliveredDate: finishedAt.toISOString(), weightKg: dto.officeDeliveryKg },
          user,
          { availableKg: dto.officeDeliveryKg, material: 'Finished fabric', from: dto.compactingMillDetails.trim() || dto.compactingPartyDetails.trim(), packages: flow.rollCount, packageUnit: 'rolls' },
        );
      }
      return saved;
    });
    return this.fabricFlowView(updated);
  }

  // ─── Deliveries ─────────────────────────────────────────────────────────

  /**
   * Sends finished fabric out of the batch: to a party (typed, recording what they paid) or into a warehouse,
   * where it becomes Finished fabric stock under the batch's code. Several deliveries can share the fabric;
   * the batch is Delivered once nothing is left at the office.
   */
  async recordDelivery(id: string, dto: RecordDeliveryDto, user: AuthUser) {
    const flow = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const current = await tx.fabricProductionFlow.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Batch not found');
      if (current.officeDeliveryKg === null) throw new BadRequestException('Complete compacting first');
      return this.deliverWithin(tx, current, dto, user, {
        availableKg: Number(current.officeDeliveryKg),
        material: 'Finished fabric',
        from: current.compactingMillDetails || current.compactingPartyDetails || 'Compacting mill',
        packageUnit: 'rolls',
      });
    });
    return this.fabricFlowView(flow);
  }

  /**
   * Sends a batch's fabric out, to a party (what they paid) or into a warehouse (stock once received there), with its
   * delivery challan, and adds it to the batch's delivered totals; the batch is Delivered once nothing is left. Used by
   * compacting's completion and later deliveries, and by knitting or dyeing delivering straight to a party.
   */
  private async deliverWithin(
    tx: Prisma.TransactionClient,
    current: FabricProductionFlow,
    dto: RecordDeliveryDto,
    user: AuthUser,
    source: { availableKg: number; material: 'Grey fabric' | 'Dyed fabric' | 'Finished fabric'; from: string; packages?: number | null; packageUnit?: 'bags' | 'rolls' },
  ) {
    const id = current.id;
    const delivered = Number(current.finalDeliveredKg ?? 0);
    const remaining = source.availableKg - delivered;
    if (dto.weightKg > remaining + 0.0005) {
      throw new BadRequestException(`Only ${Math.max(remaining, 0).toFixed(3)} KG of ${current.flowNo} is left to deliver`);
    }
    const toParty = dto.destination === FabricDeliveryDestination.CUSTOMER;
    let target: string;
    let destinationName: string;
    if (toParty) {
      const party = dto.partyName?.trim();
      if (!party) throw new BadRequestException('Enter who the fabric went to');
      target = party;
      destinationName = party;
    } else {
      // The fabric is on its way: it becomes stock when the warehouse receives it (receiveFabric).
      const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { code: true, name: true } });
      if (!warehouse) throw new BadRequestException('Choose an active warehouse');
      target = warehouse.code;
      destinationName = `${warehouse.code} · ${warehouse.name}`;
      await notifyRoles(
        tx,
        GODOWN_ROLES,
        {
          title: `Fabric coming to ${warehouse.code}`,
          message: `${current.flowNo} · ${dto.weightKg.toFixed(3)} KG ${fabricName(current)} from production. Receive it on the Warehouses page when it arrives.`,
          type: 'DELIVERY_DUE',
          referenceType: 'FabricProductionFlow',
          referenceId: current.id,
        },
        user.id,
      );
    }
    const amount = toParty ? (dto.amount ?? 0) : 0;
    const expense = dto.expense ?? 0;
    const deliveredAt = new Date(dto.deliveredDate);
    const delivery = await tx.fabricFlowDelivery.create({
      data: {
        flowId: id,
        deliveredAt,
        destination: dto.destination,
        partyName: toParty ? target : null,
        warehouseId: toParty ? null : dto.warehouseId,
        weightKg: dto.weightKg,
        amount,
        expense,
        notes: dto.notes?.trim() || null,
        createdById: user.id,
      },
    });
    // Each delivery goes with its own delivery challan.
    await issueChallan(tx, {
      flowId: id,
      handOff: `DELIVERY:${delivery.id}`,
      date: deliveredAt,
      material: source.material,
      from: { kind: 'PROCESS', name: source.from },
      to: { kind: toParty ? 'PARTY' : 'WAREHOUSE', name: destinationName },
      weightKg: dto.weightKg,
      // The rolls / bags going, as typed, else the process's own count.
      packages: dto.packages ?? source.packages ?? null,
      packageUnit: source.packageUnit ?? 'rolls',
      notes: dto.notes?.trim() || null,
      createdById: user.id,
    });
    const nowDelivered = delivered + dto.weightKg;
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: 'FABRIC_DELIVERED',
        module: 'production',
        entity: 'FabricProductionFlow',
        entityId: id,
        newValue: { flowNo: current.flowNo, material: source.material, to: toParty ? 'PARTY' : 'WAREHOUSE', target, weightKg: dto.weightKg, amount },
      },
    });
    return tx.fabricProductionFlow.update({
      where: { id },
      data: {
        finalDeliveredKg: nowDelivered,
        collectedAmount: { increment: amount },
        otherExpense: { increment: expense },
        finalDate: current.finalDate && current.finalDate > deliveredAt ? current.finalDate : deliveredAt,
        status: nowDelivered >= source.availableKg - 0.0005 ? 'DELIVERED' : current.status,
      },
      include: flowInclude,
    });
  }

  /**
   * Puts the fabric a process didn't use back into a warehouse, like knitting's unused yarn: grey fabric dyeing didn't
   * use, or dyed fabric compacting didn't use. A correction replaces the earlier return (refused once that fabric has
   * been issued again); 0 only takes it back. Answers the new movement, if any.
   */
  private async returnBalance(
    tx: Prisma.TransactionClient,
    flow: FabricProductionFlow,
    balance: { kg: number; warehouseId?: string; category: 'GREY_FABRIC' | 'DYED_FABRIC'; itemCode: string; earlierTxnId: string | null },
    user?: AuthUser,
  ) {
    if (balance.earlierTxnId) await this.inventory.removeInWithin(tx, balance.earlierTxnId, user?.id ?? null);
    if (!(balance.kg > 0.0005)) return null;
    const warehouse = await tx.warehouse.findFirst({ where: { id: balance.warehouseId, active: true }, select: { id: true } });
    if (!warehouse) throw new BadRequestException('Choose an active warehouse for the balance');
    return this.inventory.createTxn(
      {
        category: balance.category,
        txnType: 'RETURN_IN',
        itemCode: balance.itemCode,
        itemName: `${fabricName(flow)}${balance.category === 'GREY_FABRIC' ? ' grey' : ' dyed'}`,
        warehouseId: warehouse.id,
        quantityIn: Math.round(balance.kg * 1000) / 1000,
        unit: 'KG',
        referenceType: 'PRODUCTION_BATCH',
        referenceId: flow.id,
        createdById: user?.id,
        notes: `${flow.flowNo} ${balance.category === 'GREY_FABRIC' ? 'grey fabric dyeing' : 'dyed fabric compacting'} did not use`,
      },
      tx,
    );
  }

  /** A knitting batch is at dyeing while grey fabric is left that isn't in a lot, done once all of it is. */
  private async refreshKnittingBatchStatus(tx: Prisma.TransactionClient, parentId: string) {
    const parent = await tx.fabricProductionFlow.findUniqueOrThrow({ where: { id: parentId }, select: { knittingDeliveryKg: true, dyeingDeliveryKg: true } });
    const lotsKg = await tx.fabricProductionFlow.aggregate({ where: { parentId }, _sum: { purchasedWeightKg: true } });
    const left = Number(parent.knittingDeliveryKg ?? parent.dyeingDeliveryKg ?? 0) - Number(lotsKg._sum.purchasedWeightKg ?? 0);
    await tx.fabricProductionFlow.update({ where: { id: parentId }, data: { status: left > 0.0005 ? 'DYEING' : 'DELIVERED' } });
  }

  /**
   * Takes back a knitting or dyeing delivery to a party when that process is corrected (its fabric then goes on to
   * the next process or a warehouse instead): the deliveries, their challans and their totals.
   */
  private async undoProcessSale(tx: Prisma.TransactionClient, flowId: string, user?: AuthUser) {
    const sales = await tx.fabricFlowDelivery.findMany({ where: { flowId, processStage: 'FINAL' } });
    if (!sales.length) return;
    for (const d of sales) {
      if (d.stockTxnId) await this.inventory.removeInWithin(tx, d.stockTxnId, user?.id ?? null);
      await tx.fabricFlowDelivery.delete({ where: { id: d.id } });
      await cancelChallan(tx, flowId, `DELIVERY:${d.id}`, 'The process now sends its fabric elsewhere');
    }
    await tx.fabricProductionFlow.update({
      where: { id: flowId },
      data: {
        finalDeliveredKg: null,
        finalDate: null,
        collectedAmount: { decrement: sales.reduce((t, d) => t + Number(d.amount), 0) },
        otherExpense: { decrement: sales.reduce((t, d) => t + Number(d.expense), 0) },
      },
    });
  }

  /** Fabric sent from production that a warehouse has not received yet, oldest first. */
  /**
   * Fabric sent to a warehouse and not yet received there, with what the warehouse checks it against: the fabric
   * (type, dia, GSM, colour, yarn), the weight sent and the rolls / bags on its delivery challan.
   */
  async incomingFabric(warehouseId: string) {
    const deliveries = await this.prisma.fabricFlowDelivery.findMany({
      where: { warehouseId, destination: FabricDeliveryDestination.WAREHOUSE, receivedAt: null },
      include: {
        flow: {
          select: { id: true, flowNo: true, yarnCount: true, yarnItemCode: true, color: true, fabricType: true, fabricDiameter: true, fabricGsm: true, knittingGg: true, knittingLl: true, knittingMillDetails: true, dyeingMillDetails: true, compactingMillDetails: true },
        },
      },
      orderBy: { deliveredAt: 'asc' },
    });
    const challans = deliveries.length
      ? await this.prisma.processChallan.findMany({
          where: { flowId: { in: [...new Set(deliveries.map((d) => d.flowId))] }, cancelledAt: null },
          select: { flowId: true, handOff: true, challanNo: true, packages: true, packageUnit: true, fromName: true },
        })
      : [];
    return deliveries.map((d) => {
      // The challan that took this fabric to the warehouse: knitting's or dyeing's own, or the delivery's.
      const handOff = d.processStage === 'FINAL' ? `DELIVERY:${d.id}` : d.processStage;
      const challan = challans.find((c) => c.flowId === d.flowId && c.handOff === handOff);
      return {
        ...d,
        challanNo: challan?.challanNo ?? null,
        from: challan?.fromName ?? null,
        sentPackages: challan?.packages ?? null,
        packageUnit: challan?.packageUnit ?? 'rolls',
      };
    });
  }

  /**
   * The warehouse confirms fabric sent from production: it becomes Finished fabric stock under the batch code,
   * at the weight the warehouse found (within the usual process tolerance of what was sent).
   */
  async receiveFabric(deliveryId: string, dto: ReceiveFabricDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.fabricFlowDelivery.findUnique({ where: { id: deliveryId }, select: { flowId: true } });
      if (!found) throw new NotFoundException('Delivery not found');
      await lockKeys(tx, `production-batch:${found.flowId}`);
      const delivery = await tx.fabricFlowDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
        include: { flow: true, warehouse: { select: { code: true, active: true } } },
      });
      if (delivery.destination !== FabricDeliveryDestination.WAREHOUSE || !delivery.warehouseId) {
        throw new BadRequestException('Only fabric sent to a warehouse is received there');
      }
      if (delivery.receivedAt) throw new BadRequestException(`${delivery.flow.flowNo} has already been received`);
      this.assertWeight('Weight received', dto.receivedWeightKg, Number(delivery.weightKg));

      const receivedAt = new Date(dto.receivedDate);
      const category = delivery.processStage === 'KNITTING' ? 'GREY_FABRIC' : delivery.processStage === 'DYEING' ? 'DYED_FABRIC' : 'FINISHED_FABRIC';
      const remark = dto.notes?.trim() || null;
      const weightCheck = checkText(Number(delivery.weightKg), dto.receivedWeightKg, 'KG');
      const txn = await this.inventory.createTxn(
        {
          category,
          txnType: delivery.processStage === 'KNITTING' ? 'GREY_FABRIC_IN' : delivery.processStage === 'DYEING' ? 'DYEING_OUTPUT' : 'PRODUCTION_IN',
          itemCode: delivery.flow.flowNo,
          itemName: fabricName(delivery.flow),
          warehouseId: delivery.warehouseId,
          quantityIn: dto.receivedWeightKg,
          unit: 'KG',
          referenceType: 'PRODUCTION_BATCH',
          referenceId: delivery.flowId,
          createdById: user.id,
          notes: [
            `${delivery.flow.flowNo} ${category.toLowerCase().replace('_', ' ')} from production (sent ${Number(delivery.weightKg).toFixed(3)} KG${weightCheck && weightCheck !== 'Matches' ? `, ${weightCheck.toLowerCase()}` : ''})`,
            dto.receivedPackages !== undefined && `${dto.receivedPackages} rolls counted`,
            remark,
          ]
            .filter(Boolean)
            .join(' · '),
          createdAt: receivedAt,
        },
        tx,
      );
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'FABRIC_RECEIVED',
          module: 'production',
          entity: 'FabricProductionFlow',
          entityId: delivery.flowId,
          newValue: { flowNo: delivery.flow.flowNo, warehouse: delivery.warehouse?.code, sentKg: Number(delivery.weightKg), receivedKg: dto.receivedWeightKg, packages: dto.receivedPackages ?? null, notes: remark },
        },
      });
      return tx.fabricFlowDelivery.update({
        where: { id: deliveryId },
        data: { receivedAt, receivedWeightKg: dto.receivedWeightKg, receivedPackages: dto.receivedPackages ?? null, receivedNotes: remark, receivedById: user.id, stockTxnId: txn.id },
        include: { flow: { select: { flowNo: true } }, warehouse: { select: { code: true } } },
      });
    });
  }

  /** Undoes a delivery; fabric put into a warehouse comes back out, unless it has already been issued from there. */
  async deleteDelivery(id: string, deliveryId: string, user: AuthUser) {
    const flow = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const delivery = await tx.fabricFlowDelivery.findFirst({ where: { id: deliveryId, flowId: id } });
      if (!delivery) throw new NotFoundException('Delivery not found');
      if (delivery.processStage !== 'FINAL') throw new BadRequestException('Process hand-offs must be corrected in their knitting or dyeing stage');
      const current = await tx.fabricProductionFlow.findUniqueOrThrow({ where: { id } });
      if (delivery.stockTxnId) await this.inventory.removeInWithin(tx, delivery.stockTxnId, user.id);
      await tx.fabricFlowDelivery.delete({ where: { id: deliveryId } });
      await cancelChallan(tx, id, `DELIVERY:${deliveryId}`, 'Delivery undone');
      const latest = await tx.fabricFlowDelivery.findFirst({ where: { flowId: id, processStage: 'FINAL' }, orderBy: { deliveredAt: 'desc' }, select: { deliveredAt: true } });
      const stillDelivered = Math.max(0, Number(current.finalDeliveredKg ?? 0) - Number(delivery.weightKg));
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'FABRIC_DELIVERY_UNDONE',
          module: 'production',
          entity: 'FabricProductionFlow',
          entityId: id,
          previousValue: { flowNo: current.flowNo, to: delivery.destination, weightKg: Number(delivery.weightKg), amount: Number(delivery.amount) },
        },
      });
      return tx.fabricProductionFlow.update({
        where: { id },
        data: {
          finalDeliveredKg: stillDelivered > 0.0005 ? stillDelivered : null,
          collectedAmount: { decrement: delivery.amount },
          otherExpense: { decrement: delivery.expense },
          finalDate: latest?.deliveredAt ?? null,
          status: current.status === 'DELIVERED' ? 'AT_OFFICE' : current.status,
        },
        include: flowInclude,
      });
    });
    return this.fabricFlowView(flow);
  }
}
