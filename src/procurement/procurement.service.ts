import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus, Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { batchCode, documentNo } from '../common/numbering';
import { lockKeys } from '../common/locks';
import { purchaseUnit, stockQuantity } from '../common/units';
import { itemSpecs } from '../common/item-specs';
import { ADMIN_ROLES } from '../common/roles';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePurchaseOrderDto, ReceivePurchaseOrderDto } from './dto/procurement.dto';
import { linesText, MANAGEMENT_ROLES, notifyRoles, settleReminders } from '../notifications/notify.util';

/** Purchase orders that can still receive material. */
const OPEN_STATUSES: PurchaseOrderStatus[] = [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED];

/** The office and the godown staff who receive: both hear when material arrives, or won't. */
const RECEIVING_ROLES: Role[] = [...MANAGEMENT_ROLES, Role.STAFF];

const purchaseOrderInclude = {
  supplier: true,
  warehouse: true,
  items: { include: { receiptItems: true } },
  receipts: { include: { warehouse: true, items: true }, orderBy: { receivedAt: 'desc' as const } },
} satisfies Prisma.PurchaseOrderInclude;

type PurchaseOrderRow = Prisma.PurchaseOrderGetPayload<{ include: typeof purchaseOrderInclude }>;

const blank = (value?: string | null) => value?.trim() || undefined;
const receivedOf = (item: { receiptItems: Array<{ quantity: Prisma.Decimal }> }) =>
  item.receiptItems.reduce((sum, r) => sum + Number(r.quantity), 0);

/** Rates and values are for the office: warehouse staff and managers see what to receive, not prices. */
const canSeePrices = (user: AuthUser) => ADMIN_ROLES.includes(user.role);

