import { Prisma } from '@prisma/client';
import { fabricFlowView } from '../production/fabric-flow-view';
import { PrismaService } from '../prisma/prisma.service';

const n = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Everything that happened to an item code and what was made from it, for its details page:
 * - how much came in, was made, used, sold or moved (from every movement of the code, not just the latest);
 * - the production batches it went into (as yarn) or is (as fabric), each with its knitting (every machine run:
 *   machine, operator, start and finish, kg in and out, rolls, rate), dyeing, compacting and deliveries;
 * - knitting runs outside a batch that used it or knitted it;
 * - every sale of the code and of the fabric made from it.
 * Rates, costs and amounts only with `prices` (admins).
 */
export async function itemJourney(prisma: PrismaService, code: string, opts: { prices: boolean }) {
  const money = (value: Prisma.Decimal | number | null | undefined) => (opts.prices ? n(value) : null);

  // Runs that knitted this code, or loaded it as yarn; their batches belong to its story too.
  const runSelect = {
    id: true,
    runNo: true,
    status: true,
    fabricType: true,
    startedAt: true,
    startShift: true,
    finishedAt: true,
    finishShift: true,
    yarnKg: true,
    yarnCost: true,
    outputKg: true,
    rollCount: true,
    ratePerKg: true,
    knittingCharge: true,
    productionFlowId: true,
    machine: { select: { id: true, code: true, name: true } },
    operator: { select: { name: true } },
    warehouse: { select: { code: true } },
    yarns: { select: { itemCode: true, itemName: true, kg: true, ratePerKg: true, lotNo: true } },
  } satisfies Prisma.KnittingRunSelect;
  const [movementTotals, directRuns] = await Promise.all([
    prisma.stockTransaction.groupBy({ by: ['txnType', 'unit'], where: { itemCode: code }, _sum: { quantityIn: true, quantityOut: true } }),
    prisma.knittingRun.findMany({
      where: { OR: [{ runNo: code }, { yarns: { some: { itemCode: code } } }] },
      select: runSelect,
      orderBy: { startedAt: 'asc' },
    }),
  ]);
  const flowIdsFromRuns = [...new Set(directRuns.map((r) => r.productionFlowId).filter((id): id is string => !!id))];

  const flows = await prisma.fabricProductionFlow.findMany({
    where: { OR: [{ flowNo: code }, { yarnItemCode: code }, ...(flowIdsFromRuns.length ? [{ id: { in: flowIdsFromRuns } }] : [])] },
    include: {
      expenses: { select: { amount: true } },
      deliveries: { include: { warehouse: { select: { code: true, name: true } } }, orderBy: { deliveredAt: 'asc' } },
      knittingRuns: { select: runSelect, orderBy: { startedAt: 'asc' } },
      yarnWarehouse: { select: { code: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const runView = (r: Prisma.KnittingRunGetPayload<{ select: typeof runSelect }>) => ({
    runNo: r.runNo,
    status: r.status,
    fabricType: r.fabricType,
    machine: r.machine,
    operator: r.operator?.name ?? null,
    startedAt: r.startedAt,
    startShift: r.startShift,
    finishedAt: r.finishedAt,
    finishShift: r.finishShift,
    yarnKg: n(r.yarnKg)!,
    outputKg: n(r.outputKg),
    rollCount: r.rollCount,
    yarns: r.yarns.map((y) => ({
      itemCode: y.itemCode,
      itemName: y.itemName,
      kg: n(y.kg)!,
      lotNo: y.lotNo,
      ratePerKg: money(y.ratePerKg),
    })),
    ratePerKg: money(r.ratePerKg),
    charge: money(r.knittingCharge),
    yarnCost: money(r.yarnCost),
    warehouse: r.warehouse?.code ?? null,
  });

  const journey = flows.map((f) => {
    const v = fabricFlowView(f);
    const final = f.deliveries.filter((d) => d.processStage === 'FINAL');
    const handOffs = f.deliveries.filter((d) => d.processStage !== 'FINAL');
    const delivery = (d: (typeof f.deliveries)[number]) => ({
      id: d.id,
      stage: d.processStage,
      deliveredAt: d.deliveredAt,
      destination: d.destination,
      to: d.destination === 'CUSTOMER' ? (d.partyName ?? 'Party') : d.warehouse ? `${d.warehouse.code} · ${d.warehouse.name}` : 'Warehouse',
      weightKg: n(d.weightKg)!,
      amount: d.destination === 'CUSTOMER' ? money(d.amount) : null,
      expense: money(d.expense),
      receivedAt: d.receivedAt,
      receivedWeightKg: n(d.receivedWeightKg),
      notes: d.notes,
    });
    return {
      flowNo: f.flowNo,
      status: f.status,
      /** This code's place in the batch: the yarn it was made from, or the batch's own fabric. */
      role: f.flowNo === code ? 'FABRIC' : f.yarnItemCode === code ? 'YARN' : 'KNITTED',
      fabric: {
        type: f.fabricType,
        diameter: f.fabricDiameter,
        gsm: f.fabricGsm,
        gg: f.knittingGg ?? f.gg,
        ll: f.knittingLl ?? f.ll,
        color: f.color,
        count: f.dyeingCount ?? f.yarnCount,
      },
      yarn: {
        itemCode: f.yarnItemCode,
        name: f.yarnCount,
        kg: v.purchasedWeightKg,
        warehouse: f.yarnWarehouse?.code ?? null,
        lotNo: f.yarnLotNo,
        ratePerKg: opts.prices ? v.yarnRatePerKg : null,
        amount: opts.prices ? round(v.metrics.yarnAmount, 2) : null,
        startedAt: f.knittingDate ?? f.purchaseDate,
      },
      knitting: {
        millType: f.knittingMillType,
        party: f.knittingPartyDetails,
        mill: f.knittingMillDetails,
        startedAt: f.knittingDate,
        expectedFinish: f.knittingExpectedFinishDate,
        finishedAt: f.knittingFinishedAt,
        bags: f.knittingBagCount,
        outputKg: v.knittingDeliveryKg,
        destination: f.knittingDestination,
        deliveryPlace: f.knittingDeliveryPlace,
        expense: opts.prices ? v.knittingExpense : null,
        runs: f.knittingRuns.map(runView),
      },
      dyeing:
        f.dyeingDate || v.dyeingOutputWeightKg !== null
          ? {
              party: f.dyeingPartyDetails,
              mill: f.dyeingMillDetails,
              startedAt: f.dyeingDate,
              finishedAt: f.dyeingFinishedAt,
              receivedKg: v.fabricReceivedKg,
              outputKg: v.dyeingOutputWeightKg,
              sentKg: v.compactingDeliveryKg,
              color: f.color,
              rolls: f.rollCount,
              destination: f.dyeingDestination,
              expense: opts.prices ? v.dyeingExpense : null,
            }
          : null,
      compacting:
        f.compactingDate || v.officeDeliveryKg !== null
          ? {
              party: f.compactingPartyDetails,
              mill: f.compactingMillDetails,
              startedAt: f.compactingDate,
              finishedAt: f.compactingFinishedAt,
              receivedKg: v.compactingReceivedKg,
              outputKg: v.officeDeliveryKg,
              inwardNo: f.compactingInwardNo,
              outwardNo: f.compactingOutwardNo,
              expense: opts.prices ? v.compactingExpense : null,
            }
          : null,
      /** Process output sent into a warehouse (knitting / dyeing), and the finished fabric's deliveries. */
      handOffs: handOffs.map(delivery),
      deliveries: final.map(delivery),
      totals: {
        currentKg: round(v.metrics.currentWeightKg),
        lossKg: round(v.metrics.totalLossKg),
        lossPct: round(v.metrics.lossPct, 2),
        deliveredKg: v.finalDeliveredKg ?? 0,
        leftKg: round(v.metrics.balanceFabricKg),
        spent: opts.prices ? round(v.metrics.totalSpent, 2) : null,
        collected: opts.prices ? v.collectedAmount : null,
        profit: opts.prices ? round(v.metrics.profit, 2) : null,
      },
    };
  });

  // Runs outside any batch shown above (machine work not tied to a production batch).
  const inBatches = new Set(flows.flatMap((f) => f.knittingRuns.map((r) => r.runNo)));
  const runs = directRuns.filter((r) => !inBatches.has(r.runNo)).map(runView);

  // Sales of the code itself and of what was made from it (batch fabric, knitted runs).
  const related = [
    ...new Set([
      code,
      ...flows.map((f) => f.flowNo),
      ...directRuns.map((r) => r.runNo),
      ...flows.flatMap((f) => f.knittingRuns.map((r) => r.runNo)),
    ]),
  ];
  const saleItems = await prisma.saleItem.findMany({
    where: { itemCode: { in: related }, sale: { status: { not: 'CANCELLED' } } },
    select: {
      itemCode: true,
      itemName: true,
      lotNo: true,
      unit: true,
      quantity: true,
      dispatchedQty: true,
      rate: true,
      amount: true,
      sale: {
        select: {
          id: true,
          saleNo: true,
          challanNo: true,
          saleDate: true,
          dispatchedAt: true,
          partyName: true,
          status: true,
          warehouse: { select: { code: true } },
        },
      },
    },
    orderBy: { sale: { saleDate: 'desc' } },
  });
  const sales = saleItems.map((i) => ({
    saleId: i.sale.id,
    saleNo: i.sale.saleNo,
    challanNo: i.sale.challanNo,
    saleDate: i.sale.saleDate,
    dispatchedAt: i.sale.dispatchedAt,
    party: i.sale.partyName,
    status: i.sale.status,
    warehouse: i.sale.warehouse.code,
    itemCode: i.itemCode,
    itemName: i.itemName,
    lotNo: i.lotNo,
    unit: i.unit,
    quantity: n(i.dispatchedQty) ?? n(i.quantity)!,
    rate: money(i.rate),
    amount: money(i.amount),
  }));

  return {
    /** Every movement of the code added up by type: received, made, used, sold, moved. */
    totals: movementTotals.map((t) => ({
      txnType: t.txnType,
      unit: t.unit,
      quantityIn: n(t._sum.quantityIn) ?? 0,
      quantityOut: n(t._sum.quantityOut) ?? 0,
    })),
    journey,
    runs,
    sales,
  };
}
