import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockCategory, StockTransaction, StockTxnType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { documentNo } from '../common/numbering';
import { lockKeys } from '../common/locks';
import { ENTRY_TYPES, GODOWN_CATEGORIES, GodownEntryDto } from './dto/godown-entry.dto';
import { GODOWN_ENTRY } from './constants';
import { StockBillsService } from './stock-bills.service';
import { itemJourney } from './item-journey';

export { GODOWN_ENTRY };


export type StockTxnInput = {
  category: StockCategory;
  txnType: StockTxnType;
  itemCode: string;
  itemName: string;
  lotNo?: string;
  warehouseId: string;
  quantityIn?: number;
  quantityOut?: number;
  /** Defaults to KG. */
  unit?: string;
  referenceType: string;
  referenceId: string;
  createdById?: string;
  notes?: string;
  /** When it happened, if not now (e.g. a delivery recorded later). */
  createdAt?: Date;
};

/** Most movements the ledger returns at once; the Godown page asks for a date range beyond that. */
export const LEDGER_LIMIT = 500;
/** Latest movements shown in an item's details. */
const ITEM_MOVEMENT_LIMIT = 200;

/** One stock position: balances are kept per category, item, lot, warehouse and unit. */
type StockKey = { category: StockCategory; itemCode: string; warehouseId: string; lotNo: string | null; unit: string };

const keyOf = (t: Omit<StockKey, 'unit'> & { unit?: string }): StockKey => ({
  category: t.category, itemCode: t.itemCode, warehouseId: t.warehouseId, lotNo: t.lotNo, unit: t.unit ?? 'KG',
});
const lockName = (k: StockKey) => `stock:${k.category}:${k.itemCode}:${k.warehouseId}`;
const sameKey = (a: StockKey, b: StockKey) =>
  a.category === b.category && a.itemCode === b.itemCode && a.warehouseId === b.warehouseId && a.lotNo === b.lotNo && a.unit === b.unit;
