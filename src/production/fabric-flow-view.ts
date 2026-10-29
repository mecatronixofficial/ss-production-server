import { FabricProductionFlow } from '@prisma/client';

/**
 * Weights and manufacturing spend for an own-material fabric batch.
 * Shared by the production ledger and the reports so both show the same figures.
 */
export function fabricFlowView(flow: FabricProductionFlow & { expenses?: Array<{ amount: unknown }> }) {
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
  const currentWeightKg =
    officeDeliveryKg ?? compactingReceivedKg ?? compactingDeliveryKg ?? dyeingOutputWeightKg ??
    fabricReceivedKg ?? dyeingDeliveryKg ?? knittingDeliveryKg ?? finalDeliveredKg ?? yarnReceivedKg ?? purchasedWeightKg;
  const yarnLossKg = yarnReceivedKg === null ? 0 : Math.max(0, purchasedWeightKg - yarnReceivedKg);
  const knittingOutput = knittingDeliveryKg ?? dyeingDeliveryKg;
  const knittingLossKg = yarnReceivedKg === null || knittingOutput === null ? 0 : Math.max(0, yarnReceivedKg - knittingOutput);
  const dyeingOutput = compactingDeliveryKg ?? dyeingOutputWeightKg;
  const dyeingLossKg =
    dyeingDeliveryKg === null || dyeingOutput === null ? 0 : Math.max(0, dyeingDeliveryKg - dyeingOutput);
  const compactingLossKg =
    compactingDeliveryKg === null || officeDeliveryKg === null ? 0 : Math.max(0, compactingDeliveryKg - officeDeliveryKg);
  const balanceFabricKg = officeDeliveryKg === null ? currentWeightKg : Math.max(0, officeDeliveryKg - (finalDeliveredKg ?? 0));
  const yarnAmount = purchasedWeightKg * Number(flow.yarnRatePerKg);
  const additionalExpenses = (flow.expenses ?? []).reduce((total, expense) => total + Number(expense.amount), 0);
  const totalSpent =
    yarnAmount +
    Number(flow.purchaseOtherCost) +
    Number(flow.knittingExpense) +
    Number(flow.dyeingExpense) +
    Number(flow.compactingExpense) +
    Number(flow.otherExpense) +
    additionalExpenses;
  const collectedAmount = Number(flow.collectedAmount);
  return {
    ...flow,
    purchasedWeightKg,
    yarnRatePerKg: Number(flow.yarnRatePerKg),
    purchaseOtherCost: Number(flow.purchaseOtherCost),
    yarnReceivedKg,
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
      dyeingLossKg,
      compactingLossKg,
      balanceFabricKg,
      totalLossKg: Math.max(0, purchasedWeightKg - currentWeightKg),
      lossPct: purchasedWeightKg ? Math.max(0, ((purchasedWeightKg - currentWeightKg) / purchasedWeightKg) * 100) : 0,
      totalSpent,
      additionalExpenses,
      profit: collectedAmount - totalSpent,
    },
  };
}
