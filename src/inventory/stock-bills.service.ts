import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockBillKind } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { lockKeys } from '../common/locks';
import { documentNo } from '../common/numbering';
import { PrismaService } from '../prisma/prisma.service';
import { itemSpecs } from '../common/item-specs';
import { GODOWN_ENTRY } from './constants';

type Db = Prisma.TransactionClient | PrismaService;

export type StockBillInput = {
  warehouseId: string;
  referenceType: string;
  referenceId: string;
  kind: StockBillKind;
  partyName?: string;
  vehicleNo?: string;
  notes?: string;
};

/** A stock movement as far as its challan is concerned. */
type Movement = {
  id: string;
  warehouseId: string;
  referenceType: string;
  referenceId: string;
  txnType: string;
  quantityIn: Prisma.Decimal | number;
  quantityOut: Prisma.Decimal | number;
  notes: string | null;
  createdById: string | null;
  stockBillId?: string | null;
};

/**
 * Where a challan's movements came from, as printed: e.g. "Sale SAL-2026-000004", with the party it implies (and its
 * address, GSTIN and phone when known), the vehicle, and the documents it refers to.
 */
type Source = {
  label: string;
  partyName: string | null;
  vehicleNo: string | null;
  driverName?: string | null;
  transporter?: string | null;
  lrNo?: string | null;
  partyAddress?: string | null;
  partyGst?: string | null;
  partyPhone?: string | null;
  references: Array<{ label: string; value: string }>;
};
type SourceRef = { referenceType: string; referenceId: string; kind: StockBillKind; notes?: string | null; txnType?: string | null };

const directionOf = (kind: StockBillKind): Prisma.StockTransactionWhereInput =>
  kind === StockBillKind.RECEIVED ? { quantityIn: { gt: 0 } } : { quantityOut: { gt: 0 } };
const kindOf = (m: Pick<Movement, 'quantityIn' | 'quantityOut'>) =>
  Number(m.quantityIn) > 0 ? StockBillKind.RECEIVED : Number(m.quantityOut) > 0 ? StockBillKind.EXPORT : null;
