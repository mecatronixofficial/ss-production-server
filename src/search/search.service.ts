import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { ADMIN_ROLES, GODOWN_VIEW_ROLES, MACHINE_ROLES } from '../common/roles';
import { PrismaService } from '../prisma/prisma.service';

/** What a result is; the app turns it into a link. */
export type SearchKind =
  'item' | 'batch' | 'run' | 'machine' | 'sale' | 'purchase' | 'receipt' | 'challan' | 'distributor' | 'textile' | 'warehouse';
export type SearchHit = { kind: SearchKind; key: string; title: string; subtitle: string | null };

const PER_KIND = 6;
const words = (value?: string | null) =>
  value
    ? value
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^./, (c) => c.toUpperCase())
    : null;
const join = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ') || null;

/**
 * One search box for the whole ERP: item codes (yarn, fabric, anything in stock or bought), production batches,
 * knitting runs, machines, sales and delivery challans, purchase orders, goods receipts, warehouse challans,
 * distributors, textiles and warehouses. Each role only finds what it can open.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(text: string, role: Role): Promise<SearchHit[]> {
    const q = text.trim();
    if (q.length < 2) return [];
    /** Contains the text, any case. */
    const has = (): Prisma.StringFilter => ({ contains: q, mode: 'insensitive' });
    const admin = ADMIN_ROLES.includes(role);
    const machines = MACHINE_ROLES.includes(role);
    const godown = GODOWN_VIEW_ROLES.includes(role);
    const none = Promise.resolve([] as SearchHit[]);

    const [items, batches, runs, machineHits, sales, purchases, receipts, challans, distributors, textiles, warehouses] = await Promise.all(
      [
        godown ? this.items(q) : none,
        admin || machines
          ? this.prisma.fabricProductionFlow
              .findMany({
                where: { OR: [{ flowNo: has() }, { yarnItemCode: has() }, { fabricType: has() }, { color: has() }] },
                select: {
                  flowNo: true,
                  status: true,
                  fabricType: true,
                  fabricDiameter: true,
                  fabricGsm: true,
                  color: true,
                  purchasedWeightKg: true,
                },
                orderBy: { createdAt: 'desc' },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((f) => ({
                  kind: 'batch',
                  key: f.flowNo,
                  title: f.flowNo,
                  subtitle: join(
                    f.fabricType,
                    f.fabricDiameter,
                    f.fabricGsm && `${f.fabricGsm} GSM`,
                    f.color,
                    `${Number(f.purchasedWeightKg)} KG yarn`,
                    words(f.status),
                  ),
                })),
              )
          : none,
        machines
          ? this.prisma.knittingRun
              .findMany({
                where: { OR: [{ runNo: has() }, { fabricType: has() }] },
                select: { runNo: true, status: true, fabricType: true, yarnKg: true, outputKg: true, machine: { select: { code: true } } },
                orderBy: { startedAt: 'desc' },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((r) => ({
                  kind: 'run',
                  key: r.runNo,
                  title: r.runNo,
                  subtitle: join(
                    `Knitting run on ${r.machine.code}`,
                    r.fabricType,
                    `${Number(r.yarnKg)} KG yarn`,
                    r.outputKg !== null && `${Number(r.outputKg)} KG fabric`,
                    words(r.status),
                  ),
                })),
              )
          : none,
        machines
          ? this.prisma.machine
              .findMany({
                where: { OR: [{ code: has() }, { name: has() }] },
                select: { id: true, code: true, name: true, status: true, type: true },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((m) => ({
                  kind: 'machine',
                  key: m.id,
                  title: `${m.code} · ${m.name}`,
                  subtitle: join('Machine', m.type, words(m.status)),
                })),
              )
          : none,
        admin
          ? this.prisma.sale
              .findMany({
                where: { OR: [{ saleNo: has() }, { challanNo: has() }, { partyName: has() }, { vehicleNo: has() }] },
                select: { id: true, saleNo: true, challanNo: true, partyName: true, status: true, totalAmount: true, saleDate: true },
                orderBy: { saleDate: 'desc' },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((s) => ({
                  kind: 'sale',
                  key: s.id,
                  title: join(s.saleNo, s.challanNo)!,
                  subtitle: join(
                    s.partyName,
                    s.saleDate.toISOString().slice(0, 10),
                    `Rs ${Number(s.totalAmount).toLocaleString('en-IN')}`,
                    words(s.status),
                  ),
                })),
              )
          : none,
        admin
          ? this.prisma.purchaseOrder
              .findMany({
                where: { OR: [{ poNo: has() }, { supplier: { name: has() } }] },
                select: { id: true, poNo: true, status: true, orderDate: true, supplier: { select: { name: true } } },
                orderBy: { orderDate: 'desc' },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((p) => ({
                  kind: 'purchase',
                  key: p.id,
                  title: p.poNo,
                  subtitle: join('Purchase order', p.supplier.name, p.orderDate.toISOString().slice(0, 10), words(p.status)),
                })),
              )
          : none,
        admin
          ? this.prisma.purchaseReceipt
              .findMany({
                where: { OR: [{ receiptNo: has() }, { challanNo: has() }, { vehicleNo: has() }, { lotNo: has() }] },
                select: {
                  id: true,
                  receiptNo: true,
                  challanNo: true,
                  receivedAt: true,
                  purchaseOrder: { select: { poNo: true, supplier: { select: { name: true } } } },
                },
                orderBy: { receivedAt: 'desc' },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((r) => ({
                  kind: 'receipt',
                  key: r.id,
                  title: r.receiptNo,
                  subtitle: join(
                    'Goods received',
                    r.purchaseOrder.poNo,
                    r.purchaseOrder.supplier.name,
                    r.challanNo && `their challan ${r.challanNo}`,
                    r.receivedAt.toISOString().slice(0, 10),
                  ),
                })),
              )
          : none,
        godown
          ? this.prisma.stockBill
              .findMany({
                where: { OR: [{ billNo: has() }, { partyName: has() }, { vehicleNo: has() }] },
                select: {
                  id: true,
                  billNo: true,
                  kind: true,
                  partyName: true,
                  createdAt: true,
                  cancelledAt: true,
                  warehouse: { select: { code: true } },
                },
                orderBy: { createdAt: 'desc' },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((b) => ({
                  kind: 'challan',
                  key: b.id,
                  title: b.billNo,
                  subtitle: join(
                    b.kind === 'RECEIVED' ? 'Received challan' : 'Export challan',
                    b.warehouse.code,
                    b.partyName,
                    b.createdAt.toISOString().slice(0, 10),
                    b.cancelledAt && 'Cancelled',
                  ),
                })),
              )
          : none,
        admin
          ? this.prisma.supplier
              .findMany({
                where: { OR: [{ code: has() }, { name: has() }, { mobile: has() }] },
                select: { id: true, code: true, name: true, mobile: true },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((s) => ({
                  kind: 'distributor',
                  key: s.id,
                  title: s.name,
                  subtitle: join('Distributor', s.code, s.mobile),
                })),
              )
          : none,
        admin
          ? this.prisma.textile
              .findMany({
                where: { OR: [{ code: has() }, { name: has() }, { mobile: has() }] },
                select: { id: true, code: true, name: true, mobile: true },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((t) => ({ kind: 'textile', key: t.id, title: t.name, subtitle: join('Textile', t.code, t.mobile) })),
              )
          : none,
        godown
          ? this.prisma.warehouse
              .findMany({
                where: { OR: [{ code: has() }, { name: has() }] },
                select: { id: true, code: true, name: true, location: true },
                take: PER_KIND,
              })
              .then((rows) =>
                rows.map<SearchHit>((w) => ({
                  kind: 'warehouse',
                  key: w.id,
                  title: `${w.code} · ${w.name}`,
                  subtitle: join('Warehouse', w.location),
                })),
              )
          : none,
      ],
    );
    // An exact code first: typing a full code and pressing Enter opens it.
    const exact = (hit: SearchHit) => (hit.key.toUpperCase() === q.toUpperCase() || hit.title.toUpperCase() === q.toUpperCase() ? 0 : 1);
    return [
      ...items,
      ...batches,
      ...runs,
      ...machineHits,
      ...sales,
      ...purchases,
      ...receipts,
      ...challans,
      ...distributors,
      ...textiles,
      ...warehouses,
    ].sort((a, b) => exact(a) - exact(b));
  }

  /** Item codes in stock movements or on purchase lines, with their name, material and how much is in stock. */
  private async items(q: string): Promise<SearchHit[]> {
    const filter = { contains: q, mode: 'insensitive' as const };
    const [moved, bought] = await Promise.all([
      this.prisma.stockTransaction.groupBy({
        by: ['itemCode', 'category', 'unit'],
        where: { OR: [{ itemCode: filter }, { itemName: filter }, { lotNo: filter }] },
        _sum: { quantityIn: true, quantityOut: true },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: 'desc' } },
        take: 30,
      }),
      this.prisma.purchaseOrderItem.findMany({
        where: { itemCode: { not: null }, OR: [{ itemCode: filter }, { itemName: filter }] },
        select: { itemCode: true, itemName: true, category: true },
        take: PER_KIND,
      }),
    ]);
    const names = await this.prisma.stockTransaction.findMany({
      where: { itemCode: { in: [...new Set(moved.map((m) => m.itemCode))] } },
      distinct: ['itemCode'],
      orderBy: { createdAt: 'desc' },
      select: { itemCode: true, itemName: true },
    });
    const nameOf = new Map([
      ...bought.map((b) => [b.itemCode!, b.itemName] as const),
      ...names.map((n) => [n.itemCode, n.itemName] as const),
    ]);
    const hits = new Map<string, SearchHit>();
    for (const m of moved) {
      if (hits.size >= PER_KIND) break;
      const stock = Number(m._sum.quantityIn ?? 0) - Number(m._sum.quantityOut ?? 0);
      const previous = hits.get(m.itemCode);
      const part = `${Math.round(stock * 1000) / 1000} ${m.unit} in stock`;
      hits.set(m.itemCode, {
        kind: 'item',
        key: m.itemCode,
        title: m.itemCode,
        subtitle: previous ? `${previous.subtitle} · ${part}` : join(nameOf.get(m.itemCode), words(m.category), part),
      });
    }
    for (const b of bought) {
      if (hits.size >= PER_KIND || hits.has(b.itemCode!)) continue;
      hits.set(b.itemCode!, {
        kind: 'item',
        key: b.itemCode!,
        title: b.itemCode!,
        subtitle: join(b.itemName, words(b.category), 'bought, not in stock yet'),
      });
    }
    return [...hits.values()];
  }
}
