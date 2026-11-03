import { Injectable } from '@nestjs/common';
import { MachineStatus, PurchaseOrderStatus, Role } from '@prisma/client';
import { AuthUser } from '../common/auth-user';
import { saleMoney, salePayment } from '../finance/money-rules';
import { MoneyService } from '../finance/money.service';
import { PrismaService } from '../prisma/prisma.service';
import { fabricFlowView } from '../production/fabric-flow-view';

export const TREND_RANGES = [7, 30, 90] as const;

/** Batch stages in production order; DELIVERED batches are done. */
const STAGES = ['PURCHASED', 'KNITTING', 'DYEING', 'COMPACTING', 'AT_OFFICE'] as const;
const OPEN_PO: PurchaseOrderStatus[] = [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED];
const FABRIC = ['YARN', 'GREY_FABRIC', 'DYED_FABRIC', 'FINISHED_FABRIC'] as const;
const EMPTY = 0.0005;
/** A batch sitting in one stage longer than this is pointed out. */
const STUCK_DAYS = 10;

/**
 * The command centre: production batches by stage, knitting machines and runs, material output over time, stock in
 * KG, purchases and fabric waiting to be received, sales, and (for admins) the money position. Everything here comes
 * from the modules the mill works in today: Production batches, Machines, Purchases, Warehouses, Sales and Money.
 * Money figures are the Money page's own overview, so the two always agree.
 */