/** Once nothing more will arrive on a PO, its "material coming" reminders are marked read so no one keeps waiting. */
const settleArrivalReminders = (tx: Prisma.TransactionClient, purchaseOrderId: string) =>
  settleReminders(tx, 'PurchaseOrder', purchaseOrderId);

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /** Adds who posted each receipt, and hides rates from those who don't see prices. */
  private async present(rows: PurchaseOrderRow[], user: AuthUser) {
    const ids = [...new Set(rows.flatMap((po) => po.receipts.map((r) => r.receivedById)).filter((id): id is string => !!id))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const prices = canSeePrices(user);
    return rows.map((po) => ({
      ...po,
      items: prices ? po.items : po.items.map((item) => ({ ...item, rate: null })),
      receipts: po.receipts.map((receipt) => ({
        ...receipt,
        receivedBy: (receipt.receivedById && nameOf.get(receipt.receivedById)) || null,
      })),
    }));
  }

  async list(user: AuthUser) {
    const rows = await this.prisma.purchaseOrder.findMany({
      include: purchaseOrderInclude,
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    return this.present(rows, user);
  }

  async findOne(id: string, user: AuthUser) {
    const purchaseOrder = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: purchaseOrderInclude });
    if (!purchaseOrder) throw new NotFoundException('Purchase order not found');
    return (await this.present([purchaseOrder], user))[0];
  }

  /** Open POs being delivered to a warehouse, soonest expected first: what its staff are waiting to receive. */
  async incoming(warehouseId: string, user: AuthUser) {
    const rows = await this.prisma.purchaseOrder.findMany({
      where: { warehouseId, status: { in: OPEN_STATUSES } },
      include: purchaseOrderInclude,
      orderBy: [{ expectedDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    return this.present(rows, user);
  }

  async context() {
    const [suppliers, warehouses] = await Promise.all([
      this.prisma.supplier.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      this.prisma.warehouse.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    ]);
    return { suppliers, warehouses };
  }

  /** The office's register of received challans (goods receipts), newest first, optionally within dates. */
  async receipts(from?: Date, to?: Date) {
    const receipts = await this.prisma.purchaseReceipt.findMany({
      where: from || to ? { receivedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : undefined,
      include: {
        warehouse: { select: { code: true, name: true } },
        items: { include: { purchaseOrderItem: { select: { itemName: true, itemCode: true, unit: true, rate: true } } } },
        purchaseOrder: { select: { id: true, poNo: true, supplier: { select: { code: true, name: true } } } },
      },
      orderBy: { receivedAt: 'desc' },
      take: 2000,
    });
    const ids = [...new Set(receipts.map((r) => r.receivedById).filter((id): id is string => !!id))];
    const people = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    return receipts.map((r) => ({
      id: r.id,
      receiptNo: r.receiptNo,
      receivedAt: r.receivedAt,
      challanNo: r.challanNo,
      vehicleNo: r.vehicleNo,
      lotNo: r.lotNo,
      notes: r.notes,
      receivedBy: (r.receivedById && nameOf.get(r.receivedById)) || null,
      warehouse: r.warehouse,
      purchaseOrder: { id: r.purchaseOrder.id, poNo: r.purchaseOrder.poNo },
      supplier: r.purchaseOrder.supplier,
      items: r.items.map((line) => ({
        itemName: line.purchaseOrderItem.itemName,
        itemCode: line.purchaseOrderItem.itemCode,
        unit: line.purchaseOrderItem.unit,
        quantity: Number(line.quantity),
      })),
      value: Math.round(r.items.reduce((sum, line) => sum + Number(line.quantity) * Number(line.purchaseOrderItem.rate), 0) * 100) / 100,
    }));
  }

  /**
   * The received challan of one goods receipt, ready to print and file: letterhead, distributor, warehouse, the PO,
   * the distributor's challan and vehicle, and each line with what was ordered, received now and is still to come.
   * Rates and amounts only for those who see prices.
   */
  async receipt(id: string, user: AuthUser) {
    const receipt = await this.prisma.purchaseReceipt.findUnique({
      where: { id },
      include: {
        warehouse: { select: { id: true, code: true, name: true, location: true } },
        items: true,
        purchaseOrder: {
          include: {
            supplier: {
              select: { id: true, code: true, name: true, company: true, contactPerson: true, mobile: true, gst: true, address: true },
            },
            warehouse: { select: { id: true, code: true, name: true } },
            items: { include: { receiptItems: { include: { purchaseReceipt: { select: { receiptNo: true } } } } } },
          },
        },
      },
    });
    if (!receipt) throw new NotFoundException('Goods receipt not found');
    const po = receipt.purchaseOrder;
    const [receiver, company, specs] = await Promise.all([
      receipt.receivedById ? this.prisma.user.findUnique({ where: { id: receipt.receivedById }, select: { name: true } }) : null,
      this.prisma.systemSetting.findUnique({ where: { key: 'company' } }),
      itemSpecs(
        this.prisma,
        po.items.map((i) => i.itemCode),
      ),
    ]);
    const prices = canSeePrices(user);
    // Receipt numbers are given in posting order (under the PO's lock), so a smaller one was received earlier.
    const lines = po.items
      .map((item) => {
        const line = receipt.items.find((r) => r.purchaseOrderItemId === item.id);
        if (!line) return null;
        const ordered = Number(item.quantity);
        const receivedBefore = item.receiptItems
          .filter((r) => r.purchaseReceipt.receiptNo < receipt.receiptNo)
          .reduce((sum, r) => sum + Number(r.quantity), 0);
        const quantity = Number(line.quantity);
        const rate = prices ? Number(item.rate) : null;
        return {
          id: line.id,
          itemName: item.itemName,
          itemCode: item.itemCode,
          category: item.category ?? receipt.category,
          unit: item.unit,
          ordered,
          receivedBefore,
          quantity,
          balance: Math.max(0, ordered - receivedBefore - quantity),
          rate,
          amount: rate === null ? null : Math.round(quantity * rate * 100) / 100,
          // What else is known about the item (for fabric: type, dia, GSM, GG, LL, colour…), plus this receipt's lot.
          specs: [...(receipt.lotNo ? [{ label: 'Lot', value: receipt.lotNo }] : []), ...(item.itemCode ? (specs.get(item.itemCode) ?? []) : []).filter((s) => s.label !== 'PO')],
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);
    return {
      id: receipt.id,
      receiptNo: receipt.receiptNo,
      receivedAt: receipt.receivedAt,
      category: receipt.category,
      lotNo: receipt.lotNo,
      challanNo: receipt.challanNo,
      vehicleNo: receipt.vehicleNo,
      notes: receipt.notes,
      receivedBy: receiver?.name ?? null,
      warehouse: receipt.warehouse,
      purchaseOrder: {
        id: po.id,
        poNo: po.poNo,
        orderDate: po.orderDate,
        expectedDate: po.expectedDate,
        status: po.status,
        warehouse: po.warehouse,
      },
      supplier: po.supplier,
      lines,
      total: prices ? lines.reduce((sum, line) => sum + (line.amount ?? 0), 0) : null,
      pricesShown: prices,
      company: (company?.value ?? {}) as Record<string, string>,
    };
  }

  async create(dto: CreatePurchaseOrderDto, user: AuthUser) {
    const fractionalGrams = dto.items.find((item) => purchaseUnit(item.unit) === 'G' && !Number.isInteger(item.quantity));
    if (fractionalGrams) throw new BadRequestException(`${fractionalGrams.itemName}: grams are whole numbers`);
    const supplier = await this.prisma.supplier.findFirst({ where: { id: dto.supplierId, active: true } });
    if (!supplier) throw new BadRequestException('Select an active distributor');
    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, active: true } });
    if (!warehouse) throw new BadRequestException('Select an active warehouse to deliver to');

    return this.prisma.$transaction(async (tx) => {
      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          poNo: await documentNo(tx, 'PUR'),
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : undefined,
          status: PurchaseOrderStatus.ORDERED,
          items: {
            // No code yet: each line gets its own on its first receipt.
            create: dto.items.map((item) => ({
              itemName: item.itemName.trim(),
              category: item.category,
              quantity: item.quantity,
              unit: purchaseUnit(item.unit),
              rate: item.rate,
            })),
          },
        },
        include: purchaseOrderInclude,
      });
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'PURCHASE_ORDER_CREATED',
          module: 'procurement',
          entity: 'PurchaseOrder',
          entityId: purchaseOrder.id,
          newValue: { poNo: purchaseOrder.poNo, supplierId: supplier.id, warehouseId: warehouse.id, itemCount: dto.items.length },
        },
      });
      const ordered = linesText(
        purchaseOrder.items.map((item) => ({ quantity: Number(item.quantity), unit: item.unit, itemName: item.itemName })),
      );
      const expected = dto.expectedDate ? ` • expected ${dto.expectedDate.slice(0, 10)}` : '';
      await notifyRoles(
        tx,
        MANAGEMENT_ROLES,
        {
          title: 'Purchase order created',
          message: `${purchaseOrder.poNo} • ${supplier.name} • ${ordered} • to ${warehouse.code}${expected}`,
          type: 'SYSTEM',
          referenceType: 'PurchaseOrder',
          referenceId: purchaseOrder.id,
        },
        user.id,
      );
      // Godown staff receive the material, so tell them it is on its way (no prices).
      await notifyRoles(
        tx,
        [Role.STAFF],
        {
          title: `Material coming to ${warehouse.code}`,
          message: `${purchaseOrder.poNo} from ${supplier.name}: ${ordered}${expected}. Receive it on the Warehouses page when it arrives.`,
          type: 'DELIVERY_DUE',
          referenceType: 'PurchaseOrder',
          referenceId: purchaseOrder.id,
        },
        user.id,
      );
      return purchaseOrder;
    });
  }

  async receive(id: string, dto: ReceivePurchaseOrderDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      // Serialise receipts per PO so two GRNs cannot over-receive the same line.
      await lockKeys(tx, `purchase-order:${id}`);
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          supplier: { select: { name: true } },
          warehouse: { select: { code: true } },
          items: { include: { receiptItems: true } },
        },
      });
      if (!purchaseOrder) throw new NotFoundException('Purchase order not found');
      if (!OPEN_STATUSES.includes(purchaseOrder.status)) {
        throw new BadRequestException(
          `A ${purchaseOrder.status.toLowerCase().replaceAll('_', ' ')} purchase order cannot receive material`,
        );
      }

      const warehouse = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, active: true } });
      if (!warehouse) throw new BadRequestException('Select an active warehouse');

      const receiptItemIds = dto.items.map((item) => item.purchaseOrderItemId);
      if (new Set(receiptItemIds).size !== receiptItemIds.length) {
        throw new BadRequestException('A purchase-order line can appear only once in a receipt');
      }

      const itemById = new Map(purchaseOrder.items.map((item) => [item.id, item]));
      for (const input of dto.items) {
        const item = itemById.get(input.purchaseOrderItemId);
        if (!item) throw new BadRequestException('Receipt contains an item that is not part of this purchase order');
        if (!item.category && !dto.category) throw new BadRequestException(`Choose the stock category for ${item.itemName}`);
        const remaining = Number(item.quantity) - receivedOf(item);
        if (purchaseUnit(item.unit) === 'G' && !Number.isInteger(input.quantity)) {
          throw new BadRequestException(`${item.itemName}: grams are whole numbers`);
        }
        if (input.quantity > remaining + 1e-9) {
          throw new BadRequestException(`${item.itemName} has only ${remaining.toFixed(3)} ${item.unit} remaining`);
        }
      }

      // Each line becomes the stock it was ordered as; `dto.category` only covers lines ordered without one.
      const categoryOf = (item: (typeof purchaseOrder.items)[number]) => (item.category ?? dto.category)!;
      const receivedCategories = [...new Set(dto.items.map((input) => categoryOf(itemById.get(input.purchaseOrderItemId)!)))];
      const lotNo = blank(dto.lotNo);
      const challanNo = blank(dto.challanNo);
      const vehicleNo = blank(dto.vehicleNo)?.toUpperCase();

      const receipt = await tx.purchaseReceipt.create({
        data: {
          receiptNo: await documentNo(tx, 'GRN'),
          purchaseOrderId: purchaseOrder.id,
          warehouseId: warehouse.id,
          // The receipt's headline category; a mixed receipt keeps each line's own category in its stock movement.
          category: receivedCategories[0],
          lotNo,
          challanNo,
          vehicleNo,
          notes: blank(dto.notes),
          receivedById: user.id,
          items: { create: dto.items.map((item) => ({ purchaseOrderItemId: item.purchaseOrderItemId, quantity: item.quantity })) },
        },
        include: { items: true },
      });

      const codes: Array<{ itemName: string; itemCode: string; isNew: boolean }> = [];
      for (const input of dto.items) {
        const item = itemById.get(input.purchaseOrderItemId)!;
        // A line's first receipt gives it its own code (SS-2026-001…), so every purchased item is tracked apart;
        // later receipts of the same line add to that code.
        let itemCode = item.itemCode;
        if (!itemCode) {
          itemCode = await batchCode(tx);
          await tx.purchaseOrderItem.update({ where: { id: item.id }, data: { itemCode } });
        }
        codes.push({ itemName: item.itemName, itemCode, isNew: itemCode !== item.itemCode });
        const stocked = stockQuantity(input.quantity, item.unit);
        await this.inventory.createTxn(
          {
            category: categoryOf(item),
            txnType: 'PURCHASE_IN',
            itemCode,
            itemName: item.itemName,
            lotNo,
            warehouseId: warehouse.id,
            quantityIn: stocked.quantity,
            // The PO line's unit (KG, CONE, BAG…), so stock isn't all counted as KG; grams become KG.
            unit: stocked.unit,
            referenceType: 'PURCHASE_RECEIPT',
            referenceId: receipt.id,
            createdById: user.id,
            notes: `${purchaseOrder.poNo} / ${receipt.receiptNo}${challanNo ? ` / challan ${challanNo}` : ''}`,
          },
          tx,
        );
      }

      const receivedNow = new Map(dto.items.map((item) => [item.purchaseOrderItemId, item.quantity]));
      const stillToCome = purchaseOrder.items
        .map((item) => ({
          itemName: item.itemName,
          unit: item.unit,
          quantity: Number(item.quantity) - receivedOf(item) - (receivedNow.get(item.id) || 0),
        }))
        .filter((line) => line.quantity > 1e-9);
      const fullyReceived = stillToCome.length === 0;
      const status = fullyReceived ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIALLY_RECEIVED;
      await tx.purchaseOrder.update({ where: { id }, data: { status } });
      if (fullyReceived) await settleArrivalReminders(tx, id);
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'PURCHASE_RECEIVED',
          module: 'procurement',
          entity: 'PurchaseReceipt',
          entityId: receipt.id,
          newValue: {
            receiptNo: receipt.receiptNo,
            purchaseOrderId: id,
            warehouseId: warehouse.id,
            status,
            challanNo: challanNo ?? null,
            vehicleNo: vehicleNo ?? null,
            newCodes: codes.filter((c) => c.isNew).map((c) => `${c.itemCode} ${c.itemName}`),
          },
        },
      });

      // The office and the other godown staff learn what came in, where, on which challan, and what is still to come.
      const received = linesText(dto.items.map((input) => ({ ...itemById.get(input.purchaseOrderItemId)!, quantity: input.quantity })));
      const elsewhere =
        purchaseOrder.warehouseId && purchaseOrder.warehouseId !== warehouse.id ? ` (ordered for ${purchaseOrder.warehouse?.code})` : '';
      await notifyRoles(
        tx,
        RECEIVING_ROLES,
        {
          title: fullyReceived ? `${purchaseOrder.poNo} received in full` : `${purchaseOrder.poNo} partly received`,
          message: [
            `${receipt.receiptNo} • ${purchaseOrder.supplier.name} → ${warehouse.code}${elsewhere}: ${received}`,
            challanNo && `challan ${challanNo}`,
            vehicleNo && `vehicle ${vehicleNo}`,
            `received by ${user.name}`,
            fullyReceived ? 'nothing more to come' : `still to come: ${linesText(stillToCome, 2)}`,
          ]
            .filter(Boolean)
            .join(' • '),
          type: fullyReceived ? 'ORDER_READY' : 'SYSTEM',
          priority: fullyReceived ? 'HIGH' : 'NORMAL',
          referenceType: 'PurchaseOrder',
          referenceId: purchaseOrder.id,
        },
        user.id,
      );
      return {
        success: true,
        message: 'Material received and stock ledger updated',
        receiptId: receipt.id,
        receiptNo: receipt.receiptNo,
        status,
        categories: receivedCategories,
        codes,
      };
    });
  }

  async cancel(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `purchase-order:${id}`);
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { receipts: { select: { id: true } }, supplier: { select: { name: true } }, warehouse: { select: { code: true } } },
      });
      if (!purchaseOrder) throw new NotFoundException('Purchase order not found');
      if (purchaseOrder.status !== PurchaseOrderStatus.ORDERED || purchaseOrder.receipts.length > 0) {
        throw new BadRequestException('Only an unreceived ordered purchase order can be cancelled');
      }
      const updated = await tx.purchaseOrder.update({ where: { id }, data: { status: PurchaseOrderStatus.CANCELLED } });
      await settleArrivalReminders(tx, id);
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'PURCHASE_ORDER_CANCELLED', module: 'procurement', entity: 'PurchaseOrder', entityId: id },
      });
      await notifyRoles(
        tx,
        RECEIVING_ROLES,
        {
          title: 'Purchase order cancelled',
          message: `${purchaseOrder.poNo} from ${purchaseOrder.supplier.name}${purchaseOrder.warehouse ? ` to ${purchaseOrder.warehouse.code}` : ''} was cancelled; nothing will arrive on it`,
          type: 'SYSTEM',
          priority: 'HIGH',
          referenceType: 'PurchaseOrder',
          referenceId: id,
        },
        user.id,
      );
      return updated;
    });
  }

  /** Closes a partly received PO short: what arrived stays in stock, the rest is no longer expected. */
  async close(id: string, reason: string | undefined, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      await lockKeys(tx, `purchase-order:${id}`);
      const purchaseOrder = await tx.purchaseOrder.findUnique({
        where: { id },
        include: {
          items: { include: { receiptItems: true } },
          supplier: { select: { name: true } },
          warehouse: { select: { code: true } },
        },
      });
      if (!purchaseOrder) throw new NotFoundException('Purchase order not found');
      if (purchaseOrder.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED) {
        throw new BadRequestException(
          purchaseOrder.status === PurchaseOrderStatus.ORDERED
            ? 'Nothing has been received on this purchase order yet: cancel it instead'
            : `A ${purchaseOrder.status.toLowerCase()} purchase order cannot be closed`,
        );
      }
      const notReceived = purchaseOrder.items
        .map((item) => ({
          itemCode: item.itemCode,
          itemName: item.itemName,
          quantity: Number(item.quantity) - receivedOf(item),
          unit: item.unit,
        }))
        .filter((line) => line.quantity > 1e-9);
      const updated = await tx.purchaseOrder.update({ where: { id }, data: { status: PurchaseOrderStatus.CLOSED } });
      await settleArrivalReminders(tx, id);
      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: 'PURCHASE_ORDER_CLOSED',
          module: 'procurement',
          entity: 'PurchaseOrder',
          entityId: id,
          previousValue: { status: purchaseOrder.status },
          newValue: { status: PurchaseOrderStatus.CLOSED, reason: blank(reason) ?? null, notReceived },
        },
      });
      await notifyRoles(
        tx,
        RECEIVING_ROLES,
        {
          title: 'Purchase order closed short',
          message: `${purchaseOrder.poNo} from ${purchaseOrder.supplier.name}${purchaseOrder.warehouse ? ` to ${purchaseOrder.warehouse.code}` : ''} was closed; ${linesText(notReceived)} will not arrive${blank(reason) ? ` (${blank(reason)})` : ''}`,
          type: 'SYSTEM',
          referenceType: 'PurchaseOrder',
          referenceId: id,
        },
        user.id,
      );
      return updated;
    });
  }
}