/** "Cotton 30s combed" → "COTTON-30S-COMBED" */
const codeFromName = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'ITEM';

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private bills: StockBillsService,
  ) {}

  /**
   * Stock per item, lot, warehouse and unit. Movements of one item code typed with different names
   * ("Yarn" / "yarn") are one stock row, shown under the most recently used name. `balanceKg` keeps
   * its old name but is in the row's `unit` (KG for everything but purchases made in cones, bags…).
   */
  async balance(filter: { category?: StockCategory; itemCode?: string; lotNo?: string; warehouseId?: string } = {}) {
    const groups = await this.prisma.stockTransaction.groupBy({
      by: ['category', 'itemCode', 'itemName', 'lotNo', 'warehouseId', 'unit'],
      where: {
        ...(filter.category ? { category: filter.category } : {}),
        ...(filter.itemCode ? { itemCode: filter.itemCode } : {}),
        ...(filter.lotNo ? { lotNo: filter.lotNo } : {}),
        ...(filter.warehouseId ? { warehouseId: filter.warehouseId } : {}),
      },
      _sum: { quantityIn: true, quantityOut: true },
      _max: { createdAt: true },
    });
    const rows = new Map<string, { category: StockCategory; itemCode: string; itemName: string; lotNo: string | null; warehouseId: string; unit: string; quantityIn: number; quantityOut: number; lastAt: number }>();
    for (const g of groups) {
      const key = [g.category, g.itemCode, g.lotNo, g.warehouseId, g.unit].join('|');
      const quantityIn = Number(g._sum.quantityIn || 0);
      const quantityOut = Number(g._sum.quantityOut || 0);
      const lastAt = g._max.createdAt?.getTime() ?? 0;
      const row = rows.get(key);
      if (!row) {
        rows.set(key, { category: g.category, itemCode: g.itemCode, itemName: g.itemName, lotNo: g.lotNo, warehouseId: g.warehouseId, unit: g.unit, quantityIn, quantityOut, lastAt });
        continue;
      }
      row.quantityIn += quantityIn;
      row.quantityOut += quantityOut;
      if (lastAt > row.lastAt) Object.assign(row, { itemName: g.itemName, lastAt });
    }
    // lastMovedAt: when the position last moved, for sorting by date.
    return [...rows.values()].map(({ lastAt, ...row }) => ({
      ...row,
      balanceKg: row.quantityIn - row.quantityOut,
      lastMovedAt: lastAt ? new Date(lastAt).toISOString() : null,
    }));
  }

  /**
   * One warehouse's stock by item code (all lots of a code together, per unit): what came in, what was sold (sales
   * dispatched from here), what else went out (production, knitting, waste, adjustments), what is left, and sales
   * this month. For the warehouse's details page. With `from` / `to`, received, sold and issued cover only those dates
   * (and `moved` says whether the item moved in them); the balance is always today's.
   */
  async itemSummary(warehouseId: string, from?: Date, to?: Date) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const ranged = !!(from || to);
    const inRange = ranged ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
    const [positions, sold, soldMonth, moved] = await Promise.all([
      this.balance({ warehouseId }),
      this.prisma.stockTransaction.groupBy({ by: ['itemCode', 'unit'], where: { warehouseId, referenceType: 'SALE', ...inRange }, _sum: { quantityOut: true }, _max: { createdAt: true } }),
      this.prisma.stockTransaction.groupBy({ by: ['itemCode', 'unit'], where: { warehouseId, referenceType: 'SALE', createdAt: { gte: monthStart } }, _sum: { quantityOut: true } }),
      ranged
        ? this.prisma.stockTransaction.groupBy({ by: ['itemCode', 'unit'], where: { warehouseId, ...inRange }, _sum: { quantityIn: true, quantityOut: true } })
        : Promise.resolve(null),
    ]);
    const key = (itemCode: string, unit: string) => `${itemCode}|${unit}`;
    const soldBy = new Map(sold.map((g) => [key(g.itemCode, g.unit), { qty: Number(g._sum.quantityOut ?? 0), lastAt: g._max.createdAt }]));
    const soldMonthBy = new Map(soldMonth.map((g) => [key(g.itemCode, g.unit), Number(g._sum.quantityOut ?? 0)]));
    const items = new Map<string, { itemCode: string; itemName: string; category: StockCategory; unit: string; lots: Set<string>; inQty: number; outQty: number; balance: number; lastMovedAt: string | null; moved: boolean }>();
    for (const p of positions) {
      const k = key(p.itemCode, p.unit);
      const item = items.get(k) ?? { itemCode: p.itemCode, itemName: p.itemName, category: p.category, unit: p.unit, lots: new Set<string>(), inQty: 0, outQty: 0, balance: 0, lastMovedAt: null, moved: !ranged };
      if (p.lotNo && Math.abs(p.balanceKg) > 0.0005) item.lots.add(p.lotNo);
      item.inQty += p.quantityIn;
      item.outQty += p.quantityOut;
      item.balance += p.balanceKg;
      if (p.lastMovedAt && (!item.lastMovedAt || p.lastMovedAt > item.lastMovedAt)) item.lastMovedAt = p.lastMovedAt;
      items.set(k, item);
    }
    // In a date range: what came in and went out in those dates only.
    if (moved) {
      const movedBy = new Map(moved.map((g) => [key(g.itemCode, g.unit), { in: Number(g._sum.quantityIn ?? 0), out: Number(g._sum.quantityOut ?? 0) }]));
      for (const [k, item] of items) {
        const m = movedBy.get(k);
        Object.assign(item, { inQty: m?.in ?? 0, outQty: m?.out ?? 0, moved: !!m });
      }
    }
    return [...items.values()]
      .map(({ lots, ...item }) => {
        const s = soldBy.get(key(item.itemCode, item.unit));
        const soldQty = s?.qty ?? 0;
        return {
          ...item,
          lots: [...lots].sort(),
          soldQty,
          otherOutQty: Math.max(0, item.outQty - soldQty),
          soldThisMonth: soldMonthBy.get(key(item.itemCode, item.unit)) ?? 0,
          lastSoldAt: s?.lastAt ?? null,
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.itemCode.localeCompare(b.itemCode));
  }

  /**
   * Everything about one item code: its name(s) and materials, stock in every warehouse and lot,
   * the purchase lines it was bought on (with their receipts) and its latest movements.
   */
  async itemDetails(itemCode: string, opts: { prices: boolean } = { prices: false }) {
    const [balances, movements, purchaseLines, warehouses, story] = await Promise.all([
      this.balance({ itemCode }),
      this.prisma.stockTransaction.findMany({
        where: { itemCode },
        include: { warehouse: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: ITEM_MOVEMENT_LIMIT,
      }),
      this.prisma.purchaseOrderItem.findMany({
        where: { itemCode },
        include: {
          purchaseOrder: {
            select: { id: true, poNo: true, orderDate: true, status: true, supplier: { select: { code: true, name: true } } },
          },
          receiptItems: {
            include: { purchaseReceipt: { select: { receiptNo: true, receivedAt: true, lotNo: true, warehouse: { select: { code: true } } } } },
          },
        },
      }),
      this.prisma.warehouse.findMany({ select: { id: true, code: true, name: true } }),
      // Its full story: what was made from it, by which machines, dyed, compacted, delivered and sold.
      itemJourney(this.prisma, itemCode, opts),
    ]);
    // A batch or run still in process has no stock yet, but it is still a code to show.
    if (!movements.length && !purchaseLines.length && !story.journey.length && !story.runs.length && !story.sales.length) {
      throw new NotFoundException(`No item with code ${itemCode}`);
    }
    // Production batches this code went into (as yarn) or came out of (as finished fabric).
    const batches = await this.prisma.fabricProductionFlow.findMany({
      where: { OR: [{ flowNo: itemCode }, { yarnItemCode: itemCode }] },
      select: { flowNo: true, status: true, fabricType: true, fabricDiameter: true, fabricGsm: true, purchasedWeightKg: true, dyeingDeliveryKg: true, finalDeliveredKg: true, officeDeliveryKg: true },
      orderBy: { createdAt: 'asc' },
    });
    // Knitting machine runs this code was loaded on (as yarn) or knitted as (grey fabric).
    const knittingRuns = await this.prisma.knittingRun.findMany({
      where: { OR: [{ runNo: itemCode }, { yarns: { some: { itemCode } } }] },
      select: {
        runNo: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        yarnKg: true,
        outputKg: true,
        machine: { select: { code: true } },
        yarns: { where: { itemCode }, select: { kg: true } },
      },
      orderBy: { startedAt: 'asc' },
    });
    const warehouseById = new Map(warehouses.map((w) => [w.id, w]));
    // Newest name first; older spellings are listed too.
    const names = [
      ...new Set([
        ...movements.map((m) => m.itemName),
        ...purchaseLines.map((l) => l.itemName),
        ...story.journey.filter((j) => j.flowNo === itemCode).map((j) => [j.fabric.type, j.fabric.color].filter(Boolean).join(' · ') || `${j.yarn.name} fabric`),
        ...story.runs.filter((r) => r.runNo === itemCode).map((r) => `${r.fabricType ?? 'Grey'} fabric`),
      ]),
    ];
    return {
      itemCode,
      itemName: names[0],
      otherNames: names.slice(1),
      categories: [...new Set([...balances.map((b) => b.category), ...purchaseLines.flatMap((l) => (l.category ? [l.category] : []))])],
      stock: balances.map((b) => ({ ...b, warehouse: warehouseById.get(b.warehouseId) ?? null })),
      purchases: purchaseLines.map((line) => ({
        id: line.id,
        purchaseOrder: line.purchaseOrder,
        quantity: Number(line.quantity),
        unit: line.unit,
        rate: opts.prices ? Number(line.rate) : null,
        receipts: line.receiptItems.map((r) => ({ ...r.purchaseReceipt, quantity: Number(r.quantity) })),
      })),
      movements,
      movementsCapped: movements.length >= ITEM_MOVEMENT_LIMIT,
      batches: batches.map((b) => ({
        ...b,
        purchasedWeightKg: Number(b.purchasedWeightKg),
        dyeingDeliveryKg: b.dyeingDeliveryKg === null ? null : Number(b.dyeingDeliveryKg),
        finalDeliveredKg: b.finalDeliveredKg === null ? null : Number(b.finalDeliveredKg),
        officeDeliveryKg: b.officeDeliveryKg === null ? null : Number(b.officeDeliveryKg),
      })),
      knittingRuns: knittingRuns.map(({ yarns, ...run }) => ({
        ...run,
        yarnKg: Number(run.yarnKg),
        outputKg: run.outputKg === null ? null : Number(run.outputKg),
        /** KG of this code loaded on the run (0 when this code is the run's fabric). */
        thisYarnKg: yarns.reduce((sum, y) => sum + Number(y.kg), 0),
      })),
      ...story,
    };
  }

  /** Newest first, at most LEDGER_LIMIT rows; `from` / `to` narrow it to a period. */
  ledger(params: { category?: StockCategory; itemCode?: string; lotNo?: string; warehouseId?: string; from?: Date; to?: Date }) {
    return this.prisma.stockTransaction.findMany({
      where: {
        ...(params.category ? { category: params.category } : {}),
        ...(params.itemCode ? { itemCode: params.itemCode } : {}),
        ...(params.lotNo ? { lotNo: params.lotNo } : {}),
        ...(params.warehouseId ? { warehouseId: params.warehouseId } : {}),
        ...(params.from || params.to ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } } : {}),
      },
      include: { warehouse: true, stockBill: { select: { id: true, billNo: true, kind: true } } },
      orderBy: { createdAt: 'desc' },
      take: LEDGER_LIMIT,
    });
  }

  /** Records a movement and puts it on its received / export challan (with the operation's other lines). */
  async createTxn(data: StockTxnInput, tx?: Prisma.TransactionClient): Promise<StockTransaction> {
    if (!tx) return this.prisma.$transaction((inner) => this.createTxn(data, inner));
    const txn = await tx.stockTransaction.create({ data });
    await this.bills.autoIssue(tx, txn);
    return txn;
  }

  /**
   * Takes stock out inside the caller's transaction (e.g. yarn issued to knitting), refusing more than the
   * position (item, lot, warehouse) holds. The position is locked so two issues can't both take the last kilos.
   */
  async issueWithin(tx: Prisma.TransactionClient, data: StockTxnInput & { quantityOut: number }) {
    const key = keyOf({ ...data, lotNo: data.lotNo ?? null });
    await lockKeys(tx, lockName(key));
    const available = await this.stockOf(tx, key);
    if (data.quantityOut > available + 0.0005) {
      const lot = key.lotNo ? ` lot ${key.lotNo}` : '';
      throw new BadRequestException(`Only ${Math.max(available, 0).toFixed(3)} ${data.unit ?? 'KG'} of ${data.itemCode}${lot} is in stock`);
    }
    const txn = await tx.stockTransaction.create({ data: { ...data, lotNo: key.lotNo } });
    await this.bills.autoIssue(tx, txn);
    return txn;
  }

  /**
   * Deletes movements inside the caller's transaction (e.g. a cancelled knitting run's yarn issues). Their challans
   * are cancelled, and any lines left on them go on a new one.
   */
  async deleteWithin(tx: Prisma.TransactionClient, ids: string[], actorId: string | null = null) {
    if (!ids.length) return;
    const billed = await tx.stockTransaction.findMany({ where: { id: { in: ids } }, select: { stockBillId: true } });
    const freed = [];
    for (const billId of new Set(billed.map((m) => m.stockBillId))) freed.push(await this.bills.replace(tx, billId, 'Replaced: a movement on it was removed', actorId));
    await tx.stockTransaction.deleteMany({ where: { id: { in: ids } } });
    await this.bills.reissue(tx, freed, actorId);
  }

  /**
   * Removes a stock-in movement inside the caller's transaction (e.g. an undone delivery of fabric into a
   * warehouse), refusing when that stock has already been issued onwards.
   */
  async removeInWithin(tx: Prisma.TransactionClient, txnId: string, actorId: string | null = null) {
    const txn = await tx.stockTransaction.findUnique({ where: { id: txnId } });
    if (!txn) return;
    const key = keyOf(txn);
    await lockKeys(tx, lockName(key));
    const available = await this.stockOf(tx, key);
    if (available - Number(txn.quantityIn) < -0.0005) {
      throw new BadRequestException(
        `${txn.itemCode} has already been issued from stock (only ${Math.max(available, 0).toFixed(3)} ${txn.unit} left), so this can't be undone`,
      );
    }
    const freed = await this.bills.replace(tx, txn.stockBillId, 'Replaced: a movement on it was undone', actorId);
    await tx.stockTransaction.delete({ where: { id: txnId } });
    await this.bills.reissue(tx, [freed], actorId);
  }

  // ─── Godown entries ─────────────────────────────────────────────────────

  private async stockOf(tx: Prisma.TransactionClient, k: StockKey) {
    const a = await tx.stockTransaction.aggregate({ where: k, _sum: { quantityIn: true, quantityOut: true } });
    return Number(a._sum.quantityIn ?? 0) - Number(a._sum.quantityOut ?? 0);
  }

  /**
   * Runs a change to one or two stock positions and rejects it if it leaves either below zero.
   * Positions that were already negative (old data) may still be improved, just not made worse.
   */
  private guardedChange<T>(keys: StockKey[], change: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      const unique = keys.filter((k, i) => keys.findIndex((other) => sameKey(k, other)) === i);
      await lockKeys(tx, ...unique.map(lockName));
      const before = await Promise.all(unique.map((k) => this.stockOf(tx, k)));
      const result = await change(tx);
      for (const [i, k] of unique.entries()) {
        const after = await this.stockOf(tx, k);
        if (after < -0.0005 && after < before[i] - 0.0005) {
          const lot = k.lotNo ? ` lot ${k.lotNo}` : '';
          throw new BadRequestException(
            `Not enough stock: ${k.itemCode}${lot} has ${Math.max(before[i], 0).toFixed(3)} ${k.unit}; this would leave ${after.toFixed(3)} ${k.unit}`,
          );
        }
      }
      return result;
    });
  }

  private async entryData(dto: GodownEntryDto, current?: StockTransaction) {
    const keepsType = current?.txnType === dto.txnType;
    if (!keepsType && !(ENTRY_TYPES[dto.direction] as StockTxnType[]).includes(dto.txnType)) {
      throw new BadRequestException(`${dto.txnType} is not a valid ${dto.direction} entry type`);
    }
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: dto.warehouseId }, select: { active: true } });
    // An old movement may stay in a warehouse that has since been deactivated.
    if (!warehouse || (!warehouse.active && current?.warehouseId !== dto.warehouseId)) {
      throw new BadRequestException('Choose an active warehouse');
    }

    let itemCode = dto.itemCode;
    if (!itemCode) {
      // Reuse the code of an item already in the godown so its stock stays in one row.
      const existing = await this.prisma.stockTransaction.findFirst({
        where: { category: dto.category, itemName: { equals: dto.itemName, mode: 'insensitive' } },
        select: { itemCode: true },
        orderBy: { createdAt: 'desc' },
      });
      itemCode = existing?.itemCode ?? codeFromName(dto.itemName);
    }
    return {
      category: dto.category,
      txnType: dto.txnType,
      itemCode,
      itemName: dto.itemName,
      lotNo: dto.lotNo || null,
      warehouseId: dto.warehouseId,
      unit: current?.unit ?? 'KG',
      quantityIn: dto.direction === 'IN' ? dto.quantityKg : 0,
      quantityOut: dto.direction === 'OUT' ? dto.quantityKg : 0,
      notes: dto.notes || null,
      ...(dto.entryDate ? { createdAt: new Date(dto.entryDate) } : {}),
    };
  }

  private async requireGodownTxn(id: string) {
    const txn = await this.prisma.stockTransaction.findUnique({ where: { id } });
    if (!txn || !GODOWN_CATEGORIES.includes(txn.category)) throw new NotFoundException('Stock entry not found');
    // A movement on a challan can still be corrected: that challan is cancelled and replaced (see updateEntry).
    return txn;
  }

  private audit(tx: Prisma.TransactionClient, actorId: string, action: string, txn: StockTransaction | null, previous: StockTransaction | null) {
    const snapshot = (t: StockTransaction) =>
      ({
        entryNo: t.referenceId,
        category: t.category,
        txnType: t.txnType,
        itemCode: t.itemCode,
        itemName: t.itemName,
        lotNo: t.lotNo,
        warehouseId: t.warehouseId,
        quantityIn: Number(t.quantityIn),
        quantityOut: Number(t.quantityOut),
        date: t.createdAt.toISOString(),
      }) satisfies Prisma.InputJsonObject;
    return tx.auditLog.create({
      data: {
        actorId,
        action,
        module: 'godown',
        entity: 'StockTransaction',
        entityId: (txn ?? previous)?.id,
        previousValue: previous ? snapshot(previous) : Prisma.JsonNull,
        newValue: txn ? snapshot(txn) : Prisma.JsonNull,
      },
    });
  }

  async createEntry(dto: GodownEntryDto, user: AuthUser) {
    const data = await this.entryData(dto);
    return this.guardedChange([keyOf(data)], async (tx) => {
      const txn = await tx.stockTransaction.create({
        data: { ...data, referenceType: GODOWN_ENTRY, referenceId: await documentNo(tx, 'GD'), createdById: user.id },
      });
      await this.bills.autoIssue(tx, txn);
      await this.audit(tx, user.id, 'STOCK_ENTRY_CREATED', txn, null);
      return txn;
    });
  }

  /** Any yarn or fabric movement can be corrected, including old postings from other modules (their reference is kept). */
  async updateEntry(id: string, dto: GodownEntryDto, user: AuthUser) {
    const current = await this.requireGodownTxn(id);
    const data = await this.entryData(dto, current);
    return this.guardedChange([keyOf(current), keyOf(data)], async (tx) => {
      // The printed challan is cancelled and replaced, so the corrected line (and the rest) go on a new one.
      const freed = await this.bills.replace(tx, current.stockBillId, `Replaced: ${current.referenceType === GODOWN_ENTRY ? current.referenceId : 'a line'} was corrected`, user.id);
      const txn = await tx.stockTransaction.update({ where: { id }, data: { ...data, stockBillId: null } });
      await this.bills.reissue(tx, [freed, this.bills.groupOf(txn)], user.id);
      await this.audit(tx, user.id, 'STOCK_ENTRY_UPDATED', txn, current);
      return txn;
    });
  }

  /** Any yarn or fabric movement can be deleted, including old postings from other modules. */
  async deleteEntry(id: string, user: AuthUser) {
    const current = await this.requireGodownTxn(id);
    return this.guardedChange([keyOf(current)], async (tx) => {
      const freed = await this.bills.replace(tx, current.stockBillId, `Replaced: ${current.referenceType === GODOWN_ENTRY ? current.referenceId : 'a line'} was deleted`, user.id);
      await tx.stockTransaction.delete({ where: { id } });
      await this.bills.reissue(tx, [freed], user.id);
      await this.audit(tx, user.id, 'STOCK_ENTRY_DELETED', null, current);
      return { deleted: true };
    });
  }
}
