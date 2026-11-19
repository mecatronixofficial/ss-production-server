import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { piDetails, piDetailsView, PiFlow } from './pi-details';
import { DashboardController } from './dashboard.controller';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

const root = (fields: Record<string, unknown> = {}): PiFlow =>
  ({
    id: 'root',
    flowNo: '01SS26-KT01',
    piNo: null,
    parentId: null,
    source: 'STOCK',
    status: 'AT_OFFICE',
    yarnItemCode: '01SS26',
    yarnLotNo: null,
    yarnIssueTxnId: 'issue',
    yarnReturnTxnId: null,
    purchaseDate: new Date('2026-11-01'),
    yarnCount: '36',
    fabricType: 'Single',
    fabricDiameter: '30',
    fabricGsm: '180',
    purchasedWeightKg: 1200,
    yarnReceivedKg: 1200,
    yarnRatePerKg: 10,
    purchaseOtherCost: 0,
    knittingDate: new Date('2026-11-01'),
    knittingFinishedAt: new Date('2026-11-03'),
    knittingMillType: 'OWN',
    knittingMillDetails: 'SS Mills',
    knittingPartyDetails: null,
    knittingDeliveryKg: 1180,
    dyeingDeliveryKg: 1180,
    knittingExpense: 1200,
    knittingDestination: 'NEXT_PROCESS',
    dyeingDate: new Date('2026-11-03'),
    dyeingFinishedAt: new Date('2026-11-05'),
    dyeingOutputWeightKg: 1150,
    dyeingExpense: 2300,
    dyeingBalanceKg: null,
    dyeingDestination: 'NEXT_PROCESS',
    dyeingMillDetails: 'Dye mill',
    dyeingPartyDetails: null,
    compactingDate: new Date('2026-11-05'),
    compactingFinishedAt: new Date('2026-11-06'),
    compactingDeliveryKg: 1150,
    compactingReceivedKg: 1150,
    compactingBalanceKg: null,
    officeDeliveryKg: 1100,
    compactingExpense: 1100,
    compactingMillDetails: 'Compact mill',
    compactingPartyDetails: null,
    finalDeliveredKg: null,
    color: null,
    otherExpense: 0,
    expenses: [],
    deliveries: [],
    lots: [],
    knittingRuns: [],
    ...fields,
  }) as unknown as PiFlow;
const delivery = (fields: Record<string, unknown> = {}) => ({
  id: 'delivery',
  processStage: 'FINAL',
  destination: 'CUSTOMER',
  deliveredAt: new Date('2026-11-06'),
  weightKg: 500,
  amount: 7500,
  expense: 50,
  receivedAt: null,
  receivedWeightKg: null,
  warehouse: null,
  partyName: 'Buyer',
  ...fields,
});
const view = (f: PiFlow) => piDetailsView(f, [], new Map(), null);

