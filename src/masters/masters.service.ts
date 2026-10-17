import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MachineStatus, MoneyTxnKind, PaymentMode, Prisma, PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cleanName, counts, nameKey, paidToDistributors, saleMoney, salePayment } from '../finance/money-rules';
import { TextileDto, UpdateTextileDto } from './dto/textile.dto';
import { lockTextiles, nextTextileCode, textileBalance, textileMoney } from './textiles';
import { SupplierDto, UpdateSupplierDto } from './dto/supplier.dto';
import { MachineDto, UpdateMachineDto } from './dto/machine.dto';
import { EmployeeDto, UpdateEmployeeDto } from './dto/employee.dto';
import { UpdateWarehouseDto, WarehouseDto } from './dto/warehouse.dto';
import { distributorCode } from '../common/numbering';
import { MACHINE_ROLES } from '../common/roles';
import { notifyRoles } from '../notifications/notify.util';
import { MillDto, UpdateMillDto } from './dto/mill.dto';

type Tx = Prisma.TransactionClient;

/** Stock under this is treated as zero (rounding left by 3-decimal quantities). */
const EMPTY = 0.0005;

/** Net quantity per unit, e.g. "1,250.500 KG · 40 CONE". */
const describeTotals = (totals: Record<string, number>) =>
  Object.entries(totals)
    .map(([unit, qty]) => `${qty.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} ${unit}`)
    .join(' · ');

const isOutageStatus = (status: MachineStatus) => status === MachineStatus.MAINTENANCE || status === MachineStatus.BREAKDOWN;

@Injectable()
export class MastersService {
  constructor(private prisma: PrismaService) {}

  /**
   * Active and inactive: suppliers are never deleted. Pickers use the procurement context, which lists active ones only.
   * Each row carries its open purchase orders, last order date and balance payable
   * (opening balance + value received − paid, as in the Supplier report).
   */
  async suppliers() {
    const [suppliers, received, paid, open, lastOrders] = await Promise.all([
      this.prisma.supplier.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      this.prisma.$queryRaw<Array<{ supplierId: string; value: number }>>`
        SELECT po."supplierId" AS "supplierId", COALESCE(SUM(ri."quantity" * poi."rate"), 0)::float8 AS "value"
        FROM "PurchaseReceiptItem" ri
        JOIN "PurchaseReceipt" pr ON pr."id" = ri."purchaseReceiptId"
        JOIN "PurchaseOrderItem" poi ON poi."id" = ri."purchaseOrderItemId"
        JOIN "PurchaseOrder" po ON po."id" = pr."purchaseOrderId"
        GROUP BY po."supplierId"`,
      paidToDistributors(this.prisma),
      this.prisma.purchaseOrder.groupBy({
        by: ['supplierId'],
        where: { status: { in: [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED] } },
        _count: { _all: true },
      }),
      this.prisma.purchaseOrder.groupBy({
        by: ['supplierId'],
        where: { status: { not: PurchaseOrderStatus.CANCELLED } },
        _max: { orderDate: true },
      }),
    ]);
    const receivedBy = new Map(received.map((row) => [row.supplierId, Number(row.value)]));
    const paidBy = new Map([...paid].map(([id, row]) => [id, row.amount]));
    const openBy = new Map(open.map((row) => [row.supplierId, row._count._all]));
    const lastBy = new Map(lastOrders.map((row) => [row.supplierId, row._max.orderDate]));
    return suppliers.map((supplier) => ({
      ...supplier,
      openPurchaseOrders: openBy.get(supplier.id) ?? 0,
      lastOrderDate: lastBy.get(supplier.id) ?? null,
      balance: Math.round((Number(supplier.openingBalance) + (receivedBy.get(supplier.id) ?? 0) - (paidBy.get(supplier.id) ?? 0)) * 100) / 100,
    }));
  }

  /** Trims text and treats a cleared opening balance as zero (the column is not nullable). */
  private supplierData(d: UpdateSupplierDto): Prisma.SupplierUpdateInput {
    const data: Record<string, unknown> = { ...d };
    for (const [key, value] of Object.entries(data)) if (typeof value === 'string') data[key] = value.trim();
    if (data.openingBalance === null) data.openingBalance = 0;
    return data;
  }

