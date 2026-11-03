import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { yarnAtKnitting } from './yarn-usage';

describe('Yarn out at knitting', () => {
  it('shows each batch knitting a warehouse yarn: its machines, yarn given, used so far from the day entries, and left', async () => {
    const prisma = {
      fabricProductionFlow: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'kt',
            flowNo: '01SS26-KT01',
            yarnItemCode: '01SS26',
            yarnCount: "36'S VL",
            yarnLotNo: null,
            yarnReceivedKg: new Prisma.Decimal(200),
            purchasedWeightKg: new Prisma.Decimal(200),
            fabricType: 'Single jersey',
            fabricDiameter: '30',
            fabricGsm: null,
            knittingMillType: 'OWN',
            knittingMillDetails: 'KN-01, KN-02',
            knittingDate: new Date('2026-11-01'),
            yarnWarehouse: { id: 'yrn', code: 'YRN' },
            knittingRuns: [
              { runNo: '01SS26-KT01-R1', status: 'RUNNING', yarnKg: new Prisma.Decimal(52), outputKg: new Prisma.Decimal(50), machine: { code: 'KN-01' } },
              { runNo: '01SS26-KT01-R2', status: 'RUNNING', yarnKg: new Prisma.Decimal(31), outputKg: new Prisma.Decimal(30), machine: { code: 'KN-02' } },
            ],
          },
        ]),
      },
    };
    const [row] = await yarnAtKnitting(prisma as unknown as PrismaService, 'yrn');
    expect(row).toMatchObject({ flowNo: '01SS26-KT01', yarnItemCode: '01SS26', own: true, mill: 'Own mill', givenKg: 200, usedKg: 83, knittedKg: 80, leftKg: 117, fabric: 'Single jersey · 30 dia' });
    expect(row.machines).toEqual([
      { code: 'KN-01', runNo: '01SS26-KT01-R1', running: true },
      { code: 'KN-02', runNo: '01SS26-KT01-R2', running: true },
    ]);
    expect(prisma.fabricProductionFlow.findMany.mock.calls[0][0].where).toMatchObject({ yarnWarehouseId: 'yrn', knittingFinishedAt: null, parentId: null });
  });
});
