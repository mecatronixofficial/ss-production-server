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
import { StorageService } from '../storage/storage.service';
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
const flowInclude = {
  expenses: { orderBy: { expenseDate: 'asc' as const } },
  knittingRuns: { select: { id: true, status: true, yarnKg: true, outputKg: true, machine: { select: { code: true, name: true } } }, orderBy: { createdAt: 'asc' as const } },
  attachments: { select: attachmentSelect, orderBy: { createdAt: 'asc' as const } },
  yarnWarehouse: { select: { code: true, name: true } },
  deliveries: {
    include: { warehouse: { select: { code: true, name: true } } },
    orderBy: { deliveredAt: 'asc' as const },
  },
};

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

  async fabricFlows(user?: AuthUser) {
    const flows = await this.prisma.fabricProductionFlow.findMany({ include: flowInclude, orderBy: [{ status: 'asc' }, { purchaseDate: 'desc' }] });
    const data = flows
      .filter((flow) => user?.role !== Role.MANAGER || (flow.status === 'KNITTING' && flow.knittingMillType === 'OWN'))
      .map((flow) => this.fabricFlowView(flow, user));
    const summary = data.reduce(
      (totals, flow) => ({
        activeBatches: totals.activeBatches + (flow.status === 'DELIVERED' ? 0 : 1),
        purchasedKg: totals.purchasedKg + flow.purchasedWeightKg,
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

  /** Every fabric made from a yarn receives a stable derivative code: YARN-D1, YARN-D2, ... */
  private async batchCodeFor(tx: Prisma.TransactionClient, itemCode: string) {
    const taken = await tx.fabricProductionFlow.findMany({
      where: { flowNo: { startsWith: `${itemCode}-D` } },
      select: { flowNo: true },
    });
    const suffixes = taken.map((f) => f.flowNo.slice(itemCode.length + 2)).filter((s) => /^\d+$/.test(s)).map(Number);
    return `${itemCode}-D${Math.max(0, ...suffixes) + 1}`;
  }

  /** Knitting details are editable until the batch reaches dyeing. */
  private assertKnittingOpen(flow: FabricProductionFlow) {
    if (flow.status !== 'KNITTING' || flow.fabricReceivedKg !== null) {
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
      yarnRatePerKg: dto.yarnRatePerKg,
    };
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
    const flow = await this.prisma.$transaction(async (tx) => {
      const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { code: true } });
      if (!warehouse) throw new BadRequestException('Choose an active warehouse');
      const position = { itemCode, warehouseId: dto.warehouseId, category: dto.yarnCategory, lotNo };
      const latest = await tx.stockTransaction.findFirst({ where: position, orderBy: { createdAt: 'desc' }, select: { itemName: true } });
      if (!latest) throw new BadRequestException(`There is no ${itemCode}${lotNo ? ` lot ${lotNo}` : ''} in ${warehouse.code}`);
      if (await tx.stockTransaction.findFirst({ where: { ...position, unit: { not: 'KG' } }, select: { id: true } })) {
        throw new BadRequestException(`${itemCode} is kept in another unit than KG; knitting takes yarn by KG`);
      }

      await lockKeys(tx, `batch-code:${itemCode}`);
      const flowNo = await this.batchCodeFor(tx, itemCode);
      const created = await tx.fabricProductionFlow.create({
        data: {
          ...this.knittingDetails(dto),
          flowNo,
          status: 'KNITTING',
          source: FabricSource.STOCK,
          knittingMillType: dto.millType,
          yarnItemCode: itemCode,
          fabricType: dto.fabricType.trim(),
          fabricDiameter: dto.fabricDiameter.trim(),
          fabricGsm: dto.fabricGsm?.trim() || null,
          yarnWarehouseId: dto.warehouseId,
          yarnLotNo: lotNo,
          yarnCount: latest.itemName,
          bagCount: 0,
          purchasedWeightKg: dto.yarnKg,
          yarnReceivedKg: dto.yarnKg,
        },
      });
      const issue = await this.inventory.issueWithin(tx, {
        ...position,
        lotNo: lotNo ?? undefined,
        txnType: 'KNITTING_ISSUE',
        itemName: latest.itemName,
        quantityOut: dto.yarnKg,
        unit: 'KG',
        referenceType: 'PRODUCTION_BATCH',
        referenceId: created.id,
        createdById: user.id,
        notes: `${flowNo} ${dto.millType === 'OWN' ? 'own-mill knitting task' : 'other-mill knitting'} · ${responsibleParty}`,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'KNITTING_STARTED',
          module: 'production',
          entity: 'FabricProductionFlow',
          entityId: created.id,
          newValue: { flowNo, millType: dto.millType, yarnItemCode: itemCode, fabricType: dto.fabricType.trim(), fabricDiameter: dto.fabricDiameter.trim(), fabricGsm: dto.fabricGsm?.trim() || null, warehouse: warehouse.code, lotNo, yarnKg: dto.yarnKg, party: responsibleParty },
        },
      });
      return tx.fabricProductionFlow.update({ where: { id: created.id }, data: { yarnIssueTxnId: issue.id }, include: flowInclude });
    });
    return this.fabricFlowView(flow);
  }

  /** Takes an existing batch's grey/dyed fabric out of a warehouse and opens its next recorded process. */
  async startStockProcess(dto: StartStockProcessDto, user: AuthUser) {
    const itemCode = dto.itemCode.trim();
    const category = dto.process === 'dyeing' ? 'GREY_FABRIC' : 'DYED_FABRIC';
    const field = dto.process === 'dyeing' ? 'dyeingIssueTxnId' : 'compactingIssueTxnId';
    const flow = await this.prisma.fabricProductionFlow.findUnique({ where: { flowNo: itemCode } });
    if (!flow) throw new BadRequestException(`${itemCode} is not linked to a production fabric code`);
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
      const issue = await this.inventory.issueWithin(tx, {
        category,
        itemCode,
        warehouseId: dto.warehouseId,
        txnType: dto.process === 'dyeing' ? 'DYEING_ISSUE' : 'PRODUCTION_ISSUE',
        itemName: latest.itemName,
        quantityOut: dto.quantityKg,
        unit: 'KG',
        referenceType: 'PRODUCTION_BATCH',
        referenceId: flow.id,
        createdById: user.id,
        notes: `${itemCode} started ${dto.process}`,
      });
      return tx.fabricProductionFlow.update({
        where: { id: flow.id },
        data: dto.process === 'dyeing'
          ? { dyeingIssueTxnId: issue.id, dyeingDeliveryKg: dto.quantityKg, fabricReceivedKg: dto.quantityKg }
          : { compactingIssueTxnId: issue.id, compactingDeliveryKg: dto.quantityKg, compactingReceivedKg: dto.quantityKg },
        include: flowInclude,
      });
    });
    return this.fabricFlowView(updated);
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

  /** Knitting done: the bags and total weight go on to dyeing. Can be corrected until dyeing receives it. */
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
      const yarnUsed = Number(flow.yarnReceivedKg ?? flow.purchasedWeightKg);
      this.assertWeight('Knitted total weight', dto.totalWeightKg, yarnUsed);
      await tx.fabricProductionFlow.update({
        where: { id },
        data: {
          knittingFinishedAt: new Date(dto.finishedDate),
          knittingBagCount: dto.bagCount,
          knittingDeliveryKg: dto.totalWeightKg,
          // Warehouse delivery ends knitting only. Dyeing opens later when this stock is selected from Start.
          dyeingDeliveryKg: dto.destination === ProcessDeliveryDestination.NEXT_PROCESS ? dto.totalWeightKg : null,
          knittingDeliveryPlace: warehouse ? `${warehouse.code} · ${warehouse.name}` : dto.deliveryPlace.trim(),
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
      // The first completion is news; later corrections of it are not.
      if (!flow.knittingFinishedAt) {
        await notifyProcessDone(tx, {
          process: 'Knitting',
          flowNo: flow.flowNo,
          input: yarnUsed,
          output: dto.totalWeightKg,
          outputLabel: 'grey fabric',
          details: [`${dto.bagCount} bag${dto.bagCount === 1 ? '' : 's'}`, flow.fabricType, flow.knittingMillDetails && `knitted at ${flow.knittingMillDetails}`],
          next: warehouse ? `sent to warehouse ${warehouse.code}` : `sent to dyeing at ${dto.nextPartyDetails?.trim() || 'the dyeing mill'}`,
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
  async startDyeing(id: string, dto: StartDyeingDto) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const flow = await this.requireFabricFlow(id, tx);
      if (flow.dyeingDeliveryKg === null) throw new BadRequestException('Complete knitting and send the grey fabric to dyeing first');
      if (flow.dyeingFinishedAt) throw new BadRequestException(`Dyeing of ${flow.flowNo} is already completed`);
      this.assertWeight('Fabric received at dyeing', dto.fabricReceivedKg, Number(flow.dyeingDeliveryKg));
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
  async startCompacting(id: string, dto: StartCompactingDto) {
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `production-batch:${id}`);
      const flow = await this.requireFabricFlow(id, tx);
      if (flow.compactingDeliveryKg === null) throw new BadRequestException('Complete dyeing and send the dyed fabric to compacting first');
      if (flow.compactingFinishedAt) throw new BadRequestException(`Compacting of ${flow.flowNo} is already completed`);
      this.assertWeight('Weight received at compacting', dto.receivedKg, Number(flow.compactingDeliveryKg));
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
  async updateFabricDyeing(id: string, dto: UpdateFabricDyeingDto) {
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
      this.assertWeight('Delivery to compacting', dto.compactingDeliveryKg, dto.dyeingOutputWeightKg);
      await tx.fabricProductionFlow.update({
        where: { id },
        data: {
          status: 'DYEING',
          dyeingDate: new Date(dto.dyeingDate),
          dyeingFinishedAt: finishedAt,
          dyeingPartyDetails: dto.dyeingPartyDetails,
          dyeingMillDetails: dto.dyeingMillDetails,
          fabricReceivedKg: dto.fabricReceivedKg,
          dyeingGreyWeightKg: dto.dyeingGreyWeightKg,
          color: dto.color,
          dyeingCount: dto.dyeingCount,
          rollCount: dto.rollCount,
          dyeingOutputWeightKg: dto.dyeingOutputWeightKg,
          dyeingExpense: dto.dyeingExpense,
          dyeingNotes: dto.dyeingNotes?.trim() || null,
          // Warehouse delivery ends dyeing only. Compacting opens when dyed stock is selected from Start.
          compactingDeliveryKg: dto.destination === ProcessDeliveryDestination.NEXT_PROCESS ? dto.compactingDeliveryKg : null,
          dyeingDestination: dto.destination,
          dyeingDestinationWarehouseId: warehouse?.id ?? null,
          compactingPartyDetails: dto.nextPartyDetails?.trim() || null,
          compactingMillDetails: dto.nextMillDetails?.trim() || (warehouse ? `${warehouse.code} · ${warehouse.name}` : null),
        },
      });
      await this.syncWarehouseHandOff(tx, flow.id, 'DYEING', warehouse, { deliveredAt: finishedAt, weightKg: dto.compactingDeliveryKg, notes: dto.dyeingNotes?.trim() || null });
      if (flow.dyeingOutputWeightKg === null) {
        await notifyProcessDone(tx, {
          process: 'Dyeing',
          flowNo: flow.flowNo,
          input: dto.fabricReceivedKg,
          output: dto.dyeingOutputWeightKg,
          outputLabel: 'dyed fabric',
          details: [dto.color, `${dto.rollCount} roll${dto.rollCount === 1 ? '' : 's'}`, `dyed at ${dto.dyeingPartyDetails}`],
          next: warehouse ? `sent to warehouse ${warehouse.code}` : `sent to compacting at ${dto.nextPartyDetails?.trim() || 'the compacting mill'}`,
        });
      }
      return tx.fabricProductionFlow.findUniqueOrThrow({ where: { id }, include: flowInclude });
    });
    return this.fabricFlowView(updated);
  }

  /** Completes compacting (or corrects it): the compacted weight is the finished fabric, ready to deliver. */
  async updateFabricCompacting(id: string, dto: UpdateFabricCompactingDto) {
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
      const saved = await tx.fabricProductionFlow.update({
        where: { id },
        data: {
          // AT_OFFICE: compacted and ready to deliver (the name is from when fabric went to an office first).
          status: alreadyDelivered >= dto.officeDeliveryKg - 0.0005 ? 'DELIVERED' : 'AT_OFFICE',
          compactingDate: new Date(dto.compactingDate),
          compactingFinishedAt: finishedAt,
          compactingPartyDetails: dto.compactingPartyDetails.trim(),
          compactingMillDetails: dto.compactingMillDetails.trim(),
          compactingInwardNo: dto.compactingInwardNo,
          compactingReceivedKg: dto.compactingReceivedKg,
          compactingOutwardNo: dto.compactingOutwardNo,
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
          details: [flow.color, `compacted at ${dto.compactingPartyDetails.trim()}`, `outward ${dto.compactingOutwardNo}`],
          next: 'ready to deliver',
        });
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
      if (current.officeDeliveryKg === null) throw new BadRequestException('Record compacting (delivery to office) first');
      const available = Number(current.officeDeliveryKg);
      const delivered = Number(current.finalDeliveredKg ?? 0);
      const remaining = available - delivered;
      if (dto.weightKg > remaining + 0.0005) {
        throw new BadRequestException(`Only ${Math.max(remaining, 0).toFixed(3)} KG of ${current.flowNo} is left to deliver`);
      }

      const toParty = dto.destination === FabricDeliveryDestination.CUSTOMER;
      let target: string;
      if (toParty) {
        const party = dto.partyName?.trim();
        if (!party) throw new BadRequestException('Enter who the fabric went to');
        target = party;
      } else {
        // The fabric is on its way: it becomes stock when the warehouse receives it (receiveFabric).
        const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { code: true } });
        if (!warehouse) throw new BadRequestException('Choose an active warehouse');
        target = warehouse.code;
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
      await tx.fabricFlowDelivery.create({
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
      const nowDelivered = delivered + dto.weightKg;
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'FABRIC_DELIVERED',
          module: 'production',
          entity: 'FabricProductionFlow',
          entityId: id,
          newValue: { flowNo: current.flowNo, to: toParty ? 'PARTY' : 'WAREHOUSE', target, weightKg: dto.weightKg, amount },
        },
      });
      return tx.fabricProductionFlow.update({
        where: { id },
        data: {
          finalDeliveredKg: nowDelivered,
          collectedAmount: { increment: amount },
          otherExpense: { increment: expense },
          finalDate: current.finalDate && current.finalDate > deliveredAt ? current.finalDate : deliveredAt,
          status: nowDelivered >= available - 0.0005 ? 'DELIVERED' : current.status,
        },
        include: flowInclude,
      });
    });
    return this.fabricFlowView(flow);
  }

  /** Fabric sent from production that a warehouse has not received yet, oldest first. */
  incomingFabric(warehouseId: string) {
    return this.prisma.fabricFlowDelivery.findMany({
      where: { warehouseId, destination: FabricDeliveryDestination.WAREHOUSE, receivedAt: null },
      include: { flow: { select: { id: true, flowNo: true, yarnCount: true, color: true } } },
      orderBy: { deliveredAt: 'asc' },
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
          notes: `${delivery.flow.flowNo} ${category.toLowerCase().replace('_', ' ')} from production (sent ${Number(delivery.weightKg).toFixed(3)} KG)`,
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
          newValue: { flowNo: delivery.flow.flowNo, warehouse: delivery.warehouse?.code, sentKg: Number(delivery.weightKg), receivedKg: dto.receivedWeightKg },
        },
      });
      return tx.fabricFlowDelivery.update({
        where: { id: deliveryId },
        data: { receivedAt, receivedWeightKg: dto.receivedWeightKg, receivedById: user.id, stockTxnId: txn.id },
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
