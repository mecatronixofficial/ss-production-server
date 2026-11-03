import { FabricProductionFlow, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const n = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Below this a weight difference is "equal" (scales weigh to the gram). */
const EQUAL_KG = 0.001;

/** What went in against what came out of a step: lost, equal or gained, and by how much. */
export function weightCheck(inKg: number, outKg: number) {
  const diff = round(outKg - inKg);
  return {
    inKg: round(inKg),
    outKg: round(outKg),
    diffKg: diff,
    pct: inKg > 0 ? round((diff / inKg) * 100, 2) : 0,
    result: Math.abs(diff) < EQUAL_KG ? ('EQUAL' as const) : diff < 0 ? ('LOSS' as const) : ('GAIN' as const),
  };
}

type Flow = Pick<
  FabricProductionFlow,
  | 'id'
  | 'flowNo'
  | 'parentId'
  | 'status'
  | 'fabricType'
  | 'fabricDiameter'
  | 'fabricGsm'
  | 'color'
  | 'yarnCount'
  | 'knittingMillType'
  | 'knittingMillDetails'
  | 'knittingPartyDetails'
  | 'knittingDate'
  | 'purchaseDate'
  | 'knittingFinishedAt'
  | 'yarnReceivedKg'
  | 'plannedFabricKg'
  | 'purchasedWeightKg'
  | 'knittingDeliveryKg'
  | 'dyeingDeliveryKg'
  | 'dyeingDate'
  | 'dyeingMillDetails'
  | 'fabricReceivedKg'
  | 'dyeingOutputWeightKg'
  | 'compactingDate'
  | 'compactingMillDetails'
  | 'officeDeliveryKg'
  | 'finalDeliveredKg'
  | 'knittingDestination'
  | 'dyeingDestination'
  | 'dyeingBalanceKg'
  | 'compactingBalanceKg'
> & {
  /** Where its fabric went: parties and warehouses (finished fabric, or straight from knitting / dyeing). */
  deliveries?: Array<{ destination: string; partyName: string | null; weightKg: Prisma.Decimal | number; deliveredAt: Date; warehouse: { code: string } | null }>;
};

const flowSelect = {
  id: true,
  flowNo: true,
  parentId: true,
  status: true,
  fabricType: true,
  fabricDiameter: true,
  fabricGsm: true,
  color: true,
  yarnCount: true,
  knittingMillType: true,
  knittingMillDetails: true,
  knittingPartyDetails: true,
  knittingDate: true,
  purchaseDate: true,
  knittingFinishedAt: true,
  yarnReceivedKg: true,
  plannedFabricKg: true,
  purchasedWeightKg: true,
  knittingDeliveryKg: true,
  dyeingDeliveryKg: true,
  dyeingDate: true,
  dyeingMillDetails: true,
  fabricReceivedKg: true,
  dyeingOutputWeightKg: true,
  compactingDate: true,
  compactingMillDetails: true,
  officeDeliveryKg: true,
  finalDeliveredKg: true,
  knittingDestination: true,
  dyeingDestination: true,
  dyeingBalanceKg: true,
  compactingBalanceKg: true,
  deliveries: {
    where: { processStage: 'FINAL' },
    select: { destination: true, partyName: true, weightKg: true, deliveredAt: true, warehouse: { select: { code: true } } },
    orderBy: { deliveredAt: 'asc' as const },
  },
} satisfies Prisma.FabricProductionFlowSelect;

/** Yarn movements by type, KG: what came in, went to knitting, came back and went elsewhere. */
type YarnMovement = { txnType: string; inKg: number; outKg: number };

/** Where the yarn came from: its delivery in the yarn received register (or purchase order). */
export type YarnSource = { receiptNo: string; date: Date; dcNo: string | null; mill: string; agent: string | null; bags: string | null; bagCount: number | null; weightKg: number; poNo: string | null };

/** Where a colour (or an older batch dyed on itself) is now. */
const stageOf = (f: Flow) => {
  const finished = n(f.officeDeliveryKg);
  if (finished !== null) return (n(f.finalDeliveredKg) ?? 0) >= finished - 0.0005 ? 'DELIVERED' : 'TO_DELIVER';
  if (f.compactingDate) return 'COMPACTING';
  if (f.dyeingOutputWeightKg !== null) return 'DYED';
  if (f.dyeingDate) return 'DYEING';
  return 'NOT_DYED';
};

/**
 * One yarn code's whole story, from the yarn received to the fabric delivered: the yarn in and out of stock; each
 * knitting batch made from it (yarn given, used, grey fabric knitted, loss); each colour its grey fabric was dyed in
 * (dyeing lots, or the batch itself on older batches) with the grey taken, dyed and finished weight and deliveries;
 * and, at every step and for the finished fabric against the yarn it used, whether weight was lost, equal or gained.
 */
export function buildYarnStory(code: string, name: string | null, movements: YarnMovement[], flows: Flow[], focus: string, received: YarnSource[] = []) {
  const sum = (types: string[], side: 'inKg' | 'outKg') => movements.filter((m) => types.includes(m.txnType)).reduce((total, m) => total + m[side], 0);
  const allIn = movements.reduce((t, m) => t + m.inKg, 0);
  const allOut = movements.reduce((t, m) => t + m.outKg, 0);
  const yarn = {
    code,
    name,
    receivedKg: round(sum(['OPENING', 'PURCHASE_IN', 'RETURN_IN', 'ADJUSTMENT', 'PRODUCTION_IN'], 'inKg')),
    toKnittingKg: round(sum(['KNITTING_ISSUE'], 'outKg')),
    returnedKg: round(sum(['KNITTING_RETURN'], 'inKg')),
    otherOutKg: round(sum(['PRODUCTION_ISSUE', 'DISPATCH_OUT', 'WASTE', 'ADJUSTMENT'], 'outKg')),
    inStockKg: round(allIn - allOut),
  };

  const lotsOf = new Map<string, Flow[]>();
  for (const f of flows) if (f.parentId) lotsOf.set(f.parentId, [...(lotsOf.get(f.parentId) ?? []), f]);

  /** Where a batch's fabric was delivered: to whom (a party or a warehouse), how much and when. */
  const deliveriesOf = (f: Flow) =>
    (f.deliveries ?? []).map((d) => ({
      to: d.destination === 'CUSTOMER' ? (d.partyName ?? 'Party') : (d.warehouse?.code ?? 'Warehouse'),
      toParty: d.destination === 'CUSTOMER',
      kg: round(Number(d.weightKg)),
      date: d.deliveredAt,
    }));

  const colour = (f: Flow, own: boolean) => {
    const grey = own ? n(f.fabricReceivedKg) ?? n(f.dyeingDeliveryKg) ?? 0 : n(f.purchasedWeightKg)!;
    const dyed = n(f.dyeingOutputWeightKg);
    const finished = n(f.officeDeliveryKg);
    const out = finished ?? dyed;
    return {
      flowNo: f.flowNo,
      /** An older batch dyed on itself: its colour is the batch, not a lot of its own. */
      ownBatch: own,
      color: f.color,
      stage: stageOf(f),
      dyeingMill: f.dyeingMillDetails,
      compactingMill: f.compactingMillDetails,
      dyeingDate: f.dyeingDate,
      greyKg: round(grey),
      dyedKg: dyed,
      finishedKg: finished,
      deliveredKg: n(f.finalDeliveredKg) ?? 0,
      deliveries: deliveriesOf(f),
      /** Delivered straight from dyeing to a party (no compacting). */
      soldAtDyeing: f.dyeingDestination === 'PARTY',
      /** Fabric each process didn't use, back in a warehouse. */
      dyeingBalanceKg: n(f.dyeingBalanceKg),
      compactingBalanceKg: n(f.compactingBalanceKg),
      dyeing: dyed !== null ? weightCheck(grey, dyed) : null,
      compacting: dyed !== null && finished !== null ? weightCheck(dyed, finished) : null,
      /** Grey fabric to the latest weight so far (finished, else dyed). */
      overall: out !== null ? weightCheck(grey, out) : null,
    };
  };

  const batches = flows
    .filter((f) => !f.parentId)
    .map((f) => {
      const given = n(f.yarnReceivedKg) ?? n(f.purchasedWeightKg)!;
      const knittingDone = f.knittingFinishedAt !== null || f.dyeingDeliveryKg !== null;
      const used = n(f.purchasedWeightKg)!;
      const grey = knittingDone ? (n(f.knittingDeliveryKg) ?? n(f.dyeingDeliveryKg)) : null;
      const lots = (lotsOf.get(f.id) ?? []).sort((a, b) => a.flowNo.localeCompare(b.flowNo, undefined, { numeric: true }));
      const dyedOnItself = f.dyeingDate !== null || f.dyeingOutputWeightKg !== null;
      const colours = lots.length ? lots.map((lot) => colour(lot, false)) : dyedOnItself ? [colour(f, true)] : [];
      const inColours = colours.reduce((t, c) => t + c.greyKg, 0);
      return {
        flowNo: f.flowNo,
        status: f.status,
        fabric: { type: f.fabricType, diameter: f.fabricDiameter, gsm: f.fabricGsm },
        millType: f.knittingMillType,
        mill: f.knittingMillType === 'OWN' ? 'Own mill' : (f.knittingMillDetails ?? f.knittingPartyDetails),
        startedAt: f.knittingDate ?? f.purchaseDate,
        finishedAt: f.knittingFinishedAt,
        knitting: !knittingDone,
        plannedFabricKg: n(f.plannedFabricKg),
        yarnGivenKg: round(given),
        /** Yarn used once knitting is finished; the yarn given while it is knitting. */
        yarnUsedKg: round(used),
        yarnReturnedKg: knittingDone ? round(Math.max(0, given - used)) : 0,
        greyKg: grey === null ? null : round(grey),
        knittingCheck: grey === null ? null : weightCheck(used, grey),
        /** Grey fabric not (yet) dyed in a colour. */
        greyLeftKg: grey === null ? null : round(Math.max(0, grey - inColours)),
        /** Grey fabric delivered straight from knitting to a party (the batch ended there). */
        soldAtKnitting: f.knittingDestination === 'PARTY',
        deliveries: f.knittingDestination === 'PARTY' ? deliveriesOf(f) : [],
        colours,
      };
    })
    .sort((a, b) => a.flowNo.localeCompare(b.flowNo, undefined, { numeric: true }));

  // Totals over the whole yarn. Each step compares only what has been through it, so work in progress isn't a loss.
  const knitted = batches.filter((b) => b.greyKg !== null);
  const allColours = batches.flatMap((b) => b.colours.map((c) => ({ c, batch: b })));
  const dyed = allColours.filter(({ c }) => c.dyedKg !== null);
  const finished = allColours.filter(({ c }) => c.finishedKg !== null);
  const total = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((t, row) => t + pick(row), 0);
  // The yarn a finished colour used: its share of its knitting batch's yarn (grey taken ÷ grey knitted).
  const yarnShare = ({ c, batch }: (typeof allColours)[number]) => (batch.greyKg ? (c.greyKg / batch.greyKg) * batch.yarnUsedKg : 0);
  const colors = [...new Set(allColours.map(({ c }) => c.color?.trim()).filter((c): c is string => !!c))];

  // The yarn by the fabric made from it: yarn used, grey knitted, finished, and in which colours.
  const fabricOf = (b: (typeof batches)[number]) => [b.fabric.type, b.fabric.diameter && `${b.fabric.diameter} dia`, b.fabric.gsm && `${b.fabric.gsm} GSM`].filter(Boolean).join(' · ') || 'Fabric';
  const byFabricMap = new Map<string, { fabric: string; batches: number; yarnUsedKg: number; greyKg: number; finishedKg: number; colors: Set<string> }>();
  for (const b of batches) {
    const key = fabricOf(b);
    const row = byFabricMap.get(key) ?? { fabric: key, batches: 0, yarnUsedKg: 0, greyKg: 0, finishedKg: 0, colors: new Set<string>() };
    row.batches += 1;
    row.yarnUsedKg += b.yarnUsedKg;
    row.greyKg += b.greyKg ?? 0;
    for (const c of b.colours) {
      row.finishedKg += c.finishedKg ?? 0;
      if (c.color?.trim()) row.colors.add(c.color.trim());
    }
    byFabricMap.set(key, row);
  }
  const byFabric = [...byFabricMap.values()]
    .map((r) => ({ fabric: r.fabric, batches: r.batches, yarnUsedKg: round(r.yarnUsedKg), greyKg: round(r.greyKg), finishedKg: round(r.finishedKg), colors: [...r.colors] }))
    .sort((a, b) => b.yarnUsedKg - a.yarnUsedKg);

  return {
    code,
    focus,
    yarn,
    received,
    batches,
    byFabric,
    totals: {
      knittingBatches: batches.length,
      colours: allColours.length,
      colors,
      yarnUsedKg: round(total(batches, (b) => b.yarnUsedKg)),
      greyKg: round(total(knitted, (b) => b.greyKg ?? 0)),
      dyedKg: round(total(dyed, ({ c }) => c.dyedKg ?? 0)),
      finishedKg: round(total(finished, ({ c }) => c.finishedKg ?? 0)),
      deliveredKg: round(total(allColours, ({ c }) => c.deliveredKg)),
      greyLeftKg: round(total(knitted, (b) => b.greyLeftKg ?? 0)),
      knitting: knitted.length ? weightCheck(total(knitted, (b) => b.yarnUsedKg), total(knitted, (b) => b.greyKg ?? 0)) : null,
      dyeing: dyed.length ? weightCheck(total(dyed, ({ c }) => c.greyKg), total(dyed, ({ c }) => c.dyedKg ?? 0)) : null,
      compacting: finished.length ? weightCheck(total(finished, ({ c }) => c.dyedKg ?? 0), total(finished, ({ c }) => c.finishedKg ?? 0)) : null,
      /** The finished fabric against the yarn it was made from (for the colours finished so far). */
      final: finished.length ? weightCheck(total(finished, yarnShare), total(finished, ({ c }) => c.finishedKg ?? 0)) : null,
    },
  };
}

export type YarnStory = ReturnType<typeof buildYarnStory>;

/**
 * The yarn story behind any code: a yarn code itself, a knitting batch (01SS26-KT01), a dyeing lot (…-DY01) or a
 * machine run (…-R1) leads back to its yarn. Null when the code has no production behind it.
 */
export async function yarnStory(prisma: PrismaService, code: string): Promise<YarnStory | null> {
  // A batch made from the yarn, or the batch the code is: either way its yarn code.
  const made = await prisma.fabricProductionFlow.findFirst({ where: { OR: [{ yarnItemCode: code }, { flowNo: code }] }, select: { yarnItemCode: true } });
  let root = made?.yarnItemCode ?? null;
  if (!root) {
    const run = await prisma.knittingRun.findUnique({ where: { runNo: code }, select: { productionFlow: { select: { yarnItemCode: true } } } });
    root = run?.productionFlow?.yarnItemCode ?? null;
  }
  if (!root) return null;

  const [flows, movements, named, line, ordered] = await Promise.all([
    prisma.fabricProductionFlow.findMany({ where: { yarnItemCode: root }, select: flowSelect, orderBy: { flowNo: 'asc' } }),
    prisma.stockTransaction.groupBy({ by: ['txnType'], where: { itemCode: root, category: 'YARN', unit: { equals: 'KG', mode: 'insensitive' } }, _sum: { quantityIn: true, quantityOut: true } }),
    prisma.stockTransaction.findFirst({ where: { itemCode: root, category: 'YARN' }, orderBy: { createdAt: 'asc' }, select: { itemName: true } }),
    prisma.yarnReceiptLine.findUnique({ where: { itemCode: root }, include: { receipt: true } }),
    prisma.purchaseReceiptItem.findMany({
      where: { purchaseOrderItem: { itemCode: root } },
      include: { purchaseReceipt: { select: { receiptNo: true, receivedAt: true, challanNo: true } }, purchaseOrderItem: { select: { purchaseOrder: { select: { poNo: true, supplier: { select: { name: true } } } } } } },
    }),
  ]);
  const received: YarnSource[] = [
    ...(line
      ? [{ receiptNo: line.receipt.receiptNo, date: line.receipt.receivedAt, dcNo: line.receipt.dcNo, mill: line.receipt.millName, agent: line.receipt.agentName, bags: line.bags, bagCount: line.bagCount, weightKg: Number(line.weightKg), poNo: null }]
      : []),
    ...ordered.map((item) => ({
      receiptNo: item.purchaseReceipt.receiptNo,
      date: item.purchaseReceipt.receivedAt,
      dcNo: item.purchaseReceipt.challanNo,
      mill: item.purchaseOrderItem.purchaseOrder.supplier.name,
      agent: null,
      bags: null,
      bagCount: null,
      weightKg: Number(item.quantity),
      poNo: item.purchaseOrderItem.purchaseOrder.poNo,
    })),
  ];
  return buildYarnStory(
    root,
    named?.itemName ?? flows[0]?.yarnCount ?? null,
    movements.map((m) => ({ txnType: m.txnType, inKg: n(m._sum.quantityIn) ?? 0, outKg: n(m._sum.quantityOut) ?? 0 })),
    flows,
    code,
    received,
  );
}