  /** The code after the highest `DST-<n>` in use, deactivated distributors included so a code is never reused. */
  async nextSupplierCode() {
    const [{ max }] = await this.prisma.$queryRaw<Array<{ max: number }>>`
      SELECT COALESCE(MAX(CAST(SUBSTRING("code" FROM 5) AS INTEGER)), 0) AS "max"
      FROM "Supplier" WHERE "code" ~* '^DST-[0-9]{1,9}$'`;
    return distributorCode(Number(max) + 1);
  }

  /**
   * One distributor's page (Supplier records): details, every purchase order with ordered / received value, goods
   * receipts, payments, and the balance payable (opening + value received - paid, as on the Distributors list).
   */
  async supplierAccount(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Distributor not found');
    const [orders, receipts, payments, receivedAll, paidAll] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: { supplierId: id },
        orderBy: { orderDate: 'desc' },
        take: 500,
        select: {
          id: true,
          poNo: true,
          orderDate: true,
          expectedDate: true,
          status: true,
          warehouse: { select: { code: true } },
          items: { select: { itemName: true, quantity: true, unit: true, rate: true, receiptItems: { select: { quantity: true } } } },
        },
      }),
      this.prisma.purchaseReceipt.findMany({
        where: { purchaseOrder: { supplierId: id } },
        orderBy: { receivedAt: 'desc' },
        take: 500,
        select: {
          id: true,
          receiptNo: true,
          receivedAt: true,
          lotNo: true,
          purchaseOrder: { select: { id: true, poNo: true } },
          warehouse: { select: { code: true } },
          items: { select: { quantity: true, purchaseOrderItem: { select: { itemName: true, unit: true, rate: true } } } },
        },
      }),
      this.prisma.moneyTransaction.findMany({
        where: { supplierId: id, kind: MoneyTxnKind.PAYMENT, cancelledAt: null },
        select: { id: true, txnNo: true, amount: true, mode: true, referenceNo: true, chequeNo: true, chequeStatus: true, cancelledAt: true, txnDate: true, account: { select: { name: true } } },
        orderBy: { txnDate: 'desc' },
        take: 500,
      }),
      this.prisma.$queryRaw<Array<{ value: number }>>`
        SELECT COALESCE(SUM(ri."quantity" * poi."rate"), 0)::float8 AS "value"
        FROM "PurchaseReceiptItem" ri
        JOIN "PurchaseReceipt" pr ON pr."id" = ri."purchaseReceiptId"
        JOIN "PurchaseOrderItem" poi ON poi."id" = ri."purchaseOrderItemId"
        JOIN "PurchaseOrder" po ON po."id" = pr."purchaseOrderId"
        WHERE po."supplierId" = ${id}`,
      paidToDistributors(this.prisma, { supplierId: id }),
    ]);
    const openingBalance = Number(supplier.openingBalance);
    const received = Number(receivedAll[0]?.value ?? 0);
    const paid = paidAll.get(id)?.amount ?? 0;
    const open: PurchaseOrderStatus[] = [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED];
    return {
      supplier,
      totals: {
        openingBalance,
        received,
        paid,
        balance: Math.round((openingBalance + received - paid) * 100) / 100,
        openOrders: orders.filter((o) => open.includes(o.status)).length,
      },
      orders: orders.map(({ items, ...order }) => {
        const ordered = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.rate), 0);
        const receivedValue = items.reduce((sum, item) => sum + item.receiptItems.reduce((s, r) => s + Number(r.quantity), 0) * Number(item.rate), 0);
        return { ...order, items: [...new Set(items.map((item) => item.itemName))], orderedValue: ordered, receivedValue };
      }),
      receipts: receipts.map(({ items, ...receipt }) => ({
        ...receipt,
        items: items.map((line) => `${line.purchaseOrderItem.itemName} ${Number(line.quantity)} ${line.purchaseOrderItem.unit}`),
        value: items.reduce((sum, line) => sum + Number(line.quantity) * Number(line.purchaseOrderItem.rate), 0),
      })),
      /** `counted` is false for a cheque that has not cleared (or bounced); only counted payments lower the balance. */
      payments: payments.map(({ txnDate, cancelledAt, account, chequeNo, ...p }) => ({
        ...p,
        paidAt: txnDate,
        referenceNo: p.mode === PaymentMode.CHEQUE ? chequeNo : p.referenceNo,
        account: account?.name ?? null,
        counted: counts({ ...p, cancelledAt }),
      })),
    };
  }

  /** Two simultaneous creates can pick the same code; the unique index rejects one and it retries with the next. */
  async createSupplier(d: SupplierDto) {
    const data = this.supplierData(d) as Omit<Prisma.SupplierCreateInput, 'code'>;
    for (let attempt = 1; ; attempt++) {
      const code = await this.nextSupplierCode();
      try {
        return await this.prisma.supplier.create({ data: { ...data, code } });
      } catch (error) {
        const codeTaken = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!codeTaken || attempt >= 5) throw error;
      }
    }
  }

  async updateSupplier(id: string, d: UpdateSupplierDto) {
    const existing = await this.prisma.supplier.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Distributor not found');
    const data = this.supplierData(d);
    if (d.code !== undefined) {
      const code = d.code.trim().toUpperCase();
      // The unique index is case-sensitive; `dst-00001` next to `DST-00001` would still be a duplicate to people.
      const clash = await this.prisma.supplier.findFirst({
        where: { id: { not: id }, code: { equals: code, mode: 'insensitive' } },
        select: { name: true, active: true },
      });
      if (clash) throw new ConflictException(`Code ${code} is already used by ${clash.name}${clash.active ? '' : ' (inactive distributor)'}`);
      data.code = code;
    }
    return this.prisma.supplier.update({ where: { id }, data });
  }

  // ───────────────────────────── Textiles ─────────────────────────────

  /** Trims text, capitalises GSTIN and treats a cleared opening balance as zero. */
  private textileData(d: UpdateTextileDto) {
    const data: Record<string, unknown> = { ...d };
    for (const [key, value] of Object.entries(data)) if (typeof value === 'string') data[key] = value.trim() || null;
    if (typeof data.gst === 'string') data.gst = data.gst.toUpperCase();
    if (data.openingBalance === null) data.openingBalance = 0;
    if (typeof d.name === 'string') {
      data.name = cleanName(d.name);
      data.nameKey = nameKey(d.name);
    }
    delete data.code;
    return data as Prisma.TextileUpdateInput;
  }

  /** Every textile (active first) with its bills, money received and balance; the same figures as the Money page. */
  async textiles() {
    const [textiles, money] = await Promise.all([
      this.prisma.textile.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      textileMoney(this.prisma),
    ]);
    return textiles.map((t) => {
      const m = money.get(t.id);
      const openingBalance = Number(t.openingBalance);
      return {
        ...t,
        openingBalance,
        creditLimit: t.creditLimit === null ? null : Number(t.creditLimit),
        billed: m?.billed ?? 0,
        bills: m?.bills ?? 0,
        received: m?.received ?? 0,
        chequesPending: m?.receiveChequesPending ?? 0,
        lastSaleAt: m?.lastSaleAt ?? null,
        lastPaidAt: m?.lastPaidAt ?? null,
        balance: textileBalance(openingBalance, m),
      };
    });
  }

  async nextTextileCode() {
    return nextTextileCode(this.prisma);
  }

  private async assertTextileNameFree(name: string, exceptId?: string) {
    const clash = await this.prisma.textile.findFirst({ where: { nameKey: nameKey(name), ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw new ConflictException(`${clash.code} · ${clash.name} already exists${clash.active ? '' : ' (inactive)'}`);
  }

  async createTextile(d: TextileDto) {
    const data = this.textileData(d) as Omit<Prisma.TextileCreateInput, 'code'>;
    return this.prisma.$transaction(async (tx) => {
      await lockTextiles(tx, d.name);
      const clash = await tx.textile.findUnique({ where: { nameKey: nameKey(d.name) } });
      if (clash) throw new ConflictException(`${clash.code} · ${clash.name} already exists${clash.active ? '' : ' (inactive)'}`);
      return tx.textile.create({ data: { ...data, code: await nextTextileCode(tx) } });
    });
  }

  async updateTextile(id: string, d: UpdateTextileDto) {
    const existing = await this.prisma.textile.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Textile not found');
    if (d.name !== undefined) await this.assertTextileNameFree(d.name, id);
    const data = this.textileData(d);
    if (d.code !== undefined) {
      const code = d.code.trim().toUpperCase();
      const clash = await this.prisma.textile.findFirst({ where: { id: { not: id }, code: { equals: code, mode: 'insensitive' } }, select: { name: true } });
      if (clash) throw new ConflictException(`Code ${code} is already used by ${clash.name}`);
      data.code = code;
    }
    const updated = await this.prisma.textile.update({ where: { id }, data });
    // Bills not yet dispatched follow a renamed textile; dispatched ones keep the name they were printed with.
    if (d.name !== undefined) {
      await this.prisma.sale.updateMany({ where: { textileId: id, status: { in: ['PENDING', 'REJECTED'] } }, data: { partyName: updated.name } });
    }
    return updated;
  }

  /**
   * One textile's page: details, its sale bills (with how much of each is paid), money received and refunded, and
   * the balance (opening + billed − received + refunded).
   */
  async textileAccount(id: string) {
    const textile = await this.prisma.textile.findUnique({ where: { id } });
    if (!textile) throw new NotFoundException('Textile not found');
    const [sales, money, entries] = await Promise.all([
      this.prisma.sale.findMany({
        where: { textileId: id },
        select: { id: true, saleNo: true, saleDate: true, status: true, totalAmount: true, dispatchedAt: true, warehouse: { select: { code: true } } },
        orderBy: { saleDate: 'desc' },
        take: 500,
      }),
      textileMoney(this.prisma, id),
      this.prisma.moneyTransaction.findMany({
        where: { textileId: id, kind: { in: [MoneyTxnKind.RECEIPT, MoneyTxnKind.PAYMENT] } },
        select: {
          id: true,
          txnNo: true,
          kind: true,
          txnDate: true,
          amount: true,
          mode: true,
          referenceNo: true,
          chequeNo: true,
          chequeStatus: true,
          cancelledAt: true,
          cancelReason: true,
          account: { select: { name: true } },
          sale: { select: { id: true, saleNo: true } },
        },
        orderBy: { txnDate: 'desc' },
        take: 500,
      }),
    ]);
    const paidOn = await saleMoney(this.prisma, sales.map((s) => s.id));
    const m = money.get(id);
    const openingBalance = Number(textile.openingBalance);
    return {
      textile: { ...textile, openingBalance, creditLimit: textile.creditLimit === null ? null : Number(textile.creditLimit) },
      totals: {
        openingBalance,
        billed: m?.billed ?? 0,
        bills: m?.bills ?? 0,
        received: m?.received ?? 0,
        chequesPending: m?.receiveChequesPending ?? 0,
        refunded: m?.refunded ?? 0,
        balance: textileBalance(openingBalance, m),
        openSales: sales.filter((s) => s.status === 'PENDING' || s.status === 'REJECTED').length,
      },
      sales: sales.map((s) => ({
        ...s,
        totalAmount: Number(s.totalAmount),
        payment: s.status === 'CANCELLED' ? null : salePayment(Number(s.totalAmount), paidOn.get(s.id)),
      })),
      money: entries.map((e) => ({ ...e, amount: Number(e.amount), counted: counts(e) })),
    };
  }

  /** Next free mill code (PC-NNN), padded to at least three digits. */
  async nextMillCode() {
    const [{ max }] = await this.prisma.$queryRaw<Array<{ max: number }>>`
      SELECT COALESCE(MAX(CAST(SUBSTRING("code" FROM 4) AS INTEGER)), 0) AS "max"
      FROM "Mill" WHERE "code" ~* '^PC-[0-9]{1,9}$'`;
    return `PC-${String(Number(max) + 1).padStart(3, '0')}`;
  }

  mills() {
    return this.prisma.mill.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] });
  }

  async createMill(d: MillDto) {
    const code = d.code.trim().toUpperCase();
    const clash = await this.prisma.mill.findFirst({ where: { OR: [{ code: { equals: code, mode: 'insensitive' } }, { name: { equals: d.name.trim(), mode: 'insensitive' } }] } });
    if (clash) throw new ConflictException(`${clash.code} · ${clash.name} already exists`);
    return this.prisma.mill.create({ data: { ...d, code, name: d.name.trim() } });
  }

  async updateMill(id: string, d: UpdateMillDto) {
    const existing = await this.prisma.mill.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Mill not found');
    const code = d.code?.trim().toUpperCase();
    if (code) {
      const clash = await this.prisma.mill.findFirst({ where: { id: { not: id }, code: { equals: code, mode: 'insensitive' } } });
      if (clash) throw new ConflictException(`Code ${code} is already used by ${clash.name}`);
    }
    return this.prisma.mill.update({ where: { id }, data: { ...d, ...(code ? { code } : {}), ...(d.name ? { name: d.name.trim() } : {}) } });
  }

  /**
   * One mill's page: its details and every production job it did. Batches name their mills as text (party / mill
   * per process), so a job is a batch whose knitting, dyeing or compacting party or mill is this mill's name.
   */
  async millAccount(id: string) {
    const mill = await this.prisma.mill.findUnique({ where: { id } });
    if (!mill) throw new NotFoundException('Mill not found');
    const is = { equals: mill.name.trim(), mode: 'insensitive' as const };
    const batches = await this.prisma.fabricProductionFlow.findMany({
      where: {
        OR: [
          { knittingPartyDetails: is }, { knittingMillDetails: is },
          { dyeingPartyDetails: is }, { dyeingMillDetails: is },
          { compactingPartyDetails: is }, { compactingMillDetails: is },
        ],
      },
      orderBy: { purchaseDate: 'desc' },
      take: 500,
    });
    const same = (value: string | null) => !!value && value.trim().toLowerCase() === mill.name.trim().toLowerCase();
    const n = (value: Prisma.Decimal | null) => (value === null ? null : Number(value));
    const jobs = batches.flatMap((b) => {
      const base = { batchId: b.id, flowNo: b.flowNo, status: b.status, yarnCount: b.yarnCount, fabricType: b.fabricType, color: b.color };
      const rows = [];
      if (same(b.knittingPartyDetails) || same(b.knittingMillDetails)) {
        rows.push({ ...base, process: 'KNITTING', startedAt: b.knittingDate, finishedAt: b.knittingFinishedAt, inKg: n(b.yarnReceivedKg) ?? Number(b.purchasedWeightKg), outKg: n(b.knittingDeliveryKg), expense: Number(b.knittingExpense) });
      }
      if (same(b.dyeingPartyDetails) || same(b.dyeingMillDetails)) {
        rows.push({ ...base, process: 'DYEING', startedAt: b.dyeingDate, finishedAt: b.dyeingFinishedAt, inKg: n(b.fabricReceivedKg), outKg: n(b.dyeingOutputWeightKg), expense: Number(b.dyeingExpense) });
      }
      if (same(b.compactingPartyDetails) || same(b.compactingMillDetails)) {
        rows.push({ ...base, process: 'COMPACTING', startedAt: b.compactingDate, finishedAt: b.compactingFinishedAt, inKg: n(b.compactingReceivedKg), outKg: n(b.officeDeliveryKg), expense: Number(b.compactingExpense) });
      }
      return rows;
    });
    return { mill, jobs };
  }

  async deleteMill(id: string) {
    const mill = await this.prisma.mill.findUnique({ where: { id } });
    if (!mill) throw new NotFoundException('Mill not found');
    const used = await this.prisma.fabricProductionFlow.count({ where: { OR: [
      { knittingPartyDetails: { equals: mill.name, mode: 'insensitive' } }, { knittingMillDetails: { equals: mill.name, mode: 'insensitive' } },
      { dyeingPartyDetails: { equals: mill.name, mode: 'insensitive' } }, { dyeingMillDetails: { equals: mill.name, mode: 'insensitive' } },
      { compactingPartyDetails: { equals: mill.name, mode: 'insensitive' } }, { compactingMillDetails: { equals: mill.name, mode: 'insensitive' } },
    ] } });
    if (used) throw new ConflictException(`${mill.name} is used by ${used} production batch${used === 1 ? '' : 'es'}. Deactivate it instead.`);
    return this.prisma.mill.delete({ where: { id } });
  }

  machines() {
    return this.prisma.machine.findMany({
      where: { status: { not: MachineStatus.DISABLED } },
      include: { operator: true },
      orderBy: { code: 'asc' },
    });
  }

  createMachine(d: MachineDto) {
    return this.prisma.$transaction(async (tx) => {
      // Every machine is a knitting machine taking a 240 KG load unless it says otherwise.
      const created = await tx.machine.create({ data: { ...d, department: d.department ?? 'Knitting', capacityKg: d.capacityKg ?? 240 } });
      if (isOutageStatus(created.status)) await this.notifyOutage(tx, created, created.status);
      return created;
    });
  }

  updateMachine(id: string, d: UpdateMachineDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.machine.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Machine not found');
      const updated = await tx.machine.update({ where: { id }, data: d });
      if (existing.status !== updated.status) {
        if (isOutageStatus(updated.status)) await this.notifyOutage(tx, updated, updated.status);
        else if (isOutageStatus(existing.status)) await this.notifyOutageOver(tx, updated, 'Machine back in service');
      }
      return updated;
    });
  }

  deleteMachine(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.machine.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Machine not found');
      const updated = await tx.machine.update({ where: { id }, data: { status: MachineStatus.DISABLED } });
      if (isOutageStatus(existing.status)) await this.notifyOutageOver(tx, updated, 'Machine disabled');
      return updated;
    });
  }

  /** Tells machine managers a machine has broken down or gone for servicing. */
  private notifyOutage(tx: Tx, machine: { id: string; code: string; name: string }, status: MachineStatus) {
    const isBreakdown = status === MachineStatus.BREAKDOWN;
    return notifyRoles(tx, MACHINE_ROLES, {
      title: isBreakdown ? 'Machine breakdown reported' : 'Machine sent for maintenance',
      message: `${machine.code} • ${machine.name}`,
      type: isBreakdown ? 'MACHINE_BREAKDOWN' : 'MAINTENANCE_DUE',
      priority: isBreakdown ? 'CRITICAL' : 'HIGH',
      referenceType: 'Machine',
      referenceId: machine.id,
    });
  }

  /** Tells machine managers a machine that was down is no longer broken down or being serviced. */
  private notifyOutageOver(tx: Tx, machine: { id: string; code: string }, title: string) {
    return notifyRoles(tx, MACHINE_ROLES, {
      title,
      message: `${machine.code} is no longer under maintenance or breakdown`,
      type: 'SYSTEM',
      referenceType: 'Machine',
      referenceId: machine.id,
    });
  }

  async machineStats() {
    const grouped = await this.prisma.machine.groupBy({ by: ['status'], _count: { _all: true } });
    const count = (status: MachineStatus) => grouped.find((g) => g.status === status)?._count._all || 0;
    const total = grouped.reduce((sum, g) => sum + g._count._all, 0);
    return {
      total,
      running: count(MachineStatus.RUNNING),
      idle: count(MachineStatus.IDLE),
      maintenance: count(MachineStatus.MAINTENANCE),
      breakdown: count(MachineStatus.BREAKDOWN),
      disabled: count(MachineStatus.DISABLED),
    };
  }

  /** Active and inactive, with the login each one is linked to. Employees are never deleted. */
  employees() {
    return this.prisma.employee.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { user: { select: { id: true, name: true, email: true, status: true } } },
    });
  }

  /** Next free EMP-NNN code, padded to at least three digits; inactive employees count so a code is never reused. */
  async nextEmployeeCode() {
    const [{ max }] = await this.prisma.$queryRaw<Array<{ max: number }>>`
      SELECT COALESCE(MAX(CAST(SUBSTRING("code" FROM 5) AS INTEGER)), 0) AS "max"
      FROM "Employee" WHERE "code" ~* '^EMP-[0-9]{1,9}$'`;
    return `EMP-${String(Number(max) + 1).padStart(3, '0')}`;
  }

  /** Trims text, upper-cases the code and turns the joining date into a Date (null clears it). */
  private employeeData(d: UpdateEmployeeDto) {
    return {
      ...d,
      ...(d.code !== undefined ? { code: d.code.trim().toUpperCase() } : {}),
      ...(d.name !== undefined ? { name: d.name.trim() } : {}),
      ...(d.department !== undefined ? { department: d.department.trim() } : {}),
      ...(d.joiningDate !== undefined ? { joiningDate: d.joiningDate ? new Date(d.joiningDate) : null } : {}),
    };
  }

  /** The unique index is case-sensitive; `emp-001` next to `EMP-001` would still be a duplicate to people. */
  private async assertEmployeeCodeFree(code: string, exceptId?: string) {
    const clash = await this.prisma.employee.findFirst({
      where: { code: { equals: code, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { name: true, active: true },
    });
    if (clash) throw new ConflictException(`Code ${code} is already used by ${clash.name}${clash.active ? '' : ' (inactive employee)'}`);
  }

  /** One employee's page: details, the login linked to them, and the knitting runs they operated. */
  async employeeAccount(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, email: true, role: true, status: true, createdAt: true } } },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    const runs = await this.prisma.knittingRun.findMany({
      where: { operatorId: id },
      orderBy: { startedAt: 'desc' },
      take: 500,
      select: {
        id: true,
        runNo: true,
        status: true,
        fabricType: true,
        startedAt: true,
        startShift: true,
        finishedAt: true,
        finishShift: true,
        yarnKg: true,
        outputKg: true,
        rollCount: true,
        machine: { select: { id: true, code: true, name: true } },
      },
    });
    return {
      employee,
      runs: runs.map((run) => ({ ...run, yarnKg: Number(run.yarnKg), outputKg: run.outputKg === null ? null : Number(run.outputKg) })),
    };
  }

  async createEmployee(d: EmployeeDto) {
    const data = this.employeeData(d) as Prisma.EmployeeCreateInput;
    await this.assertEmployeeCodeFree(data.code);
    return this.prisma.employee.create({ data });
  }

  async updateEmployee(id: string, d: UpdateEmployeeDto) {
    const existing = await this.prisma.employee.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundException('Employee not found');
    const data = this.employeeData(d);
    if (data.code) await this.assertEmployeeCodeFree(data.code, id);
    return this.prisma.employee.update({ where: { id }, data });
  }

  warehouses() {
    return this.prisma.warehouse.findMany({ orderBy: { code: 'asc' } });
  }

  /**
   * Stock positions (item code + lot + unit) of one or every warehouse, with their net balance.
   * Movements of one item code typed with different names ("Yarn" / "yarn") count as one position.
   */
  private async stockPositions(warehouseId?: string) {
    const groups = await this.prisma.stockTransaction.groupBy({
      by: ['warehouseId', 'category', 'itemCode', 'itemName', 'lotNo', 'unit'],
      where: warehouseId ? { warehouseId } : {},
      _sum: { quantityIn: true, quantityOut: true },
    });
    const positions = new Map<string, Omit<(typeof groups)[number], '_sum'> & { balance: number }>();
    for (const { _sum, ...group } of groups) {
      const key = [group.warehouseId, group.category, group.itemCode, group.lotNo, group.unit].join('|');
      const balance = Number(_sum.quantityIn ?? 0) - Number(_sum.quantityOut ?? 0);
      const existing = positions.get(key);
      if (existing) existing.balance += balance;
      else positions.set(key, { ...group, balance });
    }
    return [...positions.values()].filter((position) => Math.abs(position.balance) > EMPTY);
  }

  /**
   * Every warehouse with the stock it holds now (net, per unit) and how many items make it up.
   * `used` says whether it has any history: only an unused warehouse can be deleted.
   */
  async warehouseSummary() {
    const [warehouses, positions, incoming, incomingFabric] = await Promise.all([
      this.prisma.warehouse.findMany({
        orderBy: [{ active: 'desc' }, { code: 'asc' }],
        include: { _count: { select: { stockTxns: true, purchaseReceipts: true, purchaseOrders: true } } },
      }),
      this.stockPositions(),
      // Open purchase orders on their way to each warehouse.
      this.prisma.purchaseOrder.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { not: null }, status: { in: [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED] } },
        _count: { _all: true },
      }),
      // Fabric sent from production that each warehouse has not received yet.
      this.prisma.fabricFlowDelivery.groupBy({
        by: ['warehouseId'],
        where: { warehouseId: { not: null }, destination: 'WAREHOUSE', receivedAt: null },
        _count: { _all: true },
      }),
    ]);
    const incomingBy = new Map(incoming.map((row) => [row.warehouseId, row._count._all]));
    for (const row of incomingFabric) incomingBy.set(row.warehouseId, (incomingBy.get(row.warehouseId) ?? 0) + row._count._all);
    return warehouses.map(({ _count, ...warehouse }) => {
      const held = positions.filter((p) => p.warehouseId === warehouse.id);
      const totals: Record<string, number> = {};
      /** The same per material, e.g. { YARN: { KG: 2000 } }. */
      const byCategory: Record<string, Record<string, number>> = {};
      for (const p of held) {
        totals[p.unit] = (totals[p.unit] ?? 0) + p.balance;
        const material = (byCategory[p.category] ??= {});
        material[p.unit] = (material[p.unit] ?? 0) + p.balance;
      }
      return {
        ...warehouse,
        totals,
        byCategory,
        itemCount: held.length,
        incomingOrders: incomingBy.get(warehouse.id) ?? 0,
        used: _count.stockTxns + _count.purchaseReceipts + _count.purchaseOrders > 0,
      };
    });
  }

  /** What one warehouse holds now, item by item and lot by lot. */
  async warehouseStock(id: string) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    const items = (await this.stockPositions(id))
      .map(({ warehouseId: _, ...position }) => position)
      .sort((a, b) => a.category.localeCompare(b.category) || a.itemName.localeCompare(b.itemName) || (a.lotNo ?? '').localeCompare(b.lotNo ?? ''));
    return { warehouse, items };
  }

  async createWarehouse(d: WarehouseDto) {
    const code = d.code.trim().toUpperCase();
    const clash = await this.prisma.warehouse.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, select: { name: true } });
    if (clash) throw new ConflictException(`Code ${code} is already used by ${clash.name}`);
    return this.prisma.warehouse.create({ data: { code, name: d.name.trim(), location: d.location?.trim() || null } });
  }

  async updateWarehouse(id: string, d: UpdateWarehouseDto) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    if (d.active === false && warehouse.active) {
      // Stock left in an inactive warehouse could no longer be issued or moved.
      const held = (await this.warehouseSummary()).find((w) => w.id === id);
      if (held?.itemCount) {
        throw new BadRequestException(
          `${warehouse.code} still holds ${describeTotals(held.totals)} in ${held.itemCount} item(s). Move or issue that stock before deactivating it.`,
        );
      }
      // Material on its way there could not be received into an inactive warehouse.
      if (held?.incomingOrders) {
        throw new BadRequestException(
          `${held.incomingOrders} delivery(ies) from purchases or production are still on their way to ${warehouse.code}. Receive, close or cancel them before deactivating it.`,
        );
      }
    }
    return this.prisma.warehouse.update({
      where: { id },
      data: {
        name: d.name?.trim(),
        ...(d.location !== undefined ? { location: d.location?.trim() || null } : {}),
        active: d.active,
      },
    });
  }

  /**
   * Only a warehouse that never held stock, took a receipt or had a purchase order sent to it;
   * otherwise deactivate it so its history stays readable.
   */
  async deleteWarehouse(id: string) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id },
      include: { _count: { select: { stockTxns: true, purchaseReceipts: true, purchaseOrders: true } } },
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    const { stockTxns, purchaseReceipts, purchaseOrders } = warehouse._count;
    if (stockTxns || purchaseReceipts || purchaseOrders) {
      throw new ConflictException(
        `${warehouse.code} has history (${stockTxns} stock movement(s), ${purchaseReceipts} goods receipt(s), ${purchaseOrders} purchase order(s)). Deactivate it instead.`,
      );
    }
    await this.prisma.warehouse.delete({ where: { id } });
    return { deleted: true };
  }
}
