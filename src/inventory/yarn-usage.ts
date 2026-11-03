import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const n = (value: Prisma.Decimal | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const round = (value: number) => Math.round(value * 1000) / 1000;

/** A knitting batch a yarn went into: its fabric, yarn (used once finished, given while knitting) and fabric made. */
export type YarnKnit = { flowNo: string; fabric: string; mill: string | null; startedAt: Date | null; done: boolean; yarnKg: number; fabricKg: number | null; colours: number };

/** Where a yarn code is now: in stock, at knitting (given less what came back), back from knitting, out otherwise. */
export type YarnUsage = { inStockKg: number; toKnittingKg: number; returnedKg: number; otherOutKg: number; knitting: YarnKnit[] };

/**
 * Where each yarn code's yarn is now and the knitting batches it went into, for the yarn received register and the
 * Purchases page's yarn view. Codes without any movement are left out.
 */
export async function yarnUsage(prisma: PrismaService, codes: Array<string | null | undefined>) {
  const wanted = [...new Set(codes.filter((c): c is string => !!c))];
  const result = new Map<string, YarnUsage>();
  if (!wanted.length) return result;
  const [moved, batches] = await Promise.all([
    prisma.stockTransaction.groupBy({ by: ['itemCode', 'txnType'], where: { itemCode: { in: wanted }, category: 'YARN' }, _sum: { quantityIn: true, quantityOut: true } }),
    prisma.fabricProductionFlow.findMany({
      where: { yarnItemCode: { in: wanted }, parentId: null },
      select: {
        flowNo: true,
        yarnItemCode: true,
        fabricType: true,
        fabricDiameter: true,
        fabricGsm: true,
        knittingMillType: true,
        knittingMillDetails: true,
        knittingDate: true,
        knittingFinishedAt: true,
        purchasedWeightKg: true,
        yarnReceivedKg: true,
        knittingDeliveryKg: true,
        dyeingDeliveryKg: true,
        _count: { select: { lots: true } },
      },
      orderBy: { flowNo: 'asc' },
    }),
  ]);
  const raw = new Map<string, { inStock: number; issued: number; returned: number; other: number }>();
  for (const m of moved) {
    const row = raw.get(m.itemCode) ?? { inStock: 0, issued: 0, returned: 0, other: 0 };
    const inKg = n(m._sum.quantityIn) ?? 0;
    const outKg = n(m._sum.quantityOut) ?? 0;
    row.inStock += inKg - outKg;
    if (m.txnType === 'KNITTING_ISSUE') row.issued += outKg;
    if (m.txnType === 'KNITTING_RETURN') row.returned += inKg;
    if (['DISPATCH_OUT', 'WASTE', 'PRODUCTION_ISSUE', 'ADJUSTMENT'].includes(m.txnType)) row.other += outKg;
    raw.set(m.itemCode, row);
  }
  for (const [code, r] of raw) {
    result.set(code, {
      inStockKg: round(r.inStock),
      toKnittingKg: round(Math.max(0, r.issued - r.returned)),
      returnedKg: round(r.returned),
      otherOutKg: round(r.other),
      knitting: batches
        .filter((b) => b.yarnItemCode === code)
        .map((b) => {
          const done = b.knittingFinishedAt !== null || b.dyeingDeliveryKg !== null;
          return {
            flowNo: b.flowNo,
            fabric: [b.fabricType, b.fabricDiameter && `${b.fabricDiameter} dia`, b.fabricGsm && `${b.fabricGsm} GSM`].filter(Boolean).join(' · ') || 'Fabric',
            mill: b.knittingMillType === 'OWN' ? 'Own mill' : b.knittingMillDetails,
            startedAt: b.knittingDate,
            done,
            yarnKg: round(done ? n(b.purchasedWeightKg)! : (n(b.yarnReceivedKg) ?? n(b.purchasedWeightKg)!)),
            fabricKg: n(b.knittingDeliveryKg) ?? n(b.dyeingDeliveryKg),
            colours: b._count.lots,
          };
        }),
    });
  }
  return result;
}

/**
 * Yarn out at knitting (taken from a warehouse, knitting not finished): not stock any more, so each batch shows where
 * it is instead: the knitting batch, the mill or the machines knitting it, the yarn given, used so far (the machines'
 * day-end entries) and left there. Only one warehouse's yarn with `warehouseId`.
 */
export async function yarnAtKnitting(prisma: PrismaService, warehouseId?: string) {
  const flows = await prisma.fabricProductionFlow.findMany({
    where: { parentId: null, status: 'KNITTING', knittingFinishedAt: null, yarnIssueTxnId: { not: null }, ...(warehouseId ? { yarnWarehouseId: warehouseId } : {}) },
    select: {
      id: true,
      flowNo: true,
      yarnItemCode: true,
      yarnCount: true,
      yarnLotNo: true,
      yarnReceivedKg: true,
      purchasedWeightKg: true,
      fabricType: true,
      fabricDiameter: true,
      fabricGsm: true,
      knittingMillType: true,
      knittingMillDetails: true,
      knittingDate: true,
      yarnWarehouse: { select: { id: true, code: true } },
      knittingRuns: { select: { runNo: true, status: true, yarnKg: true, outputKg: true, machine: { select: { code: true } } }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: [{ knittingDate: 'asc' }, { flowNo: 'asc' }],
  });
  return flows.map((f) => {
    const given = n(f.yarnReceivedKg) ?? n(f.purchasedWeightKg)!;
    const used = f.knittingRuns.reduce((sum, r) => sum + Number(r.yarnKg), 0);
    return {
      flowNo: f.flowNo,
      yarnItemCode: f.yarnItemCode,
      yarnName: f.yarnCount,
      lotNo: f.yarnLotNo,
      warehouse: f.yarnWarehouse,
      fabric: [f.fabricType, f.fabricDiameter && `${f.fabricDiameter} dia`, f.fabricGsm && `${f.fabricGsm} GSM`].filter(Boolean).join(' · ') || 'Fabric',
      own: f.knittingMillType === 'OWN',
      mill: f.knittingMillType === 'OWN' ? 'Own mill' : (f.knittingMillDetails ?? 'Other mill'),
      startedAt: f.knittingDate,
      givenKg: round(given),
      /** Own mill: from the machines' day-end entries; another mill reports only when it finishes. */
      usedKg: round(used),
      knittedKg: round(f.knittingRuns.reduce((sum, r) => sum + Number(r.outputKg ?? 0), 0)),
      leftKg: round(Math.max(0, given - used)),
      machines: f.knittingRuns.map((r) => ({ code: r.machine.code, runNo: r.runNo, running: r.status === 'RUNNING' })),
    };
  });
}
