import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, SalePartyType, SaleStatus } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { lockKeys } from '../common/locks';
import { documentNo } from '../common/numbering';
import { ADMIN_ROLES } from '../common/roles';
import { itemSpecs } from '../common/item-specs';
import { saleMoney, salePayment } from '../finance/money-rules';
import { resolveTextile } from '../masters/textiles';
import { InventoryService } from '../inventory/inventory.service';
import { linesText, MANAGEMENT_ROLES, notifyRoles, settleReminders } from '../notifications/notify.util';
import { PrismaService } from '../prisma/prisma.service';
import { DispatchSaleDto, RejectSaleDto, SaleDto } from './dto/sale.dto';

const EMPTY = 0.0005;
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const blank = (value?: string | null) => value?.trim() || null;
/** Same stock position: item, lot and unit. */
const positionKey = (i: { itemCode: string; lotNo?: string | null; unit: string }) => [i.itemCode.trim(), i.lotNo?.trim() || '', i.unit.trim().toUpperCase()].join('|');

const saleInclude = {
  items: { orderBy: { itemCode: 'asc' as const } },
  warehouse: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
  textile: { select: { id: true, code: true, name: true } },
} satisfies Prisma.SaleInclude;
type SaleWithItems = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

/**
 * Sales to distributors or textiles. Admin enters the sale (party, warehouse, items, vehicle) and gets the bill
 * number; the warehouse is notified, and its staff verify what is loaded and dispatch it, which takes the stock
 * out, or send it back with what is wrong.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /** Warehouse staff see what to load, not prices or payments. */
  private view(sale: SaleWithItems, user: AuthUser, money?: Map<string, { received: number; pending: number }>) {
    const prices = ADMIN_ROLES.includes(user.role);
    return {
      ...sale,
      subtotal: prices ? sale.subtotal : null,
      gstAmount: prices ? sale.gstAmount : null,
      totalAmount: prices ? sale.totalAmount : null,
      items: sale.items.map((item) => ({ ...item, rate: prices ? item.rate : null, amount: prices ? item.amount : null })),
      payment: prices && money && sale.status !== SaleStatus.CANCELLED ? salePayment(Number(sale.totalAmount), money.get(sale.id)) : null,
    };
  }

  /** Money received on these bills (admins only). */
  private async money(sales: Array<{ id: string }>, user: AuthUser) {
    return ADMIN_ROLES.includes(user.role) ? saleMoney(this.prisma, sales.map((s) => s.id)) : undefined;
  }

  /** Names of the users who created and verified a sale. */
  private async people(sale: { createdById: string | null; verifiedById: string | null }) {
    const ids = [sale.createdById, sale.verifiedById].filter((id): id is string => !!id);
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
    return { createdBy: name(sale.createdById), verifiedBy: name(sale.verifiedById) };
  }

  async list(user: AuthUser) {
    const sales = await this.prisma.sale.findMany({ include: saleInclude, orderBy: { createdAt: 'desc' }, take: 500 });
    const money = await this.money(sales, user);
    return sales.map((sale) => this.view(sale, user, money));
  }

  /** Active distributors, textiles and warehouses to pick from (with each party's details for the bill). */
  async context() {
    const party = { id: true, code: true, name: true, gst: true, mobile: true, address: true } as const;
    const [distributors, textiles, warehouses] = await Promise.all([
      this.prisma.supplier.findMany({ where: { active: true }, select: party, orderBy: { name: 'asc' } }),
      this.prisma.textile.findMany({ where: { active: true }, select: { ...party, city: true }, orderBy: { name: 'asc' } }),
      this.prisma.warehouse.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
    ]);
    return { distributors, textiles, warehouses };
  }

  async findOne(id: string, user: AuthUser) {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: saleInclude });
    if (!sale) throw new NotFoundException('Sale not found');
    const [money, people, specs] = await Promise.all([this.money([sale], user), this.people(sale), itemSpecs(this.prisma, sale.items.map((i) => i.itemCode))]);
    const view = this.view(sale, user, money);
    // Each item's full details (fabric type, dia, GSM, GG, LL, colour… or the yarn's distributor and PO) for the bill.
    return { ...view, items: view.items.map((item) => ({ ...item, specs: specs.get(item.itemCode) ?? [] })), ...people };
  }

  /** The office's register of delivery challans (dispatched sales), newest first, optionally within dates. */
  async deliveryChallans(from?: Date, to?: Date) {
    const sales = await this.prisma.sale.findMany({
      where: {
        status: SaleStatus.DISPATCHED,
        ...(from || to ? { dispatchedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      include: { items: { orderBy: { itemCode: 'asc' } }, warehouse: { select: { code: true, name: true } } },
      orderBy: { dispatchedAt: 'desc' },
      take: 2000,
    });
    const ids = [...new Set(sales.map((s) => s.verifiedById).filter((id): id is string => !!id))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    return sales.map((s) => ({
      id: s.id,
      challanNo: s.challanNo ?? s.saleNo,
      saleNo: s.saleNo,
      dispatchedAt: s.dispatchedAt,
      partyType: s.partyType,
      partyName: s.partyName,
      warehouse: s.warehouse,
      vehicleNo: s.vehicleNo,
      driverName: s.driverName,
      transporter: s.transporter,
      lrNo: s.lrNo,
      verifiedBy: (s.verifiedById && nameOf.get(s.verifiedById)) || null,
      items: s.items
        .filter((item) => Number(item.dispatchedQty ?? 0) > EMPTY)
        .map((item) => ({ itemName: item.itemName, itemCode: item.itemCode, unit: item.unit, quantity: Number(item.dispatchedQty) })),
      total: Number(s.totalAmount),
    }));
  }

  /**
   * The delivery challan of a dispatched sale, ready to print: letterhead, consignee, the warehouse it left, vehicle,
   * driver, transporter and LR, and each line as sold and as actually sent. Rates and values only for admins.
   */
  async deliveryChallan(id: string, user: AuthUser) {
    const sale = await this.prisma.sale.findUnique({
      where: { id },
      include: {
        items: { orderBy: { itemCode: 'asc' } },
        warehouse: { select: { id: true, code: true, name: true, location: true } },
        supplier: { select: { code: true } },
        textile: { select: { code: true } },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    if (sale.status !== SaleStatus.DISPATCHED) {
      throw new BadRequestException(`${sale.saleNo} is ${sale.status.toLowerCase()}: a delivery challan is made when the warehouse dispatches it`);
    }
    const [people, company, specs] = await Promise.all([
      this.people(sale),
      this.prisma.systemSetting.findUnique({ where: { key: 'company' } }),
      itemSpecs(
        this.prisma,
        sale.items.map((i) => i.itemCode),
      ),
    ]);
    const prices = ADMIN_ROLES.includes(user.role);
    const lines = sale.items.map((item) => {
      const quantity = Number(item.dispatchedQty ?? 0);
      return {
        id: item.id,
        category: item.category,
        itemCode: item.itemCode,
        itemName: item.itemName,
        lotNo: item.lotNo,
        unit: item.unit,
        sold: Number(item.quantity),
        quantity,
        rate: prices ? Number(item.rate) : null,
        amount: prices ? Number(item.amount) : null,
        specs: specs.get(item.itemCode) ?? [],
      };
    });
    return {
      id: sale.id,
      challanNo: sale.challanNo ?? sale.saleNo,
      saleNo: sale.saleNo,
      saleDate: sale.saleDate,
      dispatchedAt: sale.dispatchedAt,
      partyType: sale.partyType,
      party: {
        code: sale.supplier?.code ?? sale.textile?.code ?? null,
        name: sale.partyName,
        gst: sale.partyGst,
        phone: sale.partyPhone,
        address: sale.partyAddress,
      },
      warehouse: sale.warehouse,
      vehicleNo: sale.vehicleNo,
      driverName: sale.driverName,
      driverPhone: sale.driverPhone,
      transporter: sale.transporter,
      lrNo: sale.lrNo,
      dispatchNotes: sale.dispatchNotes,
      verifiedBy: people.verifiedBy,
      lines,
      gstRate: Number(sale.gstRate),
      subtotal: prices ? Number(sale.subtotal) : null,
      gstAmount: prices ? Number(sale.gstAmount) : null,
      total: prices ? Number(sale.totalAmount) : null,
      pricesShown: prices,
      company: (company?.value ?? {}) as Record<string, string>,
    };
  }

  /** Sales waiting for a warehouse to verify and dispatch, oldest first. */
  async outgoing(warehouseId: string, user: AuthUser) {
    const sales = await this.prisma.sale.findMany({
      where: { warehouseId, status: SaleStatus.PENDING },
      include: saleInclude,
      orderBy: { createdAt: 'asc' },
    });
    return sales.map((sale) => this.view(sale, user));
  }

  /** Sales dispatched from a warehouse, newest first, optionally within dates: what was sold from there. */
  async dispatchedFrom(warehouseId: string, user: AuthUser, from?: Date, to?: Date) {
    const sales = await this.prisma.sale.findMany({
      where: {
        warehouseId,
        status: SaleStatus.DISPATCHED,
        ...(from || to ? { dispatchedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      include: saleInclude,
      orderBy: { dispatchedAt: 'desc' },
      take: 500,
    });
    return sales.map((sale) => this.view(sale, user));
  }

  /** Checks the party, warehouse and lines, and works out the bill. Stock is checked again, locked, on dispatch. */
  private async prepare(dto: SaleDto) {
    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, active: true }, select: { id: true, code: true } });
    if (!warehouse) throw new BadRequestException('Choose an active warehouse');

    const distributor = dto.partyType === SalePartyType.DISTRIBUTOR ? await this.prisma.supplier.findFirst({ where: { id: dto.supplierId, active: true } }) : null;
    if (dto.partyType === SalePartyType.DISTRIBUTOR && !distributor) throw new BadRequestException('Choose an active distributor');

    const keys = dto.items.map(positionKey);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('The same item and lot is listed twice; put all of it on one line');
    const stock = await this.inventory.balance({ warehouseId: warehouse.id });
    for (const item of dto.items) {
      const held = stock
        .filter((row) => positionKey({ itemCode: row.itemCode, lotNo: row.lotNo, unit: row.unit }) === positionKey(item))
        .reduce((sum, row) => sum + row.balanceKg, 0);
      if (item.quantity > held + EMPTY) {
        const lot = item.lotNo ? ` lot ${item.lotNo}` : '';
        throw new BadRequestException(`Only ${Math.max(held, 0).toFixed(3)} ${item.unit} of ${item.itemCode}${lot} is in ${warehouse.code}`);
      }
    }

    // The party, once everything else is right (so a new textile is added to the list only for a sale that saves).
    // Details typed on the sale win for the bill; otherwise they come from the distributor / textile.
    let party: { supplierId: string | null; textileId: string | null; partyName: string; partyGst: string | null; partyPhone: string | null; partyAddress: string | null };
    if (distributor) {
      party = {
        supplierId: distributor.id,
        textileId: null,
        partyName: distributor.name,
        partyGst: blank(dto.partyGst)?.toUpperCase() ?? distributor.gst,
        partyPhone: blank(dto.partyPhone) ?? distributor.mobile,
        partyAddress: blank(dto.partyAddress) ?? distributor.address,
      };
    } else {
      const textile = await resolveTextile(
        this.prisma,
        { textileId: dto.textileId, name: dto.partyName, gst: dto.partyGst, phone: dto.partyPhone, address: dto.partyAddress },
        { requireActive: true },
      );
      party = {
        supplierId: null,
        textileId: textile.id,
        partyName: textile.name,
        partyGst: blank(dto.partyGst)?.toUpperCase() ?? textile.gst,
        partyPhone: blank(dto.partyPhone) ?? textile.mobile,
        partyAddress: blank(dto.partyAddress) ?? textile.address,
      };
    }

    const items = dto.items.map((item) => ({
      category: item.category,
      itemCode: item.itemCode.trim(),
      itemName: item.itemName.trim(),
      lotNo: blank(item.lotNo),
      unit: item.unit.trim().toUpperCase(),
      quantity: item.quantity,
      rate: item.rate,
      amount: round(item.quantity * item.rate, 2),
    }));
    const subtotal = round(items.reduce((sum, item) => sum + item.amount, 0), 2);
    const gstAmount = round((subtotal * dto.gstRate) / 100, 2);
    return {
      warehouse,
      data: {
        saleDate: new Date(dto.saleDate),
        partyType: dto.partyType,
        ...party,
        warehouseId: warehouse.id,
        vehicleNo: blank(dto.vehicleNo)?.toUpperCase() ?? null,
        driverName: blank(dto.driverName),
        driverPhone: blank(dto.driverPhone),
        transporter: blank(dto.transporter),
        lrNo: blank(dto.lrNo),
        gstRate: dto.gstRate,
        subtotal,
        gstAmount,
        totalAmount: round(subtotal + gstAmount, 2),
        notes: blank(dto.notes),
      },
      items,
    };
  }

  /** Tells the godown staff (and the other admins) there is material to load; an updated sale replaces the old reminder. */
  private async notifyWarehouse(tx: Prisma.TransactionClient, sale: { id: string; saleNo: string; partyName: string; vehicleNo: string | null }, warehouseCode: string, userId: string, again = false) {
    if (again) await settleReminders(tx, 'Sale', sale.id);
    return notifyRoles(
      tx,
      [Role.STAFF, ...MANAGEMENT_ROLES],
      {
        title: `${again ? 'Sale updated' : 'Material to dispatch'} from ${warehouseCode}`,
        message: `${sale.saleNo} for ${sale.partyName}${sale.vehicleNo ? ` · vehicle ${sale.vehicleNo}` : ''}. Verify and dispatch it on the Warehouses page.`,
        type: 'DELIVERY_DUE',
        priority: 'HIGH',
        referenceType: 'Sale',
        referenceId: sale.id,
      },
      userId,
    );
  }

  async create(dto: SaleDto, user: AuthUser) {
    const { warehouse, data, items } = await this.prepare(dto);
    const created = await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.create({
        data: { ...data, saleNo: await documentNo(tx, 'SAL', data.saleDate), createdById: user.id, items: { create: items } },
        include: saleInclude,
      });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'SALE_CREATED', module: 'sales', entity: 'Sale', entityId: sale.id, newValue: { saleNo: sale.saleNo, party: sale.partyName, warehouse: warehouse.code, total: Number(sale.totalAmount) } },
      });
      await this.notifyWarehouse(tx, sale, warehouse.code, user.id);
      return sale;
    });
    return this.view(created, user);
  }

  /** A sale not yet dispatched can be corrected (e.g. after the warehouse sent it back); it goes to the warehouse again. */
  async update(id: string, dto: SaleDto, user: AuthUser) {
    const current = await this.prisma.sale.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Sale not found');
    if (current.status !== SaleStatus.PENDING && current.status !== SaleStatus.REJECTED) {
      throw new BadRequestException(`${current.saleNo} is ${current.status.toLowerCase()} and can't be changed`);
    }
    const { warehouse, data, items } = await this.prepare(dto);
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `sale:${id}`);
      const fresh = await tx.sale.findUniqueOrThrow({ where: { id } });
      if (fresh.status !== SaleStatus.PENDING && fresh.status !== SaleStatus.REJECTED) throw new BadRequestException(`${fresh.saleNo} was dispatched meanwhile`);
      // Money already received on the bill belongs to its party; it can't move to someone else with the bill.
      const samePartyType = fresh.partyType === data.partyType;
      const sameParty = samePartyType && (data.partyType === SalePartyType.DISTRIBUTOR ? fresh.supplierId === data.supplierId : fresh.textileId === data.textileId);
      if (!sameParty && (await tx.moneyTransaction.count({ where: { saleId: id, cancelledAt: null } }))) {
        throw new BadRequestException(`Money is already received on ${fresh.saleNo} from ${fresh.partyName}, so the party can't change. Cancel those receipts on the Money page first.`);
      }
      await tx.saleItem.deleteMany({ where: { saleId: id } });
      const sale = await tx.sale.update({
        where: { id },
        data: { ...data, status: SaleStatus.PENDING, rejectReason: null, verifiedById: null, items: { create: items } },
        include: saleInclude,
      });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'SALE_UPDATED', module: 'sales', entity: 'Sale', entityId: id, previousValue: { status: fresh.status, total: Number(fresh.totalAmount) }, newValue: { total: Number(sale.totalAmount) } },
      });
      await this.notifyWarehouse(tx, sale, warehouse.code, user.id, true);
      return sale;
    });
    return this.view(updated, user);
  }

  async cancel(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `sale:${id}`);
      const sale = await tx.sale.findUnique({ where: { id }, include: { warehouse: { select: { code: true } } } });
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.status === SaleStatus.DISPATCHED) throw new BadRequestException(`${sale.saleNo} has already left ${sale.warehouse.code}`);
      if (sale.status === SaleStatus.CANCELLED) return sale;
      const updated = await tx.sale.update({ where: { id }, data: { status: SaleStatus.CANCELLED } });
      // Money already received stays with the party as an advance (on account), no longer against this bill.
      const moved = await tx.moneyTransaction.updateMany({
        where: { saleId: id, cancelledAt: null },
        data: { saleId: null, notes: `Was against ${sale.saleNo}, which was cancelled; now on account` },
      });
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'SALE_CANCELLED', module: 'sales', entity: 'Sale', entityId: id, previousValue: { status: sale.status }, newValue: moved.count ? { receiptsMovedOnAccount: moved.count } : undefined },
      });
      await settleReminders(tx, 'Sale', id);
      if (sale.status === SaleStatus.PENDING) {
        await notifyRoles(tx, [Role.STAFF], { title: `Sale cancelled · ${sale.warehouse.code}`, message: `${sale.saleNo} for ${sale.partyName} was cancelled; don't load it.`, type: 'SYSTEM', referenceType: 'Sale', referenceId: id }, user.id);
      }
      return updated;
    });
  }

  /**
   * The warehouse verifies and dispatches: each line's loaded quantity (up to what was sold) leaves stock, the bill
   * is worked out again on what was loaded, and the vehicle is updated as it left.
   */
  async dispatch(id: string, dto: DispatchSaleDto, user: AuthUser) {
    const sale = await this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `sale:${id}`);
      const current = await tx.sale.findUnique({ where: { id }, include: { items: true, warehouse: { select: { code: true } } } });
      if (!current) throw new NotFoundException('Sale not found');
      if (current.status !== SaleStatus.PENDING) throw new BadRequestException(`${current.saleNo} is ${current.status.toLowerCase()}, not waiting to be dispatched`);
      const loaded = new Map(dto.items.map((line) => [line.id, line.quantity]));
      if (current.items.some((item) => !loaded.has(item.id))) throw new BadRequestException('Give the loaded quantity of every line (0 for a line left out)');
      for (const item of current.items) {
        if (loaded.get(item.id)! > Number(item.quantity) + EMPTY) {
          throw new BadRequestException(`${item.itemCode}: at most ${Number(item.quantity).toFixed(3)} ${item.unit} was sold`);
        }
      }
      if (![...loaded.values()].some((qty) => qty > EMPTY)) throw new BadRequestException('Nothing is loaded; send the sale back instead');

      let subtotal = 0;
      for (const item of current.items) {
        const qty = round(loaded.get(item.id)!, 3);
        let stockTxnId: string | null = null;
        if (qty > EMPTY) {
          const txn = await this.inventory.issueWithin(tx, {
            category: item.category,
            txnType: 'DISPATCH_OUT',
            itemCode: item.itemCode,
            itemName: item.itemName,
            lotNo: item.lotNo ?? undefined,
            warehouseId: current.warehouseId,
            quantityOut: qty,
            unit: item.unit,
            referenceType: 'SALE',
            referenceId: current.id,
            createdById: user.id,
            notes: `${current.saleNo} · ${current.partyName}`,
          });
          stockTxnId = txn.id;
        }
        const amount = round(qty * Number(item.rate), 2);
        subtotal += amount;
        await tx.saleItem.update({ where: { id: item.id }, data: { dispatchedQty: qty, amount, stockTxnId } });
      }
      subtotal = round(subtotal, 2);
      const gstAmount = round((subtotal * Number(current.gstRate)) / 100, 2);
      const vehicle = (value: string | undefined, fallback: string | null) => (value === undefined ? fallback : blank(value));
      const dispatchedAt = new Date();
      const updated = await tx.sale.update({
        where: { id },
        data: {
          status: SaleStatus.DISPATCHED,
          // The delivery challan that goes with the vehicle gets its own number.
          challanNo: await documentNo(tx, 'DC', dispatchedAt),
          dispatchedAt,
          verifiedById: user.id,
          dispatchNotes: blank(dto.notes),
          vehicleNo: vehicle(dto.vehicleNo, current.vehicleNo)?.toUpperCase() ?? null,
          driverName: vehicle(dto.driverName, current.driverName),
          driverPhone: vehicle(dto.driverPhone, current.driverPhone),
          transporter: vehicle(dto.transporter, current.transporter),
          lrNo: vehicle(dto.lrNo, current.lrNo),
          subtotal,
          gstAmount,
          totalAmount: round(subtotal + gstAmount, 2),
        },
        include: saleInclude,
      });
      const short = current.items.filter((item) => loaded.get(item.id)! < Number(item.quantity) - EMPTY);
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'SALE_DISPATCHED',
          module: 'sales',
          entity: 'Sale',
          entityId: id,
          newValue: {
            saleNo: current.saleNo,
            challanNo: updated.challanNo,
            vehicleNo: updated.vehicleNo,
            short: short.map((item) => `${item.itemCode} ${loaded.get(item.id)}/${Number(item.quantity)} ${item.unit}`),
          },
        },
      });
      // The office and the other godown staff learn it has left, on which challan and vehicle, so nobody loads it again.
      await settleReminders(tx, 'Sale', id);
      const sent = current.items
        .filter((item) => loaded.get(item.id)! > EMPTY)
        .map((item) => ({ quantity: loaded.get(item.id)!, unit: item.unit, itemName: item.itemName }));
      await notifyRoles(
        tx,
        [...MANAGEMENT_ROLES, Role.STAFF],
        {
          title: `Dispatched from ${current.warehouse.code}`,
          message: [
            `${updated.challanNo} • ${current.saleNo} to ${current.partyName}: ${linesText(sent)}`,
            updated.vehicleNo && `vehicle ${updated.vehicleNo}`,
            updated.driverName && `driver ${updated.driverName}`,
            `by ${user.name}`,
            short.length && `${short.length} line(s) short; the bill now follows what was loaded`,
          ]
            .filter(Boolean)
            .join(' • '),
          type: 'ORDER_COMPLETED',
          priority: short.length ? 'HIGH' : 'NORMAL',
          referenceType: 'Sale',
          referenceId: id,
        },
        user.id,
      );
      return updated;
    });
    return this.view(sale, user);
  }

  /** The warehouse can't dispatch as entered (stock, quality, vehicle…): back to admin with the reason. */
  async reject(id: string, dto: RejectSaleDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `sale:${id}`);
      const sale = await tx.sale.findUnique({ where: { id }, include: { warehouse: { select: { code: true } } } });
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.status !== SaleStatus.PENDING) throw new BadRequestException(`${sale.saleNo} is ${sale.status.toLowerCase()}, not waiting to be dispatched`);
      const reason = dto.reason.trim();
      const updated = await tx.sale.update({ where: { id }, data: { status: SaleStatus.REJECTED, rejectReason: reason, verifiedById: user.id } });
      await settleReminders(tx, 'Sale', id);
      await tx.auditLog.create({ data: { actorId: user.id, action: 'SALE_REJECTED', module: 'sales', entity: 'Sale', entityId: id, newValue: { saleNo: sale.saleNo, reason } } });
      await notifyRoles(
        tx,
        MANAGEMENT_ROLES,
        { title: `${sale.warehouse.code} sent back ${sale.saleNo}`, message: `${sale.partyName}: ${reason}`, type: 'DELIVERY_DELAYED', priority: 'HIGH', referenceType: 'Sale', referenceId: id },
        user.id,
      );
      return updated;
    });
  }
}
