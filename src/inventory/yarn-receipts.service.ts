import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { batchCode, documentNo } from '../common/numbering';
import { checkText, packageTotal } from '../common/packages';
import { InventoryService } from './inventory.service';
import { yarnUsage } from './yarn-usage';
import { YarnReceiptDto, YarnReceiptLineDto } from './dto/yarn-receipt.dto';

/** Stock movements of a yarn receipt point back to it. */
export const YARN_RECEIPT = 'YARN_RECEIPT';

const n = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Bags as written on a DC ("30+9", "12") and their total; null when none were given. */
export const bagTotal = packageTotal;

/** "Direct" (or nothing) means bought straight from the mill. */
const agentOf = (agent?: string | null) => (agent?.trim() && !/^direct$/i.test(agent.trim()) ? agent.trim() : null);

/** A day's first moment in India time (the register is kept by Indian dates). */
const dayStart = (day: string) => new Date(`${day}T00:00:00+05:30`);
const nextDay = (day: string) => new Date(dayStart(day).getTime() + 86_400_000);

/** The register's period: a month, a range of days (either end open), or (nothing given) all of it. */
export type RegisterPeriod = { month?: string; from?: string; to?: string };

function periodRange(period: RegisterPeriod) {
  if (period.month) return monthRange(period.month);
  const valid = (d?: string) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!valid(period.from) || !valid(period.to)) throw new BadRequestException('Give dates as YYYY-MM-DD');
  if (!period.from && !period.to) return undefined;
  return { ...(period.from ? { gte: dayStart(period.from) } : {}), ...(period.to ? { lt: nextDay(period.to) } : {}) };
}