describe('Dashboard PI details', () => {
  it('reconciles 1200 kg yarn to 1100 kg fabric, 100 kg loss, 500 delivered and 600 remaining', () => {
    const f = root({
      deliveries: [delivery()],
      finalDeliveredKg: 500,
      otherExpense: 50,
      expenses: [{ id: 'expense', expenseDate: new Date('2026-11-02'), category: 'Labour', description: 'Handling', amount: 100 }],
    });
    const report = view(f);
    expect(report.summary).toMatchObject({
      productionLossKg: 100,
      finishedKg: 1100,
      deliveredKg: 500,
      remainingKg: 600,
      totalCost: 16750,
      totalExpense: 4750,
    });
    expect(report.stages.map((s) => s.lossKg)).toEqual([20, 30, 50]);
    expect(report.stages[2].balanceKg).toBe(600);
    expect(report.balances).toEqual([{ material: 'FINISHED_FABRIC', kg: 600 }]);
  });

  it('does not treat unused yarn or material returned to stock as loss', () => {
    const report = view(
      root({
        purchasedWeightKg: 1150,
        dyeingBalanceKg: 20,
        compactingBalanceKg: 10,
        knittingDeliveryKg: 1130,
        dyeingDeliveryKg: 1130,
        dyeingOutputWeightKg: 1100,
        compactingDeliveryKg: 1100,
        officeDeliveryKg: 1080,
      }),
    );
    expect(report.summary.productionLossKg).toBe(40); // 20 knitting + 10 dyeing + 10 compacting
    expect(report.summary.remainingKg).toBe(1110);
    expect(report.balances).toEqual(
      expect.arrayContaining([
        { material: 'FINISHED_FABRIC', kg: 1080 },
        { material: 'GREY_FABRIC', kg: 20 },
        { material: 'DYED_FABRIC', kg: 10 },
      ]),
    );
  });

  it('shows in-progress output without counting the unprocessed yarn as loss', () => {
    const report = view(
      root({
        knittingFinishedAt: null,
        knittingDeliveryKg: null,
        dyeingDeliveryKg: null,
        dyeingDate: null,
        dyeingFinishedAt: null,
        dyeingOutputWeightKg: null,
        compactingDate: null,
        compactingFinishedAt: null,
        compactingDeliveryKg: null,
        officeDeliveryKg: null,
        knittingRuns: [{ runNo: 'RUN1', outputKg: 100, machine: { code: 'KN01' }, days: [] }],
      }),
    );
    expect(report.summary.productionLossKg).toBe(0);
    expect(report.stages[0]).toMatchObject({ state: 'In progress', outputKg: 100, lossKg: null });
    expect(report.yarn.usedKg).toBeNull();
    expect(report.yarn.atMillKg).toBe(1100);
    expect(report.summary.remainingKg).toBe(1200);
  });

  it('keeps finished warehouse fabric as stock and deducts warehouse sales', () => {
    const f = root({
      finalDeliveredKg: 1100,
      deliveries: [
        delivery({
          destination: 'WAREHOUSE',
          weightKg: 1100,
          receivedWeightKg: 1100,
          receivedAt: new Date('2026-11-07'),
          warehouse: { code: 'WH01', name: 'Store' },
        }),
      ],
    });
    const report = piDetailsView(
      f,
      [{ itemCode: f.flowNo, category: 'FINISHED_FABRIC', warehouseId: 'wh', lotNo: null, kg: 600, dispatchedKg: 500 }],
      new Map([['wh', 'WH01 · Store']]),
      null,
    );
    expect(report.summary).toMatchObject({ deliveredKg: 500, remainingKg: 600, productionLossKg: 100 });
    expect(report.warehouseStock[0].kg).toBe(600);
  });

  it('shows warehouse receipts pending and shortages separately from process loss', () => {
    const pending = view(
      root({ finalDeliveredKg: 500, deliveries: [delivery({ destination: 'WAREHOUSE', warehouse: { code: 'WH01', name: 'Store' } })] }),
    );
    expect(pending.summary).toMatchObject({ deliveredKg: 0, pendingReceiptKg: 500, remainingKg: 1100 });
    const received = view(
      root({
        finalDeliveredKg: 500,
        deliveries: [
          delivery({
            destination: 'WAREHOUSE',
            receivedAt: new Date('2026-11-07'),
            receivedWeightKg: 490,
            warehouse: { code: 'WH01', name: 'Store' },
          }),
        ],
      }),
    );
    expect(received.summary).toMatchObject({ receiptDifferenceKg: 10, productionLossKg: 100, remainingKg: 1090 });
  });

  it('includes early-stage warehouse balances and does not require compacting', () => {
    const report = view(
      root({
        dyeingDate: null,
        dyeingFinishedAt: null,
        dyeingOutputWeightKg: null,
        compactingDate: null,
        compactingFinishedAt: null,
        compactingDeliveryKg: null,
        officeDeliveryKg: null,
        dyeingDeliveryKg: null,
        knittingDestination: 'WAREHOUSE',
        deliveries: [
          delivery({
            processStage: 'KNITTING',
            destination: 'WAREHOUSE',
            weightKg: 1180,
            receivedWeightKg: 1180,
            receivedAt: new Date('2026-11-04'),
            warehouse: { code: 'WH01', name: 'Store' },
          }),
        ],
      }),
    );
    expect(report.balances).toEqual([{ material: 'GREY_FABRIC', kg: 1180 }]);
    expect(report.summary.productionLossKg).toBe(20);
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0].balanceKg).toBe(0);
  });

  it('combines colour lots and charges the original yarn and knitting only once', () => {
    const lot = root({
      id: 'lot',
      parentId: 'root',
      flowNo: '01SS26-KT01-DY01',
      color: 'Navy',
      purchasedWeightKg: 600,
      yarnReceivedKg: null,
      yarnRatePerKg: 12,
      knittingExpense: 0,
      knittingDeliveryKg: 600,
      dyeingDeliveryKg: 600,
      dyeingOutputWeightKg: 580,
      dyeingExpense: 1160,
      compactingDeliveryKg: 580,
      officeDeliveryKg: 550,
      compactingExpense: 550,
      finalDeliveredKg: 200,
      deliveries: [delivery({ weightKg: 200 })],
    });
    const report = view(
      root({
        lots: [lot],
        dyeingDate: null,
        dyeingFinishedAt: null,
        dyeingOutputWeightKg: null,
        compactingDate: null,
        compactingFinishedAt: null,
        compactingDeliveryKg: null,
        officeDeliveryKg: null,
        dyeingExpense: 0,
        compactingExpense: 0,
      }),
    );
    expect(report.summary).toMatchObject({ productionLossKg: 70, remainingKg: 930, totalCost: 14910 }); // 580 grey + 350 finished
    expect(report.stages.filter((s) => s.stage === 'Knitting')).toHaveLength(1);
    expect(report.stages.map((s) => s.batchCode)).toEqual(['01SS26-KT01', '01SS26-KT01-DY01', '01SS26-KT01-DY01']);
  });

  it('handles process weight gains without inventing extra loss', () => {
    const report = view(root({ dyeingOutputWeightKg: 1200, compactingDeliveryKg: 1200, officeDeliveryKg: 1190 }));
    expect(report.summary.productionLossKg).toBe(10); // 20 - 20 + 10
    expect(report.stages[1].gainKg).toBe(20);
  });

  it('searches root, yarn, legacy PI and colour-lot codes and includes completed roots', async () => {
    const prisma = { fabricProductionFlow: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } };
    const result = await piDetails(prisma as unknown as PrismaService, '01SS26-DY01', '2');
    const args = prisma.fabricProductionFlow.findMany.mock.calls[0][0];
    expect(args.where.parentId).toBeNull();
    expect(args.where.status).toBeUndefined();
    expect(args.where.OR).toEqual(
      expect.arrayContaining([{ lots: { some: { flowNo: { contains: '01SS26-DY01', mode: 'insensitive' } } } }]),
    );
    expect(args).toMatchObject({ skip: 10, take: 10 });
    expect(result.data).toMatchObject({ page: 2, pageSize: 10, total: 0, rows: [] });
  });

  it('rejects invalid page input', async () => {
    for (const page of ['0', '-1', '2.3', 'Infinity', 'bad', '100001'])
      await expect(piDetails({} as PrismaService, '', page)).rejects.toThrow(BadRequestException);
  });

  it('hydrates purchase rates, returned yarn, live stock and dispatched sale details from existing records', async () => {
    const f = root({ yarnReturnTxnId: 'returned', purchasedWeightKg: 1150 });
    const prisma = {
      fabricProductionFlow: { findMany: jest.fn().mockResolvedValue([f]), count: jest.fn().mockResolvedValue(1) },
      stockTransaction: {
        groupBy: jest.fn().mockResolvedValue([
          {
            itemCode: f.flowNo,
            category: 'FINISHED_FABRIC',
            warehouseId: 'wh',
            lotNo: null,
            txnType: 'PRODUCTION_IN',
            _sum: { quantityIn: 1100, quantityOut: 0 },
          },
          {
            itemCode: f.flowNo,
            category: 'FINISHED_FABRIC',
            warehouseId: 'wh',
            lotNo: null,
            txnType: 'DISPATCH_OUT',
            _sum: { quantityIn: 0, quantityOut: 500 },
          },
          {
            itemCode: f.yarnItemCode,
            category: 'YARN',
            warehouseId: 'wh',
            lotNo: null,
            txnType: 'KNITTING_RETURN',
            _sum: { quantityIn: 50, quantityOut: 0 },
          },
        ]),
        findMany: jest.fn().mockResolvedValue([{ id: 'returned', quantityIn: 50 }]),
      },
      warehouse: { findMany: jest.fn().mockResolvedValue([{ id: 'wh', code: 'WH01', name: 'Store' }]) },
      yarnReceiptLine: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              itemCode: f.yarnItemCode,
              weightKg: 1200,
              ratePerKg: 10,
              receipt: { receiptNo: 'YR-1', receivedAt: new Date('2026-11-01'), millName: 'Yarn Mill', dcNo: 'DC-1' },
            },
          ]),
      },
      saleItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: 'sale-line',
              itemCode: f.flowNo,
              category: 'FINISHED_FABRIC',
              dispatchedQty: 500,
              rate: 15,
              amount: 7500,
              sale: {
                saleNo: 'SAL-1',
                dispatchedAt: new Date('2026-11-07'),
                partyName: 'Buyer',
                warehouse: { code: 'WH01', name: 'Store' },
              },
            },
          ]),
      },
    };
    const result = await piDetails(prisma as unknown as PrismaService);
    const report = result.data.rows[0];
    expect(report.purchase).toMatchObject({ weightKg: 1200, ratePerKg: 10, amount: 12000, receiptNo: 'YR-1' });
    expect(report.yarn).toMatchObject({ returnedKg: 50, stockKg: 50, ratePerKg: 10 });
    expect(report.summary).toMatchObject({ remainingKg: 600, deliveredKg: 500 });
    expect(report.warehouseStock.find((p) => p.material === 'FINISHED_FABRIC')?.kg).toBe(600);
    expect(report.sales).toEqual([expect.objectContaining({ billNo: 'SAL-1', kg: 500, amount: 7500 })]);
    expect(prisma.saleItem.findMany.mock.calls[0][0].where.sale.status).toBe('DISPATCHED');
  });

  it('limits the financial PI report to administrators', () => {
    expect(Reflect.getMetadata(ROLES_KEY, Object.getOwnPropertyDescriptor(DashboardController.prototype, 'piDetails')!.value)).toEqual([
      'SUPERADMIN',
      'ADMIN',
    ]);
  });
});
