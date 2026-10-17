import { PrismaClient } from '@prisma/client';
import { itemSpecs, specsText } from './item-specs';

const flow = {
  flowNo: 'SS-2026-003-D1',
  fabricType: 'Single jersey',
  fabricDiameter: '22 DIA',
  fabricGsm: '180',
  knittingGg: '28G',
  knittingLl: '2.8mm',
  gg: null,
  ll: null,
  color: 'Navy',
  yarnCount: '30s combed cotton',
  dyeingCount: null,
  yarnItemCode: 'SS-2026-003',
  rollCount: 24,
  knittingBagCount: 12,
};

/** Just the three lookups itemSpecs makes. */
const fakeDb = {
  fabricProductionFlow: { findMany: () => Promise.resolve([flow]) },
  knittingRun: {
    findMany: () =>
      Promise.resolve([
        {
          runNo: 'SS-2026-014',
          fabricType: 'Rib',
          rollCount: 8,
          yarnKg: 240,
          outputKg: 238.5,
          finishedAt: new Date(),
          machine: { code: 'M-03', name: 'Circular 3' },
          yarns: [{ itemCode: 'SS-2026-010', itemName: '40s cotton', kg: 240 }],
          productionFlow: { ...flow, flowNo: 'SS-2026-010-D1', fabricType: null },
        },
      ]),
  },
  purchaseOrderItem: {
    findMany: () =>
      Promise.resolve([
        {
          itemCode: 'SS-2026-020',
          itemName: '30s combed',
          category: 'YARN',
          purchaseOrder: { poNo: 'PUR-2026-000012', orderDate: new Date(), supplier: { name: 'Kumar Yarns' } },
        },
        // An older order of the same code: the newest one is used.
        {
          itemCode: 'SS-2026-020',
          itemName: '30s combed',
          category: 'YARN',
          purchaseOrder: { poNo: 'PUR-2026-000001', orderDate: new Date(0), supplier: { name: 'Old Mills' } },
        },
      ]),
  },
} as unknown as PrismaClient;

describe('itemSpecs', () => {
  it('gives a batch its full fabric construction', async () => {
    const specs = await itemSpecs(fakeDb, ['SS-2026-003-D1']);
    expect(specsText(specs.get('SS-2026-003-D1'))).toBe(
      'Fabric Single jersey  ·  Dia 22 DIA  ·  GSM 180  ·  GG 28G  ·  LL 2.8mm  ·  Colour Navy  ·  Count 30s combed cotton  ·  Yarn SS-2026-003  ·  Rolls 24  ·  Bags 12  ·  Batch SS-2026-003-D1',
    );
  });

  it('gives knitted grey fabric its run, machine and yarns, and its batch construction', async () => {
    const specs = (await itemSpecs(fakeDb, ['SS-2026-014'])).get('SS-2026-014')!;
    const byLabel = Object.fromEntries(specs.map((s) => [s.label, s.value]));
    expect(byLabel).toMatchObject({
      Fabric: 'Rib',
      'Knitting run': 'SS-2026-014',
      Machine: 'M-03 · Circular 3',
      Rolls: '8',
      GSM: '180',
      Colour: 'Navy',
      Batch: 'SS-2026-010-D1',
    });
    expect(byLabel.Yarns).toBe('SS-2026-010 40s cotton');
  });

  it('gives purchased material its distributor and latest PO, without prices', async () => {
    const specs = (await itemSpecs(fakeDb, ['SS-2026-020'])).get('SS-2026-020')!;
    expect(specs).toEqual([
      { label: 'Material', value: 'yarn' },
      { label: 'Distributor', value: 'Kumar Yarns' },
      { label: 'PO', value: 'PUR-2026-000012' },
    ]);
  });

  it('asks for nothing when there are no codes', async () => {
    expect((await itemSpecs(fakeDb, [null, undefined])).size).toBe(0);
  });
});