@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private money: MoneyService,
  ) {}

  private inFlightRequests = new Map<string, Promise<unknown>>();

  /** Reuses the same work when the browser sends overlapping requests (e.g. Strict Mode). */
  private shared<T>(key: string, work: () => Promise<T>): Promise<T> {
    let inFlight = this.inFlightRequests.get(key) as Promise<T> | undefined;
    if (!inFlight) {
      inFlight = work().finally(() => this.inFlightRequests.delete(key));
      this.inFlightRequests.set(key, inFlight);
    }
    return inFlight;
  }

  get(user: AuthUser, trendDays = 7) {
    return this.shared(`${user.id}:${trendDays}`, () => this.load(user, trendDays));
  }

  /** Only the material-flow chart, so switching its range does not load the whole dashboard again. */
  async trend(trendDays: number) {
    return { success: true, data: await this.shared(`trend:${trendDays}`, () => this.trendData(trendDays)) };
  }

  /** Yarn received, fabric knitted, delivered and sold: KG per day, and the totals of the period just before. */
  private async trendData(trendDays: number) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const trendStart = new Date(todayStart);
    trendStart.setDate(trendStart.getDate() - (trendDays - 1));
    // The period just before, of the same length, so the dashboard can say whether output went up or down.
    const previousStart = new Date(trendStart);
    previousStart.setDate(previousStart.getDate() - trendDays);

    const [yarnIn, knitDays, runsWithoutDays, deliveries, sold] = await Promise.all([
      this.prisma.stockTransaction.findMany({
        where: { category: 'YARN', unit: 'KG', txnType: 'PURCHASE_IN', createdAt: { gte: previousStart } },
        select: { createdAt: true, quantityIn: true },
      }),
      this.prisma.knittingDayEntry.findMany({ where: { date: { gte: previousStart } }, select: { date: true, outputKg: true } }),
      // Runs from before day entries: their fabric counts on the day they finished.
      this.prisma.knittingRun.findMany({
        where: { finishedAt: { gte: previousStart }, outputKg: { not: null }, days: { none: {} } },
        select: { finishedAt: true, outputKg: true },
      }),
      this.prisma.fabricFlowDelivery.findMany({
        where: { processStage: 'FINAL', destination: 'CUSTOMER', deliveredAt: { gte: previousStart } },
        select: { deliveredAt: true, weightKg: true },
      }),
      // Material that left by sale, on the day it was dispatched.
      this.prisma.saleItem.findMany({
        where: { unit: { equals: 'KG', mode: 'insensitive' }, sale: { status: 'DISPATCHED', dispatchedAt: { gte: previousStart } } },
        select: { dispatchedQty: true, sale: { select: { dispatchedAt: true } } },
      }),
    ]);

    const trend = Array.from({ length: trendDays }, (_, i) => {
      const date = new Date(trendStart);
      date.setDate(date.getDate() + i);
      return { date: this.dayKey(date), yarnInKg: 0, knittedKg: 0, deliveredKg: 0, soldKg: 0 };
    });
    const byDay = new Map(trend.map((d) => [d.date, d]));
    const previousKey = this.dayKey(previousStart);
    const trendKey = this.dayKey(trendStart);
    const trendPrevious = { yarnInKg: 0, knittedKg: 0, deliveredKg: 0, soldKg: 0 };
    /** A day in the range goes on its own point; a day in the period before adds to that period's total. */
    const add = (key: string, field: keyof typeof trendPrevious, value: number) => {
      const d = byDay.get(key);
      if (d) d[field] += value;
      else if (key >= previousKey && key < trendKey) trendPrevious[field] += value;
    };
    for (const row of yarnIn) add(this.dayKey(row.createdAt), 'yarnInKg', Number(row.quantityIn));
    // Fabric by the production day it was knitted (a date-only column, so read it as stored).
    for (const day of knitDays) add(day.date.toISOString().slice(0, 10), 'knittedKg', Number(day.outputKg));
    for (const run of runsWithoutDays) if (run.finishedAt) add(this.dayKey(run.finishedAt), 'knittedKg', Number(run.outputKg));
    for (const row of deliveries) add(this.dayKey(row.deliveredAt), 'deliveredKg', Number(row.weightKg));
    for (const row of sold) if (row.sale.dispatchedAt) add(this.dayKey(row.sale.dispatchedAt), 'soldKg', Number(row.dispatchedQty ?? 0));
    return { days: trendDays, trend, trendPrevious };
  }

  private async load(user: AuthUser, trendDays: number) {
    const isAdmin = user.role === Role.SUPERADMIN || user.role === Role.ADMIN;
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const KG = { equals: 'KG', mode: 'insensitive' as const };
    // Every read goes out at once: the connection pool runs as many side by side as it has connections and queues the
    // rest, so one slow round trip to the database does not wait on the one before it.
    const [
      flows, deliveredThisMonth, running, lastDay, machines,
      stock, purchaseOrders, awaitingFabric,
      notifications, unreadNotifications, lastDelivery, processUpdates,
      salesWaiting, salesSentBack, salesMonth, soldKgMonth,
      money, recent, trend,
    ] = await Promise.all([
      this.prisma.fabricProductionFlow.findMany({
        where: { status: { not: 'DELIVERED' } },
        // A knitting batch's dyeing lots: it counts only the grey fabric (and cost) not yet in a lot.
        include: { knittingRuns: { select: { yarnKg: true, status: true } }, lots: { select: { purchasedWeightKg: true } } },
        orderBy: { purchaseDate: 'asc' },
      }),
      // Delivered = finished fabric that went to a party, as in the Monthly report and Finance; fabric moved into an
      // own warehouse is still stock and leaves through a sale.
      this.prisma.fabricFlowDelivery.aggregate({
        where: { processStage: 'FINAL', destination: 'CUSTOMER', deliveredAt: { gte: monthStart } },
        _sum: { weightKg: true, amount: true },
        _count: true,
      }),
      this.prisma.knittingRun.findMany({
        where: { status: 'RUNNING' },
        select: { id: true, runNo: true, startedAt: true, startShift: true, outputKg: true, machine: { select: { id: true, code: true } } },
      }),
      // The last production day recorded at day end (KG and rolls of every machine that day), however long ago.
      this.prisma.$queryRaw<Array<{ date: string; machines: number; kg: number; rolls: number }>>`
        SELECT to_char("date", 'YYYY-MM-DD') AS "date", COUNT(*)::int AS "machines",
          COALESCE(SUM("outputKg"), 0)::float8 AS "kg", COALESCE(SUM("rollCount"), 0)::int AS "rolls"
        FROM "KnittingDayEntry"
        WHERE "date" = (SELECT MAX("date") FROM "KnittingDayEntry")
        GROUP BY "date"`.then(([row]) => row ?? null),
      this.prisma.machine.groupBy({ by: ['status'], where: { status: { not: MachineStatus.DISABLED } }, _count: true }),
      // Stock by category and unit, and the positions below zero, in one pass over the stock entries. Only the
      // negative positions come back (counted here), not every position.
      this.prisma.$queryRaw<Array<{ category: string | null; unit: string; qty: number; position: number }>>`
        SELECT "category"::text AS "category", "unit", (SUM("quantityIn") - SUM("quantityOut"))::float8 AS "qty",
          GROUPING("category")::int AS "position"
        FROM "StockTransaction"
        GROUP BY GROUPING SETS (("category", "unit"), ("itemCode", "lotNo", "warehouseId", "unit"))
        HAVING GROUPING("category") = 0 OR SUM("quantityIn") - SUM("quantityOut") < ${-EMPTY}`,
      this.prisma.purchaseOrder.findMany({
        where: { status: { in: OPEN_PO } },
        select: { id: true, poNo: true, expectedDate: true, supplier: { select: { name: true } }, items: { select: { quantity: true, rate: true, receiptItems: { select: { quantity: true } } } } },
        orderBy: { expectedDate: { sort: 'asc', nulls: 'last' } },
      }),
      this.prisma.fabricFlowDelivery.findMany({
        where: { warehouseId: { not: null }, receivedAt: null },
        select: { id: true, weightKg: true, deliveredAt: true, flow: { select: { flowNo: true } }, warehouse: { select: { id: true, code: true } } },
        orderBy: { deliveredAt: 'asc' },
      }),
      this.prisma.notification.findMany({
        where: { isRead: false, userId: user.id },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, message: true, type: true, priority: true, createdAt: true },
      }),
      this.prisma.notification.count({ where: { isRead: false, userId: user.id } }),
      this.prisma.fabricFlowDelivery.aggregate({ where: { processStage: 'FINAL', destination: 'CUSTOMER' }, _max: { deliveredAt: true } }),
      // Production updates: the latest processes completed (knitting, dyeing, compacting, machine runs), read or not.
      this.prisma.notification.findMany({
        where: { userId: user.id, type: 'JOB_COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, title: true, message: true, priority: true, isRead: true, createdAt: true, referenceType: true, referenceId: true },
      }),
      this.prisma.sale.count({ where: { status: 'PENDING' } }),
      isAdmin ? this.prisma.sale.count({ where: { status: 'REJECTED' } }) : 0,
      // Sales billed this month: dispatched bills by bill date, as on Finance.
      this.prisma.sale.aggregate({ where: { status: 'DISPATCHED', saleDate: { gte: monthStart } }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.saleItem.aggregate({ where: { unit: KG, sale: { status: 'DISPATCHED', saleDate: { gte: monthStart } } }, _sum: { dispatchedQty: true } }),
      isAdmin ? this.money.summary() : null,
      // The latest bills and what was paid on them; the payments follow the bills without waiting for anything else.
      isAdmin
        ? this.prisma.sale
            .findMany({
              where: { status: { not: 'CANCELLED' } },
              orderBy: { createdAt: 'desc' },
              take: 6,
              select: { id: true, saleNo: true, saleDate: true, partyName: true, status: true, totalAmount: true },
            })
            .then(async (sales) => ({ sales, paid: await saleMoney(this.prisma, sales.map((sale) => sale.id)) }))
        : { sales: [], paid: new Map<string, { received: number; pending: number }>() },
      this.trendData(trendDays),
    ]);
    const negativeCount = stock.filter((row) => row.position === 1).length;

    // ---- Production batches
    const views = flows.map((flow) => ({ flow, view: fabricFlowView(flow) }));
    const stageCounts = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<(typeof STAGES)[number], number>;
    for (const { flow } of views) if (flow.status in stageCounts) stageCounts[flow.status as (typeof STAGES)[number]] += 1;
    /** When the batch entered the stage it is in now. */
    const stageSince = (f: (typeof flows)[number]) =>
      f.status === 'AT_OFFICE' ? f.compactingFinishedAt ?? f.compactingDate
        : f.status === 'COMPACTING' ? f.compactingDate ?? f.dyeingFinishedAt
          : f.status === 'DYEING' ? f.dyeingDate ?? f.knittingFinishedAt
            : f.status === 'KNITTING' ? f.knittingFinishedAt ?? f.knittingDate ?? f.purchaseDate
              : f.purchaseDate;
    const days = (from: Date | null) => (from ? Math.max(0, Math.floor((todayStart.getTime() - new Date(from).setHours(0, 0, 0, 0)) / 86_400_000)) : 0);
    const activeBatches = views
      .map(({ flow, view }) => ({
        id: flow.id,
        flowNo: flow.flowNo,
        status: flow.status,
        fabric: flow.fabricType ?? flow.yarnCount,
        color: flow.color,
        startedKg: view.purchasedWeightKg,
        currentKg: view.metrics.currentWeightKg,
        lossPct: view.metrics.lossPct,
        daysInStage: days(stageSince(flow)),
        dueDate: flow.status === 'KNITTING' && !flow.knittingFinishedAt ? flow.knittingExpectedFinishDate?.toISOString() ?? null : null,
        place:
          flow.status === 'KNITTING'
            ? flow.knittingFinishedAt ? `Grey fabric · ${flow.dyeingPartyDetails ?? 'waiting for dyeing'}` : flow.knittingMillType === 'OWN' ? 'Own machines' : flow.knittingPartyDetails ?? 'Outside mill'
            : flow.status === 'DYEING' ? flow.dyeingPartyDetails ?? flow.dyeingMillDetails ?? 'Dyeing'
              : flow.status === 'COMPACTING' ? flow.compactingPartyDetails ?? flow.compactingMillDetails ?? 'Compacting'
                : flow.status === 'AT_OFFICE' ? 'Ready to deliver' : 'Not started',
      }))
      .sort((a, b) => b.daysInStage - a.daysInStage);
    // Each stage over every open batch (the table below only lists the longest waiting few): weight, oldest, and where.
    const board = STAGES.map((stage) => {
      const rows = activeBatches.filter((b) => b.status === stage);
      const places = new Map<string, { name: string; count: number; kg: number; oldest: number }>();
      for (const b of rows) {
        const place = places.get(b.place) ?? { name: b.place, count: 0, kg: 0, oldest: 0 };
        place.count += 1;
        place.kg += b.currentKg;
        place.oldest = Math.max(place.oldest, b.daysInStage);
        places.set(b.place, place);
      }
      return {
        key: stage,
        count: rows.length,
        kg: rows.reduce((sum, b) => sum + b.currentKg, 0),
        oldestDays: rows.reduce((max, b) => Math.max(max, b.daysInStage), 0),
        stuck: rows.filter((b) => b.daysInStage > STUCK_DAYS).length,
        places: [...places.values()].sort((a, b) => b.oldest - a.oldest || b.kg - a.kg),
      };
    });
    // Weight lost in process (knitting, dyeing, compacting) on batches past knitting, weighted by the yarn they started with.
    const processed = activeBatches.filter((b) => b.status !== 'PURCHASED' && b.lossPct > 0);
    const processedKg = processed.reduce((sum, b) => sum + b.startedKg, 0);
    const processLossPct = processedKg ? processed.reduce((sum, b) => sum + (b.lossPct / 100) * b.startedKg, 0) / processedKg * 100 : null;
    const readyKg = views.filter(({ flow }) => flow.status === 'AT_OFFICE').reduce((sum, { view }) => sum + view.metrics.balanceFabricKg, 0);
    const knittingTasks = flows.filter((f) => {
      if (f.status !== 'KNITTING' || f.knittingMillType !== 'OWN' || f.knittingFinishedAt) return false;
      // Waiting = no machine knitting it now (machines are not loaded up to a capacity, so a task on one is not waiting).
      return !f.knittingRuns.some((run) => run.status === 'RUNNING');
    }).length;

    // ---- Machines and runs
    const machineCounts = Object.fromEntries(machines.map((m) => [m.status, m._count])) as Record<string, number>;
    const machineTotal = machines.reduce((sum, m) => sum + m._count, 0);

    // ---- Stock in KG (other units are shown on the Warehouses page)
    const stockKg = Object.fromEntries(FABRIC.map((c) => [c, 0])) as Record<(typeof FABRIC)[number], number>;
    for (const row of stock) {
      if (row.position === 1 || row.unit !== 'KG' || !row.category || !(row.category in stockKg)) continue;
      stockKg[row.category as (typeof FABRIC)[number]] += row.qty;
    }

    // ---- Purchases
    const overduePOs = purchaseOrders.filter((po) => po.expectedDate && po.expectedDate < todayStart);
    const toArriveValue = purchaseOrders.reduce(
      (sum, po) => sum + po.items.reduce((s, item) => s + Math.max(0, Number(item.quantity) - item.receiptItems.reduce((r, x) => r + Number(x.quantity), 0)) * Number(item.rate), 0),
      0,
    );

    // ---- What needs someone's attention, most urgent first
    /** What each item is about, so the dashboard shows its icon (an overdue PO links to Warehouses for non-admins). */
    type AttentionKind = 'machines' | 'warehouse' | 'purchases' | 'sales' | 'money' | 'production';
    const attention: Array<{ tone: 'danger' | 'warning' | 'info'; kind: AttentionKind; text: string; href: string }> = [];
    const push = (when: boolean, item: (typeof attention)[number]) => { if (when) attention.push(item); };
    const down = (machineCounts.MAINTENANCE ?? 0) + (machineCounts.BREAKDOWN ?? 0);
    push(down > 0, { tone: 'danger', kind: 'machines', text: `${down} machine${down === 1 ? '' : 's'} out of service`, href: '/masters/machines' });
    push(overduePOs.length > 0, { tone: 'danger', kind: 'purchases', text: `${overduePOs.length} purchase order${overduePOs.length === 1 ? '' : 's'} past the expected date${overduePOs[0] ? ` (${overduePOs[0].poNo} · ${overduePOs[0].supplier.name})` : ''}`, href: isAdmin ? '/purchases' : '/warehouses' });
    push(negativeCount > 0, { tone: 'danger', kind: 'warehouse', text: `${negativeCount} stock position${negativeCount === 1 ? ' is' : 's are'} below zero; check the entries`, href: '/warehouses' });
    push(salesSentBack > 0, { tone: 'danger', kind: 'sales', text: `${salesSentBack} sale${salesSentBack === 1 ? ' was' : 's were'} sent back by the warehouse`, href: '/sales' });
    const cheques = money?.cheques;
    push(!!cheques && cheques.bouncedMonth.count > 0, { tone: 'danger', kind: 'money', text: `${cheques?.bouncedMonth.count} cheque${cheques?.bouncedMonth.count === 1 ? '' : 's'} bounced this month`, href: '/money?tab=cheques' });
    push(salesWaiting > 0, { tone: 'warning', kind: 'sales', text: `${salesWaiting} sale${salesWaiting === 1 ? '' : 's'} waiting to be verified and dispatched`, href: isAdmin ? '/sales' : '/warehouses' });
    push(knittingTasks > 0, { tone: 'warning', kind: 'machines', text: `${knittingTasks} knitting task${knittingTasks === 1 ? '' : 's'} waiting for a machine`, href: '/masters/machines' });
    push(awaitingFabric.length > 0, { tone: 'warning', kind: 'warehouse', text: `${awaitingFabric.length} fabric deliver${awaitingFabric.length === 1 ? 'y' : 'ies'} waiting to be received in a warehouse`, href: awaitingFabric[0] ? `/warehouses?warehouse=${awaitingFabric[0].warehouse?.id}` : '/warehouses' });
    const stuck = activeBatches.filter((b) => b.status !== 'PURCHASED' && b.daysInStage > STUCK_DAYS);
    push(stuck.length > 0, { tone: 'warning', kind: 'production', text: `${stuck.length} batch${stuck.length === 1 ? '' : 'es'} in the same stage for over ${STUCK_DAYS} days (${stuck[0]?.flowNo})`, href: `/production?batch=${encodeURIComponent(stuck[0]?.flowNo ?? '')}` });
    push(!!cheques && cheques.toDeposit.count > 0, { tone: 'warning', kind: 'money', text: `${cheques?.toDeposit.count} received cheque${cheques?.toDeposit.count === 1 ? '' : 's'} waiting to be deposited`, href: '/money?tab=cheques' });
    push(stageCounts.AT_OFFICE > 0, { tone: 'info', kind: 'production', text: `${stageCounts.AT_OFFICE} batch${stageCounts.AT_OFFICE === 1 ? '' : 'es'} ready to deliver (${readyKg.toFixed(0)} KG)`, href: '/production' });

    return {
      success: true,
      data: {
        generatedAt: now.toISOString(),
        isAdmin,
        production: {
          stages: STAGES.map((stage) => ({ key: stage, count: stageCounts[stage] })),
          board,
          active: flows.length,
          inProcessKg: activeBatches.reduce((sum, b) => sum + b.currentKg, 0),
          processLossPct,
          readyKg,
          deliveredThisMonth: { count: deliveredThisMonth._count, kg: Number(deliveredThisMonth._sum.weightKg ?? 0), amount: isAdmin ? Number(deliveredThisMonth._sum.amount ?? 0) : null },
          batches: activeBatches.slice(0, 8),
          lastDeliveryAt: lastDelivery._max.deliveredAt?.toISOString() ?? null,
        },
        machines: {
          total: machineTotal,
          byStatus: machineCounts,
          knitting: running.length,
          knittedOnRunningKg: running.reduce((sum, r) => sum + Number(r.outputKg ?? 0), 0),
          lastDay,
          knittingTasks,
          running: running
            .map((r) => ({ id: r.id, runNo: r.runNo, machineId: r.machine.id, machine: r.machine.code, startedAt: r.startedAt.toISOString(), startShift: r.startShift, knittedKg: Number(r.outputKg ?? 0) }))
            .sort((a, b) => a.machine.localeCompare(b.machine)),
        },
        trend: trend.trend,
        trendPrevious: trend.trendPrevious,
        stockKg,
        purchases: {
          open: purchaseOrders.length,
          overdue: overduePOs.length,
          toArriveValue: isAdmin ? toArriveValue : null,
          next: purchaseOrders.slice(0, 4).map((po) => ({ id: po.id, poNo: po.poNo, supplier: po.supplier.name, expectedDate: po.expectedDate?.toISOString() ?? null })),
        },
        awaitingFabric: {
          count: awaitingFabric.length,
          kg: awaitingFabric.reduce((sum, d) => sum + Number(d.weightKg), 0),
          next: awaitingFabric.slice(0, 4).map((d) => ({
            id: d.id,
            flowNo: d.flow.flowNo,
            warehouseId: d.warehouse?.id ?? null,
            warehouse: d.warehouse?.code ?? 'Warehouse',
            kg: Number(d.weightKg),
            deliveredAt: d.deliveredAt.toISOString(),
          })),
        },
        sales: {
          waiting: salesWaiting,
          sentBack: salesSentBack,
          thisMonth: { count: salesMonth._count, kg: Number(soldKgMonth._sum.dispatchedQty ?? 0), amount: isAdmin ? Number(salesMonth._sum.totalAmount ?? 0) : null },
          recent: recent.sales.map((sale) => ({
            id: sale.id,
            saleNo: sale.saleNo,
            saleDate: sale.saleDate.toISOString(),
            party: sale.partyName,
            status: sale.status,
            total: Number(sale.totalAmount),
            payment: salePayment(Number(sale.totalAmount), recent.paid.get(sale.id)).status,
          })),
        },
        money: money && {
          payable: money.parties.payable,
          distributorsOwed: money.parties.distributorsToPay,
          receivable: money.parties.receivable,
          partiesDue: money.parties.textilesDue + money.parties.distributorsDue,
          advanceReceived: money.parties.advanceReceived,
          balances: money.balances,
          chequesIn: money.cheques.received,
          chequesOut: money.cheques.issued,
          month: money.month,
        },
        attention,
        alerts: notifications,
        unreadNotifications,
        processUpdates,
      },
    };
  }

  private dayKey(value: Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
}
