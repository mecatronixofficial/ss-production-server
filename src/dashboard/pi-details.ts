import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const relations = {
  expenses: { orderBy: { expenseDate: 'asc' as const } },
  deliveries: { include: { warehouse: { select: { code: true, name: true } } }, orderBy: { deliveredAt: 'asc' as const } },
  knittingRuns: { include: { machine: { select: { code: true } }, days: { select: { outputKg: true, yarnUsedKg: true } } } },
} satisfies Prisma.FabricProductionFlowInclude;
const include = {
  ...relations,
  lots: { include: relations, orderBy: { flowNo: 'asc' as const } },
} satisfies Prisma.FabricProductionFlowInclude;
export type PiFlow = Prisma.FabricProductionFlowGetPayload<{ include: typeof include }>;
type Node = Prisma.FabricProductionFlowGetPayload<{ include: typeof relations }>;
type Material = 'YARN' | 'GREY_FABRIC' | 'DYED_FABRIC' | 'FINISHED_FABRIC';
type Position = { itemCode: string; category: string; warehouseId: string; lotNo: string | null; kg: number; dispatchedKg: number };
type Purchase = { receiptNo: string; receivedAt: Date; mill: string; dcNo: string; weightKg: number; ratePerKg: number | null };
type PiSale = {
  id: string;
  code: string;
  billNo: string;
  date: string | null;
  party: string;
  warehouse: string;
  material: string;
  kg: number;
  rate: number;
  amount: number;
};
const n = (v: unknown) => Number(v ?? 0);
const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places;
const amount = (v: number) => round(v, 2);
const date = (v: Date | null) => v?.toISOString().slice(0, 10) ?? null;
const sum = <T>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
const knitted = (f: Node) =>
  f.knittingDeliveryKg === null ? (f.dyeingDeliveryKg === null ? null : n(f.dyeingDeliveryKg)) : n(f.knittingDeliveryKg);
const lastMaterial = (f: Node): Material =>
  f.officeDeliveryKg !== null
    ? 'FINISHED_FABRIC'
    : f.dyeingOutputWeightKg !== null
      ? 'DYED_FABRIC'
      : knitted(f) !== null
        ? 'GREY_FABRIC'
        : 'YARN';