const prefixOf = (kind: StockBillKind) => (kind === StockBillKind.RECEIVED ? 'RCV' : 'EXP');
const blank = (value?: string | null) => value?.trim() || null;
const ref = (label: string, value?: string | null) => (value ? [{ label, value }] : []);
const day = (date?: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/**
 * Received and export challans for warehouse stock movements. Every movement in or out of a warehouse goes on one
 * automatically as it is saved: all the lines one operation moves (a goods receipt, a sale dispatch, a knitting load)
 * share one challan per warehouse and direction. Everyone who sees the warehouse can open, print and share them;
 * admins can cancel one (its movements then wait for a new challan) or issue the ones still waiting.
 */
@Injectable()
export class StockBillsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The challan each open transaction is filling, per warehouse, source and direction. */
  private readonly openChallans = new WeakMap<object, Map<string, string>>();

  /** What each source is called, the party / vehicle it gives the challan, and the documents it refers to. */
  private async sources(refs: SourceRef[], db: Db = this.prisma) {
    const ids = (type: string) => [...new Set(refs.filter((r) => r.referenceType === type).map((r) => r.referenceId))];
    const [sales, receipts, flows, runs] = await Promise.all([
      ids('SALE').length
        ? db.sale.findMany({
            where: { id: { in: ids('SALE') } },
            select: {
              id: true,
              saleNo: true,
              challanNo: true,
              saleDate: true,
              partyName: true,
              partyGst: true,
              partyPhone: true,
              partyAddress: true,
              vehicleNo: true,
              driverName: true,
              transporter: true,
              lrNo: true,
            },
          })
        : [],
      ids('PURCHASE_RECEIPT').length
        ? db.purchaseReceipt.findMany({
            where: { id: { in: ids('PURCHASE_RECEIPT') } },
            select: {
              id: true,
              receiptNo: true,
              challanNo: true,
              vehicleNo: true,
              lotNo: true,
              purchaseOrder: { select: { poNo: true, supplier: { select: { name: true, gst: true, mobile: true, address: true } } } },
            },
          })
        : [],
      ids('PRODUCTION_BATCH').length
        ? db.fabricProductionFlow.findMany({
            where: { id: { in: ids('PRODUCTION_BATCH') } },
            select: {
              id: true,
              flowNo: true,
              fabricType: true,
              fabricDiameter: true,
              color: true,
              knittingPartyDetails: true,
              knittingMillDetails: true,
              dyeingPartyDetails: true,
              compactingPartyDetails: true,
            },
          })
        : [],
      ids('KNITTING_RUN').length
        ? db.knittingRun.findMany({
            where: { id: { in: ids('KNITTING_RUN') } },
            select: {
              id: true,
              runNo: true,
              fabricType: true,
              machine: { select: { code: true, name: true } },
              operator: { select: { name: true } },
            },
          })
        : [],
    ]);
    return (r: SourceRef): Source => {
      switch (r.referenceType) {
        case 'SALE': {
          const sale = sales.find((s) => s.id === r.referenceId);
          return sale
            ? {
                label: `Sale ${sale.saleNo}${sale.challanNo ? ` · delivery challan ${sale.challanNo}` : ''}`,
                partyName: sale.partyName,
                partyAddress: sale.partyAddress,
                partyGst: sale.partyGst,
                partyPhone: sale.partyPhone,
                vehicleNo: sale.vehicleNo,
                driverName: sale.driverName,
                transporter: sale.transporter,
                lrNo: sale.lrNo,
                references: [
                  ...ref('Sale bill', sale.saleNo),
                  ...ref('Delivery challan', sale.challanNo),
                  ...ref('Bill date', day(sale.saleDate)),
                ],
              }
            : { label: 'Sale', partyName: null, vehicleNo: null, references: [] };
        }
        case 'PURCHASE_RECEIPT': {
          const receipt = receipts.find((x) => x.id === r.referenceId);
          const supplier = receipt?.purchaseOrder.supplier;
          return receipt
            ? {
                label: `Goods receipt ${receipt.receiptNo} · ${receipt.purchaseOrder.poNo}${receipt.challanNo ? ` · challan ${receipt.challanNo}` : ''}`,
                partyName: supplier?.name ?? null,
                partyAddress: supplier?.address,
                partyGst: supplier?.gst,
                partyPhone: supplier?.mobile,
                vehicleNo: receipt.vehicleNo,
                references: [
                  ...ref('GRN', receipt.receiptNo),
                  ...ref('Purchase order', receipt.purchaseOrder.poNo),
                  ...ref('Their challan', receipt.challanNo),
                  ...ref('Lot', receipt.lotNo),
                ],
              }
            : { label: 'Goods receipt', partyName: null, vehicleNo: null, references: [] };
        }
        case 'PRODUCTION_BATCH': {
          const flow = flows.find((f) => f.id === r.referenceId);
          // Fabric going out of a warehouse goes to whoever does the next process.
          const sentTo =
            r.txnType === 'DYEING_ISSUE'
              ? flow?.dyeingPartyDetails
              : r.txnType === 'PRODUCTION_ISSUE'
                ? flow?.compactingPartyDetails
                : (flow?.knittingPartyDetails ?? flow?.knittingMillDetails);
          const fabric = [flow?.fabricType, flow?.fabricDiameter, flow?.color].filter(Boolean).join(' · ');
          return {
            label: flow ? `Production batch ${flow.flowNo}` : 'Production batch',
            partyName: r.kind === StockBillKind.EXPORT ? sentTo || 'Production' : 'Production',
            vehicleNo: null,
            references: [...ref('Batch', flow?.flowNo), ...ref('Fabric', fabric)],
          };
        }
        case 'KNITTING_RUN': {
          const run = runs.find((x) => x.id === r.referenceId);
          return {
            label: run ? `Knitting run ${run.runNo} · ${run.machine.code}` : 'Knitting run',
            partyName: 'Own knitting',
            vehicleNo: null,
            references: run
              ? [
                  ...ref('Knitting run', run.runNo),
                  ...ref('Machine', `${run.machine.code} · ${run.machine.name}`),
                  ...ref('Fabric', run.fabricType),
                  ...ref('Operator', run.operator?.name),
                ]
              : [],
          };
        }
        case GODOWN_ENTRY:
          return {
            label: `Godown entry ${r.referenceId}`,
            partyName: blank(r.notes),
            vehicleNo: null,
            references: ref('Godown entry', r.referenceId),
          };
        default:
          return {
            label: `${r.referenceType.replaceAll('_', ' ').toLowerCase()} ${r.referenceId}`,
            partyName: null,
            vehicleNo: null,
            references: [],
          };
      }
    };
  }

  /**
   * Puts a movement on its challan inside the transaction that made it: the first movement of an operation opens a
   * new received / export challan for its warehouse and source, the rest of that operation's lines join it.
   */
  async autoIssue(tx: Prisma.TransactionClient, movement: Movement) {
    const kind = kindOf(movement);
    if (!kind) return null;
    // Outside a transaction there is no operation to group by, so each movement gets its own challan.
    const grouped = tx !== (this.prisma as unknown);
    let open = grouped ? this.openChallans.get(tx) : undefined;
    if (grouped && !open) {
      open = new Map();
      this.openChallans.set(tx, open);
    }
    const key = [movement.warehouseId, movement.referenceType, movement.referenceId, kind].join('|');
    let billId = open?.get(key);
    if (!billId) {
      const source = (await this.sources([{ ...movement, kind }], tx))({ ...movement, kind });
      const bill = await tx.stockBill.create({
        data: {
          billNo: await documentNo(tx, prefixOf(kind)),
          kind,
          warehouseId: movement.warehouseId,
          referenceType: movement.referenceType,
          referenceId: movement.referenceId,
          partyName: source.partyName,
          vehicleNo: source.vehicleNo?.toUpperCase() ?? null,
          createdById: movement.createdById,
        },
      });
      billId = bill.id;
      open?.set(key, billId);
    }
    await tx.stockTransaction.update({ where: { id: movement.id }, data: { stockBillId: billId } });
    return billId;
  }

  /**
   * Cancels a challan because one of its lines is being corrected or removed, freeing its lines; returns its group so
   * `reissue` can put what is left (with the correction) on a new challan. The cancelled one stays on record.
   */
  async replace(tx: Prisma.TransactionClient, billId: string | null | undefined, reason: string, actorId: string | null) {
    if (!billId) return null;
    const bill = await tx.stockBill.findUnique({ where: { id: billId } });
    if (!bill || bill.cancelledAt) return null;
    await tx.stockTransaction.updateMany({ where: { stockBillId: billId }, data: { stockBillId: null } });
    await tx.stockBill.update({ where: { id: billId }, data: { cancelledAt: new Date(), cancelledById: actorId, cancelReason: reason } });
    return {
      warehouseId: bill.warehouseId,
      referenceType: bill.referenceType,
      referenceId: bill.referenceId,
      kind: bill.kind,
    } satisfies StockBillInput;
  }

  /** Issues new challans for these groups' movements still without one (after `replace`, or for an edited movement). */
  async reissue(tx: Prisma.TransactionClient, groups: Array<StockBillInput | null>, actorId: string | null) {
    const seen = new Set<string>();
    for (const group of groups) {
      if (!group) continue;
      const key = [group.warehouseId, group.referenceType, group.referenceId, group.kind].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      await this.issueGroup(tx, group, actorId, false);
    }
  }

  /** The challan group a movement belongs to. */
  groupOf(movement: Pick<Movement, 'warehouseId' | 'referenceType' | 'referenceId' | 'quantityIn' | 'quantityOut'>): StockBillInput | null {
    const kind = kindOf(movement);
    return kind
      ? { warehouseId: movement.warehouseId, referenceType: movement.referenceType, referenceId: movement.referenceId, kind }
      : null;
  }

  /**
   * Puts one source's movements still without a challan (in one warehouse and direction) on a new challan; returns
   * it, the challan they are already on when none are waiting, or null when there are no such movements.
   */
  private async issueGroup(tx: Prisma.TransactionClient, dto: StockBillInput, actorId: string | null, required: boolean) {
    const where: Prisma.StockTransactionWhereInput = {
      warehouseId: dto.warehouseId,
      referenceType: dto.referenceType,
      referenceId: dto.referenceId,
      ...directionOf(dto.kind),
    };
    const movements = await tx.stockTransaction.findMany({
      where,
      select: { id: true, stockBillId: true, notes: true, txnType: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!movements.length) {
      if (required)
        throw new BadRequestException(`No stock ${dto.kind === StockBillKind.RECEIVED ? 'came in' : 'went out'} for this in the warehouse`);
      return null;
    }
    const unbilled = movements.filter((m) => !m.stockBillId);
    if (!unbilled.length) return movements[0].stockBillId!;

    const first = { ...dto, notes: unbilled[0].notes, txnType: unbilled[0].txnType };
    const source = (await this.sources([first], tx))(first);
    const bill = await tx.stockBill.create({
      data: {
        billNo: await documentNo(tx, prefixOf(dto.kind)),
        kind: dto.kind,
        warehouseId: dto.warehouseId,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        partyName: blank(dto.partyName) ?? source.partyName,
        vehicleNo: (blank(dto.vehicleNo) ?? source.vehicleNo)?.toUpperCase() ?? null,
        notes: blank(dto.notes),
        createdById: actorId,
      },
    });
    await tx.stockTransaction.updateMany({ where: { id: { in: unbilled.map((m) => m.id) } }, data: { stockBillId: bill.id } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'STOCK_BILL_ISSUED',
        module: 'inventory',
        entity: 'StockBill',
        entityId: bill.id,
        newValue: { billNo: bill.billNo, kind: bill.kind, source: source.label, movements: unbilled.length },
      },
    });
    return bill.id;
  }

  /** Issues the challan for the movements of one source still without one; returns the existing one when there are none. */
  async create(dto: StockBillInput, user: AuthUser) {
    const id = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `stock-bill:${dto.warehouseId}:${dto.referenceType}:${dto.referenceId}:${dto.kind}`);
      return (await this.issueGroup(tx, dto, user.id, true))!;
    });
    return this.findOne(id, { prices: true });
  }

  /**
   * Issues a challan for every source still waiting for one (in one warehouse, or all): e.g. movements made before
   * challans were automatic, or freed by a cancelled challan.
   */
  async issueAll(warehouseId: string | undefined, user: AuthUser) {
    const waiting = await this.prisma.stockTransaction.findMany({
      where: { stockBillId: null, billWaivedAt: null, ...(warehouseId ? { warehouseId } : {}) },
      select: { warehouseId: true, referenceType: true, referenceId: true, quantityIn: true, quantityOut: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    const groups = new Map<string, StockBillInput>();
    for (const m of waiting) {
      const kind = kindOf(m);
      if (!kind) continue;
      groups.set([m.warehouseId, m.referenceType, m.referenceId, kind].join('|'), {
        warehouseId: m.warehouseId,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        kind,
      });
    }
    let issued = 0;
    for (const group of groups.values()) {
      await this.create(group, user);
      issued += 1;
    }
    return { issued };
  }

  /** The challan ready to print: company letterhead, warehouse, source and its documents, party, vehicle and every line. */
  /**
   * The rate behind each line, where the source has one: the PO rate of goods received, the sale rate of goods
   * dispatched, the yarn rate of yarn issued to production or knitting. Keyed by item code and lot.
   */
  private async rates(bill: { referenceType: string; referenceId: string }) {
    const rates = new Map<string, number>();
    const key = (code: string, lot?: string | null) => `${code}|${lot ?? ''}`;
    if (bill.referenceType === 'SALE') {
      const items = await this.prisma.saleItem.findMany({ where: { saleId: bill.referenceId }, select: { itemCode: true, lotNo: true, rate: true } });
      for (const i of items) rates.set(key(i.itemCode, i.lotNo), Number(i.rate));
    } else if (bill.referenceType === 'PURCHASE_RECEIPT') {
      const receipt = await this.prisma.purchaseReceipt.findUnique({
        where: { id: bill.referenceId },
        select: { items: { select: { purchaseOrderItem: { select: { itemCode: true, rate: true } } } } },
      });
      for (const i of receipt?.items ?? []) if (i.purchaseOrderItem.itemCode) rates.set(key(i.purchaseOrderItem.itemCode), Number(i.purchaseOrderItem.rate));
    } else if (bill.referenceType === 'PRODUCTION_BATCH') {
      const flow = await this.prisma.fabricProductionFlow.findUnique({ where: { id: bill.referenceId }, select: { yarnItemCode: true, yarnRatePerKg: true } });
      if (flow?.yarnItemCode && Number(flow.yarnRatePerKg) > 0) rates.set(key(flow.yarnItemCode), Number(flow.yarnRatePerKg));
    } else if (bill.referenceType === 'KNITTING_RUN') {
      const yarns = await this.prisma.knittingRunYarn.findMany({ where: { runId: bill.referenceId }, select: { itemCode: true, lotNo: true, ratePerKg: true } });
      for (const y of yarns) rates.set(key(y.itemCode, y.lotNo), Number(y.ratePerKg));
    }
    return (code: string, lot: string | null) => rates.get(key(code, lot)) ?? rates.get(key(code)) ?? null;
  }

  /**
   * The challan ready to print: letterhead, warehouse, source and its documents, party, vehicle, and every line with
   * the item's full details (fabric type, dia, GSM, GG, LL, colour, rolls…). Rates and values only with `prices`.
   */
  async findOne(id: string, opts: { prices?: boolean } = {}) {
    const bill = await this.prisma.stockBill.findUnique({
      where: { id },
      include: {
        warehouse: { select: { id: true, code: true, name: true, location: true } },
        txns: {
          select: {
            id: true,
            category: true,
            txnType: true,
            itemCode: true,
            itemName: true,
            lotNo: true,
            unit: true,
            quantityIn: true,
            quantityOut: true,
            notes: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!bill) throw new NotFoundException('Challan not found');
    const first = { ...bill, notes: bill.txns[0]?.notes, txnType: bill.txns[0]?.txnType };
    const [source, people, company, specs, rateOf] = await Promise.all([
      this.sources([first]),
      this.prisma.user.findMany({
        where: { id: { in: [bill.createdById, bill.cancelledById].filter((v): v is string => !!v) } },
        select: { id: true, name: true },
      }),
      this.prisma.systemSetting.findUnique({ where: { key: 'company' } }),
      itemSpecs(
        this.prisma,
        bill.txns.map((t) => t.itemCode),
      ),
      opts.prices ? this.rates(bill) : null,
    ]);
    const name = (userId: string | null) => people.find((p) => p.id === userId)?.name ?? null;
    const lines = bill.txns.map(({ quantityIn, quantityOut, ...line }) => {
      const quantity = Number(bill.kind === StockBillKind.RECEIVED ? quantityIn : quantityOut);
      const rate = rateOf ? rateOf(line.itemCode, line.lotNo) : null;
      return {
        ...line,
        quantity,
        specs: [...(line.lotNo ? [{ label: 'Lot', value: line.lotNo }] : []), ...(specs.get(line.itemCode) ?? [])],
        rate,
        amount: rate === null ? null : Math.round(quantity * rate * 100) / 100,
      };
    });
    const priced = lines.some((l) => l.rate !== null);
    return {
      ...bill,
      source: source(first),
      createdBy: name(bill.createdById),
      cancelledBy: name(bill.cancelledById),
      company: (company?.value ?? {}) as Record<string, string>,
      lines,
      /** Total value of the lines that have a rate; null when prices aren't shown or none has one. */
      value: priced ? Math.round(lines.reduce((sum, l) => sum + (l.amount ?? 0), 0) * 100) / 100 : null,
      txns: undefined,
    };
  }

  /**
   * Challans, newest first: one warehouse's (and how many of its movements still have none), or every warehouse's for
   * the office register, optionally within dates and of one kind.
   */
  async list(params: { warehouseId?: string; from?: Date; to?: Date; kind?: StockBillKind }) {
    const where: Prisma.StockBillWhereInput = {
      ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.from || params.to
        ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
    };
    const [bills, unbilled] = await Promise.all([
      this.prisma.stockBill.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 1000,
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
          _count: { select: { txns: true } },
          txns: {
            select: { notes: true, txnType: true, itemName: true, unit: true, quantityIn: true, quantityOut: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      this.prisma.stockTransaction.count({
        where: { stockBillId: null, billWaivedAt: null, ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}) },
      }),
    ]);
    const source = await this.sources(bills.map((b) => ({ ...b, notes: b.txns[0]?.notes, txnType: b.txns[0]?.txnType })));
    return {
      unbilled,
      bills: bills.map(({ txns, _count, ...b }) => {
        const totals: Record<string, number> = {};
        for (const t of txns)
          totals[t.unit] = (totals[t.unit] ?? 0) + Number(b.kind === StockBillKind.RECEIVED ? t.quantityIn : t.quantityOut);
        return {
          ...b,
          lines: _count.txns,
          items: [...new Set(txns.map((t) => t.itemName))],
          totals,
          source: source({ ...b, notes: txns[0]?.notes, txnType: txns[0]?.txnType }),
        };
      }),
    };
  }

  /**
   * Clears a warehouse's movements without a challan made before `before` (default: now) as needing none. They stay
   * in the ledger and can still get a challan; they just stop waiting.
   */
  async clearUnbilled(warehouseId: string, before: Date | undefined, user: AuthUser) {
    const cutoff = before ?? new Date();
    const { count } = await this.prisma.$transaction(async (tx) => {
      const result = await tx.stockTransaction.updateMany({
        where: { warehouseId, stockBillId: null, billWaivedAt: null, createdAt: { lte: cutoff } },
        data: { billWaivedAt: new Date() },
      });
      if (result.count) {
        await tx.auditLog.create({
          data: {
            actorId: user.id,
            action: 'STOCK_BILLS_CLEARED',
            module: 'inventory',
            entity: 'Warehouse',
            entityId: warehouseId,
            newValue: { movements: result.count, before: cutoff.toISOString() },
          },
        });
      }
      return result;
    });
    return { cleared: count };
  }

  /** Cancels a challan (e.g. for the wrong movements); its movements then wait for a new one. */
  async cancel(id: string, reason: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const bill = await tx.stockBill.findUnique({ where: { id } });
      if (!bill) throw new NotFoundException('Challan not found');
      if (bill.cancelledAt) throw new BadRequestException(`${bill.billNo} is already cancelled`);
      await tx.stockTransaction.updateMany({ where: { stockBillId: id }, data: { stockBillId: null } });
      await tx.stockBill.update({ where: { id }, data: { cancelledAt: new Date(), cancelledById: user.id, cancelReason: blank(reason) } });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'STOCK_BILL_CANCELLED',
          module: 'inventory',
          entity: 'StockBill',
          entityId: id,
          newValue: { billNo: bill.billNo, reason: blank(reason) },
        },
      });
    });
    return this.findOne(id, { prices: true });
  }
}

/** A challan as printed (and drawn into its PDF). */
export type Challan = Awaited<ReturnType<StockBillsService['findOne']>>;
