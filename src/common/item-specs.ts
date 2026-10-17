import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** One fact about an item, as printed under it on a challan or bill: e.g. { label: 'GSM', value: '180' }. */
export type ItemSpec = { label: string; value: string };

const add = (specs: ItemSpec[], label: string, value: string | number | null | undefined) => {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (text && !specs.some((s) => s.label === label)) specs.push({ label, value: text });
};
const kg = (value: unknown) =>
  value === null || value === undefined ? null : `${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg`;

/**
 * Everything the ERP knows about each item code, for challans and bills:
 * - a production batch's fabric (code = batch, e.g. SS-2026-003-D1): type, diameter, GSM, GG, LL, colour, yarn, rolls;
 * - grey fabric off a knitting run (code = run, e.g. SS-2026-014): fabric, machine, rolls, the yarns knitted, and its
 *   batch's construction when it was knitted for one;
 * - purchased material (code given on its first receipt): material, distributor and PO.
 * No prices: challans and bills go to parties, so rates are shown in their own columns, to admins only.
 */
export async function itemSpecs(db: Db, codes: Array<string | null | undefined>) {
  const wanted = [...new Set(codes.filter((c): c is string => !!c))];
  const result = new Map<string, ItemSpec[]>();
  if (!wanted.length) return result;
  const flowSelect = {
    flowNo: true,
    fabricType: true,
    fabricDiameter: true,
    fabricGsm: true,
    knittingGg: true,
    knittingLl: true,
    gg: true,
    ll: true,
    color: true,
    yarnCount: true,
    dyeingCount: true,
    yarnItemCode: true,
    rollCount: true,
    knittingBagCount: true,
  } satisfies Prisma.FabricProductionFlowSelect;
  const [flows, runs, poItems] = await Promise.all([
    db.fabricProductionFlow.findMany({ where: { flowNo: { in: wanted } }, select: flowSelect }),
    db.knittingRun.findMany({
      where: { runNo: { in: wanted } },
      select: {
        runNo: true,
        fabricType: true,
        rollCount: true,
        yarnKg: true,
        outputKg: true,
        finishedAt: true,
        machine: { select: { code: true, name: true } },
        yarns: { select: { itemCode: true, itemName: true, kg: true } },
        productionFlow: { select: flowSelect },
      },
    }),
    db.purchaseOrderItem.findMany({
      where: { itemCode: { in: wanted } },
      select: {
        itemCode: true,
        itemName: true,
        category: true,
        purchaseOrder: { select: { poNo: true, orderDate: true, supplier: { select: { name: true } } } },
      },
      orderBy: { purchaseOrder: { orderDate: 'desc' } },
    }),
  ]);

  const flowSpecs = (specs: ItemSpec[], flow: Prisma.FabricProductionFlowGetPayload<{ select: typeof flowSelect }>) => {
    add(specs, 'Fabric', flow.fabricType);
    add(specs, 'Dia', flow.fabricDiameter);
    add(specs, 'GSM', flow.fabricGsm);
    add(specs, 'GG', flow.knittingGg ?? flow.gg);
    add(specs, 'LL', flow.knittingLl ?? flow.ll);
    add(specs, 'Colour', flow.color);
    add(specs, 'Count', flow.dyeingCount ?? flow.yarnCount);
    add(specs, 'Yarn', flow.yarnItemCode);
    add(specs, 'Rolls', flow.rollCount);
    add(specs, 'Bags', flow.knittingBagCount);
    add(specs, 'Batch', flow.flowNo);
  };

  for (const flow of flows) {
    const specs: ItemSpec[] = [];
    flowSpecs(specs, flow);
    result.set(flow.flowNo, specs);
  }
  for (const run of runs) {
    const specs: ItemSpec[] = [];
    add(specs, 'Fabric', run.fabricType);
    add(specs, 'Knitting run', run.runNo);
    add(specs, 'Machine', `${run.machine.code} · ${run.machine.name}`);
    add(specs, 'Rolls', run.rollCount);
    add(specs, 'Yarn loaded', kg(run.yarnKg));
    add(specs, 'Yarns', run.yarns.map((y) => `${y.itemCode} ${y.itemName}`).join(' + '));
    if (run.productionFlow) flowSpecs(specs, run.productionFlow);
    result.set(run.runNo, specs);
  }
  // Latest order of each code first, so a code bought twice shows its newest purchase.
  for (const item of poItems) {
    if (!item.itemCode || result.has(item.itemCode)) continue;
    const specs: ItemSpec[] = [];
    add(specs, 'Material', item.category ? item.category.replaceAll('_', ' ').toLowerCase() : null);
    add(specs, 'Distributor', item.purchaseOrder.supplier.name);
    add(specs, 'PO', item.purchaseOrder.poNo);
    result.set(item.itemCode, specs);
  }
  return result;
}

/** "Fabric Single jersey · Dia 22 · GSM 180 · GG 28 · Colour Navy" for a PDF line. */
export const specsText = (specs?: ItemSpec[] | null) => (specs ?? []).map((s) => `${s.label} ${s.value}`).join('  ·  ');

/**
 * The details worth printing under a line: without what its own cells already show (lot, material, the item code
 * itself, e.g. a batch whose code is the line's code).
 */
export const lineSpecs = (specs: ItemSpec[] | null | undefined, itemCode: string, hide: string[] = ['Lot', 'Material']) =>
  (specs ?? []).filter((s) => !hide.includes(s.label) && s.value !== itemCode);