/** One yarn batch and all its colour lots. A lot's inherited yarn/grey cost is never charged twice. */
export function piDetailsView(
  root: PiFlow,
  positions: Position[],
  warehouses: Map<string, string>,
  purchase: Purchase | null,
  sales: PiSale[] = [],
) {
  const nodes: Node[] = [root, ...root.lots];
  const fabricCodes = new Set(nodes.flatMap((f) => [f.flowNo, ...f.knittingRuns.map((r) => r.runNo)]));
  const stock = positions.filter((p) => fabricCodes.has(p.itemCode) && p.category !== 'YARN');
  const yarnStock = positions.filter((p) => p.itemCode === root.yarnItemCode && p.category === 'YARN' && p.lotNo === root.yarnLotNo);
  const fromStock = root.source === 'STOCK' || !!root.yarnIssueTxnId;
  const givenKg = n(root.yarnReceivedKg ?? root.purchasedWeightKg);
  const usedKg = root.knittingFinishedAt ? n(root.purchasedWeightKg) : null;
  const machineYarnUsed = sum(root.knittingRuns, (r) =>
    r.days.length ? sum(r.days, (d) => n(d.yarnUsedKg ?? d.outputKg)) : n(r.outputKg),
  );
  const yarnAtMillKg = root.knittingFinishedAt ? 0 : Math.max(0, givenKg - machineYarnUsed);
  const stages: Array<{
    batchCode: string;
    color: string | null;
    stage: string;
    state: string;
    startedAt: string | null;
    finishedAt: string | null;
    mill: string | null;
    inputKg: number;
    returnedKg: number;
    outputKg: number | null;
    lossKg: number | null;
    gainKg: number | null;
    expense: number;
    balanceKg: number | null;
  }> = [];
  const stage = (
    f: Node,
    name: string,
    start: Date | null,
    end: Date | null,
    mill: string | null,
    input: number,
    returned: number,
    output: number | null,
    expense: number,
    onward = 0,
  ) => {
    const closed = output !== null && (name !== 'Knitting' || !!end);
    const difference = closed ? input - returned - output : null;
    const terminal =
      name === 'Compacting' ||
      (name === 'Dyeing' && f.dyeingDestination === 'PARTY') ||
      (name === 'Knitting' && f.knittingDestination === 'PARTY');
    const delivered = terminal
      ? n(f.finalDeliveredKg)
      : sum(
          f.deliveries.filter((d) => d.destination === 'WAREHOUSE' && d.processStage === name.toUpperCase()),
          (d) => n(d.weightKg),
        );
    stages.push({
      batchCode: f.flowNo,
      color: f.color,
      stage: name,
      state: closed ? 'Completed' : start ? 'In progress' : 'Not started',
      startedAt: date(start),
      finishedAt: date(end),
      mill,
      inputKg: round(input),
      returnedKg: round(returned),
      outputKg: output === null ? null : round(output),
      lossKg: difference === null ? null : round(Math.max(0, difference)),
      gainKg: difference === null ? null : round(Math.max(0, -difference)),
      expense: amount(expense),
      balanceKg: output === null ? null : round(Math.max(0, output - onward - delivered)),
    });
  };
  const allocated = sum(root.lots, (f) => n(f.purchasedWeightKg));
  const rootKnitted = knitted(root);
  if (root.knittingDate || rootKnitted !== null || root.yarnIssueTxnId) {
    const machineOutput = sum(root.knittingRuns, (r) => n(r.outputKg));
    stage(
      root,
      'Knitting',
      root.knittingDate,
      root.knittingFinishedAt,
      root.knittingMillDetails || root.knittingPartyDetails || (root.knittingMillType === 'OWN' ? 'Own mill' : null),
      fromStock ? n(root.purchasedWeightKg) : givenKg,
      0,
      rootKnitted ?? (root.knittingRuns.length ? machineOutput : null),
      n(root.knittingExpense),
      root.lots.length ? allocated : root.dyeingDate ? n(root.dyeingDeliveryKg) - n(root.dyeingBalanceKg) : 0,
    );
  }
  for (const f of nodes) {
    if (f.dyeingDate || f.dyeingOutputWeightKg !== null || (!root.lots.length && f.dyeingDeliveryKg !== null))
      stage(
        f,
        'Dyeing',
        f.dyeingDate,
        f.dyeingFinishedAt,
        f.dyeingMillDetails || f.dyeingPartyDetails,
        n(f.dyeingDeliveryKg ?? f.fabricReceivedKg ?? f.purchasedWeightKg),
        n(f.dyeingBalanceKg),
        f.dyeingOutputWeightKg === null ? null : n(f.dyeingOutputWeightKg),
        n(f.dyeingExpense),
        f.compactingDate ? n(f.compactingDeliveryKg) - n(f.compactingBalanceKg) : 0,
      );
    if (f.compactingDate || f.officeDeliveryKg !== null || f.compactingDeliveryKg !== null)
      stage(
        f,
        'Compacting',
        f.compactingDate,
        f.compactingFinishedAt,
        f.compactingMillDetails || f.compactingPartyDetails,
        n(f.compactingDeliveryKg ?? f.compactingReceivedKg),
        n(f.compactingBalanceKg),
        f.officeDeliveryKg === null ? null : n(f.officeDeliveryKg),
        n(f.compactingExpense),
      );
  }
  const deliveries = nodes.flatMap((f) =>
    f.deliveries.map((d) => ({
      id: d.id,
      batchCode: f.flowNo,
      stage: d.processStage,
      date: date(d.deliveredAt),
      destination: d.destination,
      to: d.warehouse ? `${d.warehouse.code} · ${d.warehouse.name}` : (d.partyName ?? 'Party'),
      sentKg: n(d.weightKg),
      receivedKg: d.receivedWeightKg === null ? null : n(d.receivedWeightKg),
      receivedAt: date(d.receivedAt),
      amount: n(d.amount),
      expense: n(d.expense),
      material: d.processStage === 'KNITTING' ? 'GREY_FABRIC' : d.processStage === 'DYEING' ? 'DYED_FABRIC' : lastMaterial(f),
    })),
  );
  const partyKg = sum(nodes, (f) =>
    f.deliveries.some((d) => d.processStage === 'FINAL')
      ? sum(
          f.deliveries.filter((d) => d.destination === 'CUSTOMER'),
          (d) => n(d.weightKg),
        )
      : n(f.finalDeliveredKg),
  );
  const dispatchedKg = sum(stock, (p) => p.dispatchedKg);
  const pendingKg = sum(
    deliveries.filter((d) => d.destination === 'WAREHOUSE' && !d.receivedAt),
    (d) => d.sentKg,
  );
  const receiptDifferenceKg = sum(
    deliveries.filter((d) => d.destination === 'WAREHOUSE' && d.receivedKg !== null),
    (d) => d.sentKg - d.receivedKg!,
  );
  const balances = new Map<Material, number>();
  const add = (key: Material, kg: number) => balances.set(key, (balances.get(key) ?? 0) + kg);
  // Latest material per branch, plus unused material returned by a completed downstream process.
  if (root.lots.length) add('GREY_FABRIC', Math.max(0, n(rootKnitted) - allocated));
  for (const f of root.lots.length ? root.lots : [root]) {
    const material = lastMaterial(f);
    const quantity =
      material === 'FINISHED_FABRIC'
        ? n(f.officeDeliveryKg)
        : material === 'DYED_FABRIC'
          ? n(f.dyeingOutputWeightKg)
          : material === 'GREY_FABRIC'
            ? n(knitted(f))
            : n(f.yarnReceivedKg ?? f.purchasedWeightKg);
    if (material === 'YARN' && f.id === root.id && root.knittingRuns.length) {
      add('YARN', yarnAtMillKg);
      add(
        'GREY_FABRIC',
        sum(root.knittingRuns, (r) => n(r.outputKg)),
      );
    } else add(material, quantity);
    if (!root.lots.length) add('GREY_FABRIC', n(f.dyeingBalanceKg));
    if (material === 'FINISHED_FABRIC') add('DYED_FABRIC', n(f.compactingBalanceKg));
    const party = f.deliveries.some((d) => d.processStage === 'FINAL')
      ? sum(
          f.deliveries.filter((d) => d.destination === 'CUSTOMER'),
          (d) => n(d.weightKg),
        )
      : n(f.finalDeliveredKg);
    add(material, -party);
  }
  for (const p of stock) add(p.category as Material, -p.dispatchedKg);
  for (const d of deliveries) if (d.destination === 'WAREHOUSE' && d.receivedKg !== null) add(d.material, d.receivedKg - d.sentKg);
  const expenses = nodes.flatMap((f) =>
    f.expenses.map((e) => ({
      id: e.id,
      batchCode: f.flowNo,
      date: date(e.expenseDate),
      category: e.category,
      description: e.description,
      amount: n(e.amount),
    })),
  );
  const yarnAmount = amount(n(root.purchasedWeightKg) * n(root.yarnRatePerKg));
  const costs = {
    yarnAmount,
    purchaseOther: n(root.purchaseOtherCost),
    knitting: n(root.knittingExpense),
    dyeing: sum(nodes, (f) => n(f.dyeingExpense)),
    compacting: sum(nodes, (f) => n(f.compactingExpense)),
    delivery: sum(nodes, (f) => n(f.otherExpense)),
    additional: sum(expenses, (e) => e.amount),
  };
  const totalExpense = amount(costs.purchaseOther + costs.knitting + costs.dyeing + costs.compacting + costs.delivery + costs.additional);
  const netLoss =
    sum(stages, (s) => (s.lossKg ?? 0) - (s.gainKg ?? 0)) + (!fromStock ? Math.max(0, n(root.purchasedWeightKg) - givenKg) : 0);
  return {
    id: root.id,
    code: root.flowNo,
    piNo: root.piNo,
    yarnCode: root.yarnItemCode,
    yarnCount: root.yarnCount,
    fabric: [root.fabricType, root.fabricDiameter && `${root.fabricDiameter} dia`, root.fabricGsm && `${root.fabricGsm} GSM`]
      .filter(Boolean)
      .join(' · '),
    startedAt: date(root.purchaseDate),
    purchase: purchase
      ? {
          ...purchase,
          receivedAt: date(purchase.receivedAt),
          amount: purchase.ratePerKg === null ? null : amount(purchase.weightKg * purchase.ratePerKg),
        }
      : null,
    yarn: {
      givenKg,
      usedKg,
      ratePerKg: n(root.yarnRatePerKg),
      amount: yarnAmount,
      returnedKg: 0,
      atMillKg: round(yarnAtMillKg),
      lossKg: root.knittingFinishedAt && rootKnitted !== null ? round(Math.max(0, n(root.purchasedWeightKg) - rootKnitted)) : null,
      stockKg: round(sum(yarnStock, (p) => p.kg)),
      sharedStock: true,
    },
    summary: {
      productionLossKg: round(Math.max(0, netLoss)),
      productionGainKg: round(Math.max(0, -netLoss)),
      finishedKg: round(sum(nodes, (f) => n(f.officeDeliveryKg))),
      deliveredKg: round(partyKg + dispatchedKg),
      pendingReceiptKg: round(pendingKg),
      receiptDifferenceKg: round(receiptDifferenceKg),
      remainingKg: round(sum([...balances], ([, v]) => Math.max(0, v))),
      totalExpense,
      totalCost: amount(yarnAmount + totalExpense),
    },
    balances: [...balances].filter(([, kg]) => kg > 0.0005).map(([material, kg]) => ({ material, kg: round(kg) })),
    stages,
    costs,
    expenses,
    deliveries,
    sales: sales.filter((s) => fabricCodes.has(s.code)),
    warehouseStock: [...stock, ...yarnStock]
      .filter((p) => Math.abs(p.kg) > 0.0005)
      .map((p) => ({
        code: p.itemCode,
        material: p.category,
        warehouse: warehouses.get(p.warehouseId) ?? p.warehouseId,
        lotNo: p.lotNo,
        kg: round(p.kg),
        sourceYarn: p.category === 'YARN',
      })),
  };
}

