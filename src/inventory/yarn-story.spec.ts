import { Prisma } from '@prisma/client';
import { buildYarnStory, weightCheck } from './yarn-story';

const d = (v: number | null) => (v === null ? null : new Prisma.Decimal(v));
const flow = (fields: Record<string, unknown>) =>
  ({
    parentId: null,
    status: 'KNITTING',
    fabricType: 'Single jersey',
    fabricDiameter: '30',
    fabricGsm: '180',
    color: null,
    yarnCount: '30s cotton',
    knittingMillType: 'OTHER',
    knittingMillDetails: 'Sri mill',
    knittingPartyDetails: null,
    knittingDate: new Date('2026-10-01'),
    purchaseDate: new Date('2026-10-01'),
    knittingFinishedAt: null,
    yarnReceivedKg: null,
    purchasedWeightKg: d(0),
    knittingDeliveryKg: null,
    dyeingDeliveryKg: null,
    dyeingDate: null,
    dyeingMillDetails: null,
    fabricReceivedKg: null,
    dyeingOutputWeightKg: null,
    compactingDate: null,
    compactingMillDetails: null,
    officeDeliveryKg: null,
    finalDeliveredKg: null,
    ...fields,
  }) as never;

describe('weight check', () => {
  it('says lost, equal or gained', () => {
    expect(weightCheck(100, 96)).toMatchObject({ diffKg: -4, pct: -4, result: 'LOSS' });
    expect(weightCheck(100, 100)).toMatchObject({ diffKg: 0, result: 'EQUAL' });
    expect(weightCheck(100, 101.5)).toMatchObject({ diffKg: 1.5, result: 'GAIN' });
  });
});

describe('yarn story', () => {
  const movements = [
    { txnType: 'PURCHASE_IN', inKg: 500, outKg: 0 },
    { txnType: 'KNITTING_ISSUE', inKg: 0, outKg: 300 },
    { txnType: 'KNITTING_RETURN', inKg: 4, outKg: 0 },
  ];
  // KT01: 200 KG yarn given, 196 used, 190 grey, dyed in two colours (red finished, navy still dyeing).
  // KT02: 100 KG given, still knitting.
  const flows = [
    flow({ id: 'kt1', flowNo: '01SS26-KT01', status: 'DELIVERED', yarnReceivedKg: d(200), purchasedWeightKg: d(196), knittingFinishedAt: new Date('2026-10-05'), knittingDeliveryKg: d(190), dyeingDeliveryKg: d(190) }),
    flow({ id: 'kt2', flowNo: '01SS26-KT02', yarnReceivedKg: d(100), purchasedWeightKg: d(100) }),
    flow({
      id: 'dy1',
      flowNo: '01SS26-KT01-DY01',
      parentId: 'kt1',
      color: 'Red',
      purchasedWeightKg: d(95),
      dyeingDate: new Date('2026-10-06'),
      dyeingOutputWeightKg: d(92),
      compactingDate: new Date('2026-10-09'),
      officeDeliveryKg: d(90),
      finalDeliveredKg: d(40),
      deliveries: [{ destination: 'CUSTOMER', partyName: 'Kumar Textiles', weightKg: d(40), deliveredAt: new Date('2026-10-11'), warehouse: null }],
    }),
    flow({ id: 'dy2', flowNo: '01SS26-KT01-DY02', parentId: 'kt1', color: 'Navy', purchasedWeightKg: d(95), dyeingDate: new Date('2026-10-06') }),
  ];
  const story = buildYarnStory('01SS26', '30s cotton', movements, flows, '01SS26-KT01-DY01');

  it('follows each colour to where it was delivered', () => {
    expect(story.batches[0].colours[0].deliveries).toEqual([{ to: 'Kumar Textiles', toParty: true, kg: 40, date: new Date('2026-10-11') }]);
    expect(story.batches[0]).toMatchObject({ soldAtKnitting: false, deliveries: [] });
  });

  it('adds up the yarn in and out of stock', () => {
    expect(story.yarn).toEqual({ code: '01SS26', name: '30s cotton', receivedKg: 500, toKnittingKg: 300, returnedKg: 4, otherOutKg: 0, inStockKg: 204 });
  });

  it('shows each knitting batch with its colours and the weight checked at each step', () => {
    const [kt1, kt2] = story.batches;
    expect(kt1).toMatchObject({ flowNo: '01SS26-KT01', yarnGivenKg: 200, yarnUsedKg: 196, yarnReturnedKg: 4, greyKg: 190, greyLeftKg: 0, knittingCheck: { diffKg: -6, result: 'LOSS' } });
    expect(kt1.colours.map((c) => [c.flowNo, c.color, c.stage, c.greyKg, c.finishedKg])).toEqual([
      ['01SS26-KT01-DY01', 'Red', 'TO_DELIVER', 95, 90],
      ['01SS26-KT01-DY02', 'Navy', 'DYEING', 95, null],
    ]);
    expect(kt1.colours[0]).toMatchObject({ dyeing: { diffKg: -3 }, compacting: { diffKg: -2 }, overall: { diffKg: -5, result: 'LOSS' } });
    expect(kt2).toMatchObject({ knitting: true, greyKg: null, knittingCheck: null, colours: [] });
  });

  it('checks the finished fabric against the yarn it used, counting only what has been through each step', () => {
    expect(story.totals).toMatchObject({ knittingBatches: 2, colours: 2, colors: ['Red', 'Navy'], yarnUsedKg: 296, greyKg: 190, dyedKg: 92, finishedKg: 90, deliveredKg: 40 });
    expect(story.totals.knitting).toMatchObject({ inKg: 196, outKg: 190, result: 'LOSS' });
    expect(story.totals.dyeing).toMatchObject({ inKg: 95, outKg: 92 });
    // Red took 95 of KT01's 190 KG grey: half of its 196 KG yarn.
    expect(story.totals.final).toMatchObject({ inKg: 98, outKg: 90, diffKg: -8, result: 'LOSS' });
  });

  it('sums the yarn by the fabric made from it', () => {
    expect(story.byFabric).toEqual([{ fabric: 'Single jersey · 30 dia · 180 GSM', batches: 2, yarnUsedKg: 296, greyKg: 190, finishedKg: 90, colors: ['Red', 'Navy'] }]);
  });

  it('treats an older batch dyed on itself as its own colour', () => {
    const old = buildYarnStory('SS-2026-001', null, [], [flow({ id: 'o', flowNo: 'SS-2026-001-D1', purchasedWeightKg: d(100), knittingFinishedAt: new Date(), knittingDeliveryKg: d(95), dyeingDeliveryKg: d(95), dyeingDate: new Date(), fabricReceivedKg: d(95), color: 'Black', dyeingOutputWeightKg: d(95) })], 'SS-2026-001');
    expect(old.batches[0].colours).toMatchObject([{ flowNo: 'SS-2026-001-D1', ownBatch: true, color: 'Black', dyeing: { result: 'EQUAL' } }]);
  });
});