/** A month's first moment and the next month's, in India time (the register is kept by Indian dates). */
function monthRange(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('Give the month as YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { gte: new Date(`${month}-01T00:00:00+05:30`), lt: new Date(`${next}-01T00:00:00+05:30`) };
}

const receiptInclude = { lines: { orderBy: { itemCode: 'asc' as const } }, warehouse: { select: { id: true, code: true, name: true } } };

/**
 * The yarn received register: every delivery of yarn from a mill (direct or through an agent), its DC number and
 * each count on it with bags and weight. Each count goes into the warehouse under a yarn code of its own (01SS26…),
 * which knitting, dyeing and delivery follow. Yarn received against a purchase order shows in the register too.
 */
/** The most yarn deliveries one register lists (the newest). */
const RECEIPT_LIMIT = 5000;

@Injectable()
export class YarnReceiptsService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  /**
   * The register for a period (a month, a range of days, or all of it): every count received with where its yarn is now
   * (in stock, given to knitting, back from knitting) and the knitting batches it went into (fabric, yarn, fabric made),
   * the totals, and the totals by count and by mill.
   */
  async register(period: RegisterPeriod, opts: { prices: boolean }) {
    const range = periodRange(period);
    const [receipts, orders] = await Promise.all([
      // The newest RECEIPT_LIMIT deliveries (the rows are put back in date order below): taking the first ones in date
      // order instead dropped the latest deliveries once the register grew past the limit.
      this.prisma.yarnReceipt.findMany({ where: range ? { receivedAt: range } : {}, include: receiptInclude, orderBy: [{ receivedAt: 'desc' }, { receiptNo: 'desc' }], take: RECEIPT_LIMIT }),
      this.prisma.purchaseReceipt.findMany({
        where: { ...(range ? { receivedAt: range } : {}), category: 'YARN' },
        include: {
          warehouse: { select: { id: true, code: true, name: true } },
          purchaseOrder: { select: { poNo: true, supplier: { select: { name: true } } } },
          items: { include: { purchaseOrderItem: { select: { itemName: true, itemCode: true, rate: true, unit: true } } } },
        },
        orderBy: { receivedAt: 'asc' },
      }),
    ]);

    const rows = [
      ...receipts.flatMap((r) =>
        r.lines.map((line) => ({
          key: line.id,
          source: 'REGISTER' as const,
          receiptId: r.id,
          receiptNo: r.receiptNo,
          poNo: null as string | null,
          date: r.receivedAt,
          dcNo: r.dcNo,
          mill: r.millName,
          agent: r.agentName,
          warehouse: r.warehouse,
          vehicleNo: r.vehicleNo,
          notes: r.notes,
          lineId: line.id,
          count: line.count,
          bags: line.bags,
          bagCount: line.bagCount,
          weightKg: n(line.weightKg)!,
          dcWeightKg: n(line.dcWeightKg),
          ratePerKg: opts.prices ? n(line.ratePerKg) : null,
          itemCode: line.itemCode,
          stockTxnId: line.stockTxnId,
        })),
      ),
      ...orders.flatMap((r) =>
        r.items
          .filter((item) => (item.purchaseOrderItem.unit ?? 'KG').toUpperCase() === 'KG')
          .map((item) => ({
            key: item.id,
            source: 'PURCHASE' as const,
            receiptId: r.id,
            receiptNo: r.receiptNo,
            poNo: r.purchaseOrder.poNo,
            date: r.receivedAt,
            dcNo: r.challanNo ?? '',
            mill: r.purchaseOrder.supplier.name,
            agent: null as string | null,
            warehouse: r.warehouse,
            vehicleNo: r.vehicleNo,
            notes: r.notes,
            lineId: null,
            count: item.purchaseOrderItem.itemName,
            bags: null as string | null,
            bagCount: null as number | null,
            weightKg: n(item.quantity)!,
            dcWeightKg: n(item.dcQuantity),
            ratePerKg: opts.prices ? n(item.purchaseOrderItem.rate) : null,
            itemCode: item.purchaseOrderItem.itemCode,
            stockTxnId: null as string | null,
          })),
      ),
    ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.receiptNo.localeCompare(b.receiptNo));

    // Where each code's yarn is now, and the knitting batches it went into.
    const usage = await yarnUsage(this.prisma, rows.map((r) => r.itemCode));
    // Each delivery's received challan: the stock challan its movements went on, or a purchase order's goods receipt.
    const challans = await this.challansOf(rows.map((r) => r.stockTxnId));
    const register = rows.map(({ stockTxnId, ...r }) => {
      const s = r.itemCode ? usage.get(r.itemCode) : undefined;
      const bill = stockTxnId ? challans.get(stockTxnId) : undefined;
      return {
        ...r,
        challan: r.source === 'PURCHASE' ? { kind: 'GRN' as const, id: r.receiptId, no: r.receiptNo } : bill ? { kind: 'STOCK' as const, id: bill.id, no: bill.billNo } : null,
        amount: r.ratePerKg === null ? null : round(r.ratePerKg * r.weightKg, 2),
        inStockKg: s ? s.inStockKg : null,
        /** Given to knitting, less what came back: the yarn knitting has. */
        toKnittingKg: s ? s.toKnittingKg : null,
        returnedKg: s ? s.returnedKg : null,
        otherOutKg: s ? s.otherOutKg : null,
        knitting: s?.knitting ?? [],
      };
    });

    const group = <K extends string>(key: (r: (typeof register)[number]) => K) => {
      const out = new Map<K, { kg: number; bags: number; lines: number; deliveries: Set<string> }>();
      for (const r of register) {
        const g = out.get(key(r)) ?? { kg: 0, bags: 0, lines: 0, deliveries: new Set<string>() };
        g.kg += r.weightKg;
        g.bags += r.bagCount ?? 0;
        g.lines += 1;
        g.deliveries.add(r.receiptId);
        out.set(key(r), g);
      }
      return [...out].map(([name, g]) => ({ name, kg: round(g.kg), bags: g.bags, lines: g.lines, deliveries: g.deliveries.size })).sort((a, b) => b.kg - a.kg);
    };
    const priced = register.filter((r) => r.amount !== null);
    const first = register[0]?.date ?? null;
    const last = register[register.length - 1]?.date ?? null;
    return {
      month: period.month ?? null,
      period: { month: period.month ?? null, from: period.from ?? null, to: period.to ?? null, first, last },
      rows: register,
      /** More deliveries than RECEIPT_LIMIT in the period: only the newest are listed. */
      limited: receipts.length >= RECEIPT_LIMIT,
      summary: {
        deliveries: new Set(register.map((r) => r.receiptId)).size,
        lines: register.length,
        weightKg: round(register.reduce((t, r) => t + r.weightKg, 0)),
        bags: register.reduce((t, r) => t + (r.bagCount ?? 0), 0),
        amount: opts.prices && priced.length ? round(priced.reduce((t, r) => t + (r.amount ?? 0), 0), 2) : null,
        inStockKg: round(register.reduce((t, r) => t + Math.max(0, r.inStockKg ?? 0), 0)),
        toKnittingKg: round(register.reduce((t, r) => t + (r.toKnittingKg ?? 0), 0)),
        returnedKg: round(register.reduce((t, r) => t + (r.returnedKg ?? 0), 0)),
        /** Codes still all in stock, partly used, and all used. */
        codes: {
          inStock: register.filter((r) => r.inStockKg !== null && r.inStockKg >= r.weightKg - 0.0005).length,
          partly: register.filter((r) => r.inStockKg !== null && r.inStockKg > 0.0005 && r.inStockKg < r.weightKg - 0.0005).length,
          used: register.filter((r) => r.inStockKg !== null && r.inStockKg <= 0.0005).length,
        },
        byCount: group((r) => r.count.toUpperCase()),
        byMill: group((r) => r.mill.toUpperCase()),
      },
    };
  }

  /** Mills, agents and counts used before, for the entry form's suggestions. */
  async directory() {
    const [receipts, lines, suppliers, ordered] = await Promise.all([
      this.prisma.yarnReceipt.findMany({ select: { millName: true, agentName: true }, orderBy: { receivedAt: 'desc' }, take: 500 }),
      this.prisma.yarnReceiptLine.findMany({ select: { count: true }, distinct: ['count'], take: 300 }),
      this.prisma.supplier.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
      this.prisma.purchaseOrderItem.findMany({ where: { category: 'YARN' }, select: { itemName: true }, distinct: ['itemName'], take: 300 }),
    ]);
    const unique = (values: Array<string | null | undefined>) => [...new Map(values.filter((v): v is string => !!v?.trim()).map((v) => [v.trim().toUpperCase(), v.trim()])).values()].sort((a, b) => a.localeCompare(b));
    return {
      mills: unique([...receipts.map((r) => r.millName), ...suppliers.map((s) => s.name)]),
      agents: unique(receipts.map((r) => r.agentName)),
      counts: unique([...lines.map((l) => l.count), ...ordered.map((o) => o.itemName)]),
    };
  }

  async findOne(id: string, opts: { prices: boolean }) {
    const receipt = await this.prisma.yarnReceipt.findUnique({ where: { id }, include: receiptInclude });
    if (!receipt) throw new NotFoundException('Yarn receipt not found');
    return this.view(receipt, opts);
  }

  /** Records a delivery: each count goes into the warehouse under a new yarn code, with one received challan. */
  async create(dto: YarnReceiptDto, user: AuthUser, opts: { prices: boolean }) {
    const receivedAt = new Date(dto.receivedAt);
    this.assertDate(receivedAt);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.assertWarehouse(tx, dto.warehouseId);
      const receipt = await tx.yarnReceipt.create({
        data: {
          receiptNo: await documentNo(tx, 'YR', receivedAt),
          receivedAt,
          dcNo: dto.dcNo,
          millName: dto.millName,
          agentName: agentOf(dto.agentName),
          warehouseId: dto.warehouseId,
          vehicleNo: dto.vehicleNo || null,
          notes: dto.notes || null,
          createdById: user.id,
        },
      });
      for (const line of dto.lines) await this.addLine(tx, receipt, line, user, opts);
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'YARN_RECEIVED', module: 'godown', entity: 'YarnReceipt', entityId: receipt.id, newValue: this.snapshot(dto) },
      });
      return tx.yarnReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: receiptInclude });
    });
    return this.view(created, opts);
  }

  /**
   * Corrects a delivery. Header details and bags change freely; a count's weight or the warehouse change its stock,
   * refused once that yarn has gone to knitting (only what is still in stock can be taken back). New counts get new
   * yarn codes; removed counts leave stock the same way.
   */
  async update(id: string, dto: YarnReceiptDto, user: AuthUser, opts: { prices: boolean }) {
    const receivedAt = new Date(dto.receivedAt);
    this.assertDate(receivedAt);
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.yarnReceipt.findUnique({ where: { id }, include: { lines: true } });
      if (!current) throw new NotFoundException('Yarn receipt not found');
      await this.assertWarehouse(tx, dto.warehouseId);
      const receipt = await tx.yarnReceipt.update({
        where: { id },
        data: { receivedAt, dcNo: dto.dcNo, millName: dto.millName, agentName: agentOf(dto.agentName), warehouseId: dto.warehouseId, vehicleNo: dto.vehicleNo || null, notes: dto.notes || null },
      });
      const keep = new Set(dto.lines.map((l) => l.id).filter(Boolean));
      for (const old of current.lines.filter((l) => !keep.has(l.id))) {
        if (old.stockTxnId) await this.inventory.removeInWithin(tx, old.stockTxnId, user.id);
        await tx.yarnReceiptLine.delete({ where: { id: old.id } });
      }
      for (const line of dto.lines) {
        const old = line.id ? current.lines.find((l) => l.id === line.id) : undefined;
        if (!old) {
          if (line.id) throw new BadRequestException('A count on this receipt was changed elsewhere; reload it');
          await this.addLine(tx, receipt, line, user, opts);
          continue;
        }
        const restock = Math.abs(n(old.weightKg)! - line.weightKg) > 0.0005 || current.warehouseId !== dto.warehouseId;
        if (restock && old.stockTxnId) await this.inventory.removeInWithin(tx, old.stockTxnId, user.id);
        await tx.yarnReceiptLine.update({
          where: { id: old.id },
          data: {
            count: line.count,
            bags: line.bags || null,
            bagCount: bagTotal(line.bags),
            weightKg: line.weightKg,
            dcWeightKg: line.dcWeightKg ?? null,
            ...(opts.prices ? { ratePerKg: line.ratePerKg ?? null } : {}),
            ...(restock ? { stockTxnId: (await this.stockIn(tx, receipt, old.itemCode, line, user)).id } : {}),
          },
        });
        if (!restock && old.stockTxnId) {
          await tx.stockTransaction.update({ where: { id: old.stockTxnId }, data: { itemName: line.count, createdAt: receivedAt, notes: this.note(receipt, line) } });
        }
      }
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'YARN_RECEIPT_UPDATED', module: 'godown', entity: 'YarnReceipt', entityId: id, newValue: this.snapshot(dto) },
      });
      return tx.yarnReceipt.findUniqueOrThrow({ where: { id }, include: receiptInclude });
    });
    return this.view(updated, opts);
  }

  /** Deletes a delivery entered by mistake: its yarn leaves stock, refused once any of it has been used. */
  async remove(id: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.yarnReceipt.findUnique({ where: { id }, include: { lines: true } });
      if (!current) throw new NotFoundException('Yarn receipt not found');
      for (const line of current.lines) if (line.stockTxnId) await this.inventory.removeInWithin(tx, line.stockTxnId, user.id);
      await tx.yarnReceipt.delete({ where: { id } });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'YARN_RECEIPT_DELETED', module: 'godown', entity: 'YarnReceipt', entityId: id, previousValue: { receiptNo: current.receiptNo, dcNo: current.dcNo, mill: current.millName, codes: current.lines.map((l) => l.itemCode) } },
      });
    });
    return { ok: true };
  }

  private async addLine(tx: Prisma.TransactionClient, receipt: { id: string; receivedAt: Date; dcNo: string; millName: string; agentName: string | null; warehouseId: string }, line: YarnReceiptLineDto, user: AuthUser, opts: { prices: boolean }) {
    const itemCode = await batchCode(tx, receipt.receivedAt);
    const txn = await this.stockIn(tx, receipt, itemCode, line, user);
    return tx.yarnReceiptLine.create({
      data: {
        receiptId: receipt.id,
        count: line.count,
        bags: line.bags || null,
        bagCount: bagTotal(line.bags),
        weightKg: line.weightKg,
        dcWeightKg: line.dcWeightKg ?? null,
        ratePerKg: opts.prices ? (line.ratePerKg ?? null) : null,
        itemCode,
        stockTxnId: txn.id,
      },
    });
  }

  private stockIn(tx: Prisma.TransactionClient, receipt: { id: string; receivedAt: Date; dcNo: string; millName: string; agentName: string | null; warehouseId: string }, itemCode: string, line: YarnReceiptLineDto, user: AuthUser) {
    return this.inventory.createTxn(
      {
        category: 'YARN',
        txnType: 'PURCHASE_IN',
        itemCode,
        itemName: line.count,
        warehouseId: receipt.warehouseId,
        quantityIn: line.weightKg,
        unit: 'KG',
        referenceType: YARN_RECEIPT,
        referenceId: receipt.id,
        createdById: user.id,
        notes: this.note(receipt, line),
        createdAt: receipt.receivedAt,
      },
      tx,
    );
  }

  private note(receipt: { dcNo: string; millName: string; agentName: string | null }, line: YarnReceiptLineDto) {
    const dc = line.dcWeightKg !== undefined && checkText(line.dcWeightKg, line.weightKg, 'KG');
    return [`DC ${receipt.dcNo}`, receipt.millName, receipt.agentName && `via ${receipt.agentName}`, line.bags && `${line.bags} bags`, dc && dc !== 'Matches' && `${dc} on the DC's ${line.dcWeightKg} KG`].filter(Boolean).join(' · ');
  }

  private assertDate(date: Date) {
    if (date.getTime() > Date.now() + 36 * 3_600_000) throw new BadRequestException('The received date is still to come');
  }

  private async assertWarehouse(tx: Prisma.TransactionClient, warehouseId: string) {
    const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, active: true }, select: { id: true } });
    if (!warehouse) throw new BadRequestException('Choose an active warehouse');
  }

  private snapshot(dto: YarnReceiptDto) {
    return {
      receivedAt: dto.receivedAt,
      dcNo: dto.dcNo,
      mill: dto.millName,
      agent: agentOf(dto.agentName),
      lines: dto.lines.map((l) => ({ count: l.count, bags: l.bags ?? null, weightKg: l.weightKg, dcWeightKg: l.dcWeightKg ?? null })),
    } satisfies Prisma.InputJsonObject;
  }

  /** The received challan (stock challan) each stock movement is on, by movement; cancelled ones are left out. */
  private async challansOf(txnIds: Array<string | null | undefined>) {
    const ids = [...new Set(txnIds.filter((id): id is string => !!id))];
    const txns = ids.length
      ? await this.prisma.stockTransaction.findMany({ where: { id: { in: ids } }, select: { id: true, stockBill: { select: { id: true, billNo: true, cancelledAt: true } } } })
      : [];
    return new Map(txns.flatMap((t) => (t.stockBill && !t.stockBill.cancelledAt ? [[t.id, t.stockBill] as const] : [])));
  }

  private async view(receipt: Prisma.YarnReceiptGetPayload<{ include: typeof receiptInclude }>, opts: { prices: boolean }) {
    const challans = await this.challansOf(receipt.lines.map((l) => l.stockTxnId));
    const bill = [...challans.values()][0];
    return {
      ...receipt,
      /** The delivery's received challan, to print or share. */
      challan: bill ? { id: bill.id, no: bill.billNo } : null,
      lines: receipt.lines.map((l) => ({ ...l, weightKg: n(l.weightKg)!, dcWeightKg: n(l.dcWeightKg), ratePerKg: opts.prices ? n(l.ratePerKg) : null })),
    };
  }
}