/** Paginated live lineage, including completed batches. Reads only; no stock or expense is changed. */
export async function piDetails(prisma: PrismaService, search = '', pageText = '1') {
  if (typeof search !== 'string' || typeof pageText !== 'string') throw new BadRequestException('Choose valid search and page values');
  const page = Number(pageText);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new BadRequestException('Choose a valid page');
  const query = search.trim().slice(0, 100);
  const contains = { contains: query, mode: 'insensitive' as const };
  const where: Prisma.FabricProductionFlowWhereInput = {
    parentId: null,
    ...(query
      ? {
          OR: [
            { flowNo: contains },
            { piNo: contains },
            { yarnItemCode: contains },
            { yarnCount: contains },
            { lots: { some: { flowNo: contains } } },
          ],
        }
      : {}),
  };
  const pageSize = 10;
  const [roots, total] = await Promise.all([
    prisma.fabricProductionFlow.findMany({
      where,
      include,
      orderBy: [{ purchaseDate: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.fabricProductionFlow.count({ where }),
  ]);
  return { success: true, data: { page, pageSize, total, rows: await piRows(prisma, roots) } };
}

/** One production batch (a yarn batch, not a colour lot) with all its lots, for its own page. */
export async function piDetail(prisma: PrismaService, id: string) {
  const root = await prisma.fabricProductionFlow.findFirst({ where: { id, parentId: null }, include });
  if (!root) throw new NotFoundException('Production batch not found. It may have been deleted.');
  return { success: true, data: (await piRows(prisma, [root]))[0] };
}

async function piRows(prisma: PrismaService, roots: PiFlow[]) {
  const all = roots.flatMap((f) => [f, ...f.lots]);
  const codes = [
    ...new Set(all.flatMap((f) => [f.flowNo, ...(f.yarnItemCode ? [f.yarnItemCode] : []), ...f.knittingRuns.map((r) => r.runNo)])),
  ];
  const [movements, warehouseRows, receipts, returns, sales] = codes.length
    ? await Promise.all([
        prisma.stockTransaction.groupBy({
          by: ['itemCode', 'category', 'warehouseId', 'lotNo', 'txnType'],
          where: { itemCode: { in: codes }, unit: { equals: 'KG', mode: 'insensitive' } },
          _sum: { quantityIn: true, quantityOut: true },
        }),
        prisma.warehouse.findMany({ select: { id: true, code: true, name: true } }),
        prisma.yarnReceiptLine.findMany({ where: { itemCode: { in: codes } }, include: { receipt: true } }),
        prisma.stockTransaction.findMany({
          where: { id: { in: roots.flatMap((r) => (r.yarnReturnTxnId ? [r.yarnReturnTxnId] : [])) } },
          select: { id: true, quantityIn: true },
        }),
        prisma.saleItem.findMany({
          where: { itemCode: { in: codes }, unit: { equals: 'KG', mode: 'insensitive' }, sale: { status: 'DISPATCHED' } },
          include: { sale: { include: { warehouse: { select: { code: true, name: true } } } } },
          orderBy: { sale: { dispatchedAt: 'desc' } },
        }),
      ])
    : [[], [], [], [], []];
  const positions = new Map<string, Position>();
  for (const m of movements) {
    const key = JSON.stringify([m.itemCode, m.category, m.warehouseId, m.lotNo]);
    const p = positions.get(key) ?? {
      itemCode: m.itemCode,
      category: m.category,
      warehouseId: m.warehouseId,
      lotNo: m.lotNo,
      kg: 0,
      dispatchedKg: 0,
    };
    p.kg += n(m._sum.quantityIn) - n(m._sum.quantityOut);
    if (m.txnType === 'DISPATCH_OUT') p.dispatchedKg += n(m._sum.quantityOut) - n(m._sum.quantityIn);
    positions.set(key, p);
  }
  const warehouses = new Map(warehouseRows.map((w) => [w.id, `${w.code} · ${w.name}`]));
  return roots.map((root) => {
        const line = receipts.find((r) => r.itemCode === root.yarnItemCode);
        const view = piDetailsView(
          root,
          [...positions.values()],
          warehouses,
          line
            ? {
                receiptNo: line.receipt.receiptNo,
                receivedAt: line.receipt.receivedAt,
                mill: line.receipt.millName,
                dcNo: line.receipt.dcNo,
                weightKg: n(line.weightKg),
                ratePerKg: line.ratePerKg === null ? null : n(line.ratePerKg),
              }
            : null,
          sales.map((s) => ({
            id: s.id,
            code: s.itemCode,
            billNo: s.sale.saleNo,
            date: date(s.sale.dispatchedAt),
            party: s.sale.partyName,
            warehouse: `${s.sale.warehouse.code} · ${s.sale.warehouse.name}`,
            material: s.category,
            kg: n(s.dispatchedQty),
            rate: n(s.rate),
            amount: n(s.amount),
          })),
        );
        view.yarn.returnedKg = round(n(returns.find((r) => r.id === root.yarnReturnTxnId)?.quantityIn));
        return view;
      });
}
