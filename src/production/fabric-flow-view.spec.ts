import { FabricProductionFlow } from '@prisma/client';
import { fabricFlowView } from './fabric-flow-view';

const flow = (fields: Record<string, unknown>) =>
  ({
    purchasedWeightKg: 100,
    yarnReceivedKg: 100,
    yarnRatePerKg: 10,
    purchaseOtherCost: 0,
    knittingExpense: 0,
    dyeingExpense: 0,
    compactingExpense: 0,
    otherExpense: 0,
    collectedAmount: 0,
    ...fields,
  }) as unknown as FabricProductionFlow;

describe('Production weight metrics', () => {
  it('keeps the full output and remaining balance when part of the fabric is delivered', () => {
    const result = fabricFlowView(flow({ officeDeliveryKg: 90, finalDeliveredKg: 20 }));
    expect(result.metrics).toMatchObject({ currentWeightKg: 90, balanceFabricKg: 70, totalLossKg: 10 });
  });

  it('counts knitting output sent to a warehouse even before dyeing starts', () => {
    const result = fabricFlowView(flow({ knittingDeliveryKg: 95, dyeingDeliveryKg: null }));
    expect(result.metrics).toMatchObject({ currentWeightKg: 95, knittingLossKg: 5, totalLossKg: 5 });
  });

  it('counts dyed output sent to a warehouse even before compacting starts', () => {
    const result = fabricFlowView(
      flow({ knittingDeliveryKg: 95, dyeingDeliveryKg: 95, dyeingOutputWeightKg: 92, compactingDeliveryKg: null }),
    );
    expect(result.metrics).toMatchObject({ currentWeightKg: 92, knittingLossKg: 5, dyeingLossKg: 3, totalLossKg: 8 });
  });

  it('retains delivered weight for legacy records with no recorded process output', () => {
    expect(fabricFlowView(flow({ finalDeliveredKg: 90 })).metrics.currentWeightKg).toBe(90);
  });
});
