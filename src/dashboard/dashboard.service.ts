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

  private inFlightRequests = new Map<string, ReturnType<DashboardService['load']>>();

  get(user: AuthUser, trendDays = 7) {
    // Reuse the same work when the browser sends overlapping requests (e.g. Strict Mode), per user.
    const key = `${user.id}:${trendDays}`;
    let inFlight = this.inFlightRequests.get(key);
    if (!inFlight) {
      inFlight = this.load(user, trendDays).finally(() => this.inFlightRequests.delete(key));
      this.inFlightRequests.set(key, inFlight);
    }
    return inFlight;
  }

  private async load(user: AuthUser, trendDays: number) {
    const isAdmin = user.role === Role.SUPERADMIN || user.role === Role.ADMIN;
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const trendStart = new Date(todayStart);
    trendStart.setDate(trendStart.getDate() - (trendDays - 1));

    // Batches of reads, each below the connection pool size.
    const [flows, deliveredThisMonth, runs, machines] = await Promise.all([
      this.prisma.fabricProductionFlow.findMany({
        where: { status: { not: 'DELIVERED' } },
        include: { knittingRuns: { select: { yarnKg: true, status: true } } },
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
        where: { OR: [{ status: 'RUNNING' }, { finishedAt: { gte: trendStart } }] },
        select: { id: true, runNo: true, status: true, startedAt: true, startShift: true, finishedAt: true, yarnKg: true, outputKg: true, machine: { select: { id: true, code: true } } },
      }),
      this.prisma.machine.groupBy({ by: ['status'], where: { status: { not: MachineStatus.DISABLED } }, _count: true }),
    ]);

    const [stock, yarnIn, deliveries, purchaseOrders, awaitingFabric] = await Promise.all([
      this.prisma.stockTransaction.groupBy({ by: ['category', 'unit'], _sum: { quantityIn: true, quantityOut: true } }),
      this.prisma.stockTransaction.findMany({
        where: { category: 'YARN', unit: 'KG', txnType: 'PURCHASE_IN', createdAt: { gte: trendStart } },
        select: { createdAt: true, quantityIn: true },
      }),
      this.prisma.fabricFlowDelivery.findMany({
        where: { processStage: 'FINAL', destination: 'CUSTOMER', deliveredAt: { gte: trendStart } },
        select: { deliveredAt: true, weightKg: true },
      }),
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
    ]);

    const [notifications, unreadNotifications, negativePositions, lastDelivery, processUpdates] = await Promise.all([
      this.prisma.notification.findMany({
        where: { isRead: false, userId: user.id },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, message: true, type: true, priority: true, createdAt: true },
      }),
      this.prisma.notification.count({ where: { isRead: false, userId: user.id } }),
      this.prisma.stockTransaction.groupBy({
        by: ['itemCode', 'lotNo', 'warehouseId', 'unit'],
        _sum: { quantityIn: true, quantityOut: true },
      }),
      this.prisma.fabricFlowDelivery.aggregate({ where: { processStage: 'FINAL', destination: 'CUSTOMER' }, _max: { deliveredAt: true } }),
      // Production updates: the latest processes completed (knitting, dyeing, compacting, machine runs), read or not.
      this.prisma.notification.findMany({
        where: { userId: user.id, type: 'JOB_COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, title: true, message: true, priority: true, isRead: true, createdAt: true, referenceType: true, referenceId: true },
      }),
    ]);
    const KG = { equals: 'KG', mode: 'insensitive' as const };
    const [salesWaiting, salesSentBack, salesMonth, soldKgMonth, soldTrend] = await Promise.all([
      this.prisma.sale.count({ where: { status: 'PENDING' } }),
      isAdmin ? this.prisma.sale.count({ where: { status: 'REJECTED' } }) : 0,
      // Sales billed this month: dispatched bills by bill date, as on Finance.
      this.prisma.sale.aggregate({ where: { status: 'DISPATCHED', saleDate: { gte: monthStart } }, _sum: { totalAmount: true }, _count: true }),
      this.prisma.saleItem.aggregate({ where: { unit: KG, sale: { status: 'DISPATCHED', saleDate: { gte: monthStart } } }, _sum: { dispatchedQty: true } }),
      // Material that left by sale, on the day it was dispatched.
      this.prisma.saleItem.findMany({
        where: { unit: KG, sale: { status: 'DISPATCHED', dispatchedAt: { gte: trendStart } } },
        select: { dispatchedQty: true, sale: { select: { dispatchedAt: true } } },
      }),
    ]);
    // The Money page's overview runs a dozen reads of its own, so it goes on its own.
    const [money, recentSales] = isAdmin
      ? await Promise.all([
          this.money.summary(),
          this.prisma.sale.findMany({
            where: { status: { not: 'CANCELLED' } },
            orderBy: { createdAt: 'desc' },
            take: 6,
            select: { id: true, saleNo: true, saleDate: true, partyName: true, status: true, totalAmount: true },
          }),
        ])
      : [null, []];
    const recentMoney = await saleMoney(
      this.prisma,
      recentSales.map((sale) => sale.id),
    );

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
    const readyKg = views.filter(({ flow }) => flow.status === 'AT_OFFICE').reduce((sum, { view }) => sum + view.metrics.balanceFabricKg, 0);
    const knittingTasks = flows.filter((f) => {
      if (f.status !== 'KNITTING' || f.knittingMillType !== 'OWN' || f.knittingFinishedAt) return false;
      const allocated = f.knittingRuns.reduce((sum, run) => sum + Number(run.yarnKg), 0);
      return allocated < Number(f.purchasedWeightKg) - EMPTY;
    }).length;

    // ---- Machines and runs
    const machineCounts = Object.fromEntries(machines.map((m) => [m.status, m._count])) as Record<string, number>;
    const machineTotal = machines.reduce((sum, m) => sum + m._count, 0);
    const running = runs.filter((r) => r.status === 'RUNNING');
    const finishedToday = runs.filter((r) => r.finishedAt && r.finishedAt >= todayStart);

    // ---- Trend: yarn received, fabric knitted, fabric delivered (KG per day)
    const trend = Array.from({ length: trendDays }, (_, i) => {
      const date = new Date(trendStart);
      date.setDate(date.getDate() + i);
      return { date: this.dayKey(date), yarnInKg: 0, knittedKg: 0, deliveredKg: 0, soldKg: 0 };
    });
    const byDay = new Map(trend.map((d) => [d.date, d]));
    for (const row of yarnIn) { const d = byDay.get(this.dayKey(row.createdAt)); if (d) d.yarnInKg += Number(row.quantityIn); }
    for (const run of runs) { if (run.finishedAt && run.outputKg !== null) { const d = byDay.get(this.dayKey(run.finishedAt)); if (d) d.knittedKg += Number(run.outputKg); } }
    for (const row of deliveries) { const d = byDay.get(this.dayKey(row.deliveredAt)); if (d) d.deliveredKg += Number(row.weightKg); }
    for (const row of soldTrend) { if (row.sale.dispatchedAt) { const d = byDay.get(this.dayKey(row.sale.dispatchedAt)); if (d) d.soldKg += Number(row.dispatchedQty ?? 0); } }

    // ---- Stock in KG (other units are shown on the Warehouses page)
    const stockKg = Object.fromEntries(FABRIC.map((c) => [c, 0])) as Record<(typeof FABRIC)[number], number>;
    for (const row of stock) {
      if (row.unit !== 'KG' || !(row.category in stockKg)) continue;
      stockKg[row.category as (typeof FABRIC)[number]] += Number(row._sum.quantityIn ?? 0) - Number(row._sum.quantityOut ?? 0);
    }
    const negativeCount = negativePositions.filter((p) => Number(p._sum.quantityIn ?? 0) - Number(p._sum.quantityOut ?? 0) < -EMPTY).length;

    // ---- Purchases
    const overduePOs = purchaseOrders.filter((po) => po.expectedDate && po.expectedDate < todayStart);
    const toArriveValue = purchaseOrders.reduce(
      (sum, po) => sum + po.items.reduce((s, item) => s + Math.max(0, Number(item.quantity) - item.receiptItems.reduce((r, x) => r + Number(x.quantity), 0)) * Number(item.rate), 0),
      0,
    );

    // ---- What needs someone's attention, most urgent first
    const attention: Array<{ tone: 'danger' | 'warning' | 'info'; text: string; href: string }> = [];
    const push = (when: boolean, item: (typeof attention)[number]) => { if (when) attention.push(item); };
    const down = (machineCounts.MAINTENANCE ?? 0) + (machineCounts.BREAKDOWN ?? 0);
    push(down > 0, { tone: 'danger', text: `${down} machine${down === 1 ? '' : 's'} out of service`, href: '/masters/machines' });
    push(overduePOs.length > 0, { tone: 'danger', text: `${overduePOs.length} purchase order${overduePOs.length === 1 ? '' : 's'} past the expected date${overduePOs[0] ? ` (${overduePOs[0].poNo} · ${overduePOs[0].supplier.name})` : ''}`, href: isAdmin ? '/purchases' : '/warehouses' });
    push(negativeCount > 0, { tone: 'danger', text: `${negativeCount} stock position${negativeCount === 1 ? ' is' : 's are'} below zero; check the entries`, href: '/warehouses' });
    push(salesSentBack > 0, { tone: 'danger', text: `${salesSentBack} sale${salesSentBack === 1 ? ' was' : 's were'} sent back by the warehouse`, href: '/sales' });
    const cheques = money?.cheques;
    push(!!cheques && cheques.bouncedMonth.count > 0, { tone: 'danger', text: `${cheques?.bouncedMonth.count} cheque${cheques?.bouncedMonth.count === 1 ? '' : 's'} bounced this month`, href: '/money?tab=cheques' });
    push(salesWaiting > 0, { tone: 'warning', text: `${salesWaiting} sale${salesWaiting === 1 ? '' : 's'} waiting to be verified and dispatched`, href: isAdmin ? '/sales' : '/warehouses' });
    push(knittingTasks > 0, { tone: 'warning', text: `${knittingTasks} knitting task${knittingTasks === 1 ? '' : 's'} waiting for a machine`, href: '/masters/machines' });
    push(awaitingFabric.length > 0, { tone: 'warning', text: `${awaitingFabric.length} fabric deliver${awaitingFabric.length === 1 ? 'y' : 'ies'} waiting to be received in a warehouse`, href: awaitingFabric[0] ? `/warehouses?warehouse=${awaitingFabric[0].warehouse?.id}` : '/warehouses' });
    const stuck = activeBatches.filter((b) => b.status !== 'PURCHASED' && b.daysInStage > STUCK_DAYS);
    push(stuck.length > 0, { tone: 'warning', text: `${stuck.length} batch${stuck.length === 1 ? '' : 'es'} in the same stage for over ${STUCK_DAYS} days (${stuck[0]?.flowNo})`, href: `/production?batch=${encodeURIComponent(stuck[0]?.flowNo ?? '')}` });
    push(!!cheques && cheques.toDeposit.count > 0, { tone: 'warning', text: `${cheques?.toDeposit.count} received cheque${cheques?.toDeposit.count === 1 ? '' : 's'} waiting to be deposited`, href: '/money?tab=cheques' });
    push(stageCounts.AT_OFFICE > 0, { tone: 'info', text: `${stageCounts.AT_OFFICE} batch${stageCounts.AT_OFFICE === 1 ? '' : 'es'} ready to deliver (${readyKg.toFixed(0)} KG)`, href: '/production' });

    return {
      success: true,
      data: {
        generatedAt: now.toISOString(),
        isAdmin,
        production: {
          stages: STAGES.map((stage) => ({ key: stage, count: stageCounts[stage] })),
          active: flows.length,
          readyKg,
          deliveredThisMonth: { count: deliveredThisMonth._count, kg: Number(deliveredThisMonth._sum.weightKg ?? 0), amount: isAdmin ? Number(deliveredThisMonth._sum.amount ?? 0) : null },
          batches: activeBatches.slice(0, 8),
          lastDeliveryAt: lastDelivery._max.deliveredAt?.toISOString() ?? null,
        },
        machines: {
          total: machineTotal,
          byStatus: machineCounts,
          knitting: running.length,
          yarnOnMachinesKg: running.reduce((sum, r) => sum + Number(r.yarnKg), 0),
          finishedToday: { count: finishedToday.length, kg: finishedToday.reduce((sum, r) => sum + Number(r.outputKg ?? 0), 0) },
          knittingTasks,
          running: running
            .map((r) => ({ id: r.id, runNo: r.runNo, machineId: r.machine.id, machine: r.machine.code, startedAt: r.startedAt.toISOString(), startShift: r.startShift, yarnKg: Number(r.yarnKg) }))
            .sort((a, b) => a.machine.localeCompare(b.machine)),
        },
        trend,
        stockKg,
        purchases: {
          open: purchaseOrders.length,
          overdue: overduePOs.length,
          toArriveValue: isAdmin ? toArriveValue : null,
          next: purchaseOrders.slice(0, 4).map((po) => ({ id: po.id, poNo: po.poNo, supplier: po.supplier.name, expectedDate: po.expectedDate?.toISOString() ?? null })),
        },
        awaitingFabric: { count: awaitingFabric.length, kg: awaitingFabric.reduce((sum, d) => sum + Number(d.weightKg), 0) },
        sales: {
          waiting: salesWaiting,
          sentBack: salesSentBack,
          thisMonth: { count: salesMonth._count, kg: Number(soldKgMonth._sum.dispatchedQty ?? 0), amount: isAdmin ? Number(salesMonth._sum.totalAmount ?? 0) : null },
          recent: recentSales.map((sale) => ({
            id: sale.id,
            saleNo: sale.saleNo,
            saleDate: sale.saleDate.toISOString(),
            party: sale.partyName,
            status: sale.status,
            total: Number(sale.totalAmount),
            payment: salePayment(Number(sale.totalAmount), recentMoney.get(sale.id)).status,
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
