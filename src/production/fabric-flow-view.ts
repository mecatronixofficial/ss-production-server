import { FabricProductionFlow } from '@prisma/client';

/** What a knitting batch knows of its dyeing lots. */
type LotRef = { purchasedWeightKg: unknown };

/**
 * Weights and manufacturing spend for an own-material fabric batch.
 * Shared by the production ledger and the reports so both show the same figures.
 *
 * A knitting batch whose grey fabric went into dyeing lots keeps only what is left of it: the weight not yet in a
 * lot and that share of its cost (the rest went into the lots as their grey fabric cost), so totals across batches
 * count every KG and rupee once.
 */
export function fabricFlowView(flow: FabricProductionFlow & { expenses?: Array<{ amount: unknown }>; lots?: LotRef[] }) {
  const number = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  const purchasedWeightKg = Number(flow.purchasedWeightKg);
  const yarnReceivedKg = number(flow.yarnReceivedKg);
  const knittingDeliveryKg = number(flow.knittingDeliveryKg);
  const dyeingDeliveryKg = number(flow.dyeingDeliveryKg);
  const fabricReceivedKg = number(flow.fabricReceivedKg);
  const dyeingOutputWeightKg = number(flow.dyeingOutputWeightKg);
  const compactingDeliveryKg = number(flow.compactingDeliveryKg);
  const compactingReceivedKg = number(flow.compactingReceivedKg);
  const officeDeliveryKg = number(flow.officeDeliveryKg);
  const finalDeliveredKg = number(flow.finalDeliveredKg);
  const lots = flow.lots ?? [];
  const knittedKg = knittingDeliveryKg ?? dyeingDeliveryKg;
  const allocatedKg = lots.reduce((total, lot) => total + Number(lot.purchasedWeightKg), 0);
  const remainingKg = lots.length ? Math.max(0, (knittedKg ?? 0) - allocatedKg) : null;
  const currentWeightKg =
    remainingKg ??
    officeDeliveryKg ?? compactingReceivedKg ?? compactingDeliveryKg ?? dyeingOutputWeightKg ??
    fabricReceivedKg ?? dyeingDeliveryKg ?? knittingDeliveryKg ?? finalDeliveredKg ?? yarnReceivedKg ?? purchasedWeightKg;
  // Yarn taken from stock: what knitting was given is not what it used; the yarn it didn't use went back to the
  // warehouse and is not lost. Its knitting loss is the yarn used against the fabric made, and only once knitting is
  // finished (while it knits, the fabric so far is not a loss). Older purchase batches: yarn bought, then received.
  const fromStock = flow.source === 'STOCK' || flow.yarnIssueTxnId !== null;
  const knitting = !flow.parentId && flow.status === 'KNITTING' && flow.knittingFinishedAt === null && dyeingDeliveryKg === null;
  const yarnLossKg = fromStock || yarnReceivedKg === null ? 0 : Math.max(0, purchasedWeightKg - yarnReceivedKg);
  const knittingOutput = knittingDeliveryKg ?? dyeingDeliveryKg;
  const knittingInput = fromStock ? purchasedWeightKg : yarnReceivedKg;
  const knittingLossKg = knitting || knittingInput === null || knittingOutput === null ? 0 : Math.max(0, knittingInput - knittingOutput);
  /** Yarn given to knitting that it didn't use: back in the warehouse. */
  const yarnReturnedKg = fromStock && !knitting && yarnReceivedKg !== null ? Math.max(0, yarnReceivedKg - purchasedWeightKg) : 0;
  const dyeingOutput = compactingDeliveryKg ?? dyeingOutputWeightKg;
  const dyeingLossKg =
    dyeingDeliveryKg === null || dyeingOutput === null ? 0 : Math.max(0, dyeingDeliveryKg - dyeingOutput);
  const compactingLossKg =
    compactingDeliveryKg === null || officeDeliveryKg === null ? 0 : Math.max(0, compactingDeliveryKg - officeDeliveryKg);
  const balanceFabricKg = officeDeliveryKg === null ? currentWeightKg : Math.max(0, officeDeliveryKg - (finalDeliveredKg ?? 0));
  const yarnAmount = purchasedWeightKg * Number(flow.yarnRatePerKg);
  const additionalExpenses = (flow.expenses ?? []).reduce((total, expense) => total + Number(expense.amount), 0);
  const fullSpent =
    yarnAmount +
    Number(flow.purchaseOtherCost) +
    Number(flow.knittingExpense) +
    Number(flow.dyeingExpense) +
    Number(flow.compactingExpense) +
    Number(flow.otherExpense) +
    additionalExpenses;
  // What a KG of this batch's grey fabric cost, which its dyeing lots take on.
  const costPerKg = knittedKg ? fullSpent / knittedKg : 0;
  const totalSpent = remainingKg === null ? fullSpent : knittedKg ? fullSpent * (remainingKg / knittedKg) : 0;
  // A knitting batch's own loss is the yarn's and knitting's; what went into lots is not lost.
  const lostKg = knitting ? 0 : remainingKg === null ? purchasedWeightKg - currentWeightKg : purchasedWeightKg - (knittedKg ?? purchasedWeightKg);
  const collectedAmount = Number(flow.collectedAmount);
  return {
    ...flow,
    purchasedWeightKg,
    yarnRatePerKg: Number(flow.yarnRatePerKg),
    purchaseOtherCost: Number(flow.purchaseOtherCost),
    yarnReceivedKg,
    plannedFabricKg: number(flow.plannedFabricKg),
    dyeingBalanceKg: number(flow.dyeingBalanceKg),
    compactingBalanceKg: number(flow.compactingBalanceKg),
    dailyProductivityKg: number(flow.dailyProductivityKg),
    knittingDeliveryKg,
    knittingExpense: Number(flow.knittingExpense),
    dyeingDeliveryKg,
    fabricReceivedKg,
    dyeingOutputWeightKg,
    dyeingExpense: Number(flow.dyeingExpense),
    compactingDeliveryKg,
    compactingReceivedKg,
    officeDeliveryKg,
    compactingExpense: Number(flow.compactingExpense),
    finalDeliveredKg,
    collectedAmount,
    otherExpense: Number(flow.otherExpense),
    metrics: {
      currentWeightKg,
      yarnAmount,
      yarnLossKg,
      knittingLossKg,
      yarnReturnedKg,
      dyeingLossKg,
      compactingLossKg,
      balanceFabricKg,
      totalLossKg: Math.max(0, lostKg),
      lossPct: purchasedWeightKg ? Math.max(0, (lostKg / purchasedWeightKg) * 100) : 0,
      totalSpent,
      costPerKg,
      lots: lots.length ? { count: lots.length, allocatedKg, remainingKg: remainingKg ?? 0, allocatedCost: fullSpent - totalSpent } : null,
      additionalExpenses,
      profit: collectedAmount - totalSpent,
    },
  };
}
