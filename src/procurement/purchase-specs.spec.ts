import { Prisma } from '@prisma/client';
import { checksOf, differences, specsOf } from './procurement.service';

describe('purchase line details', () => {
  it('keeps the filled details, trimmed, once each', () => {
    expect(
      specsOf([
        { label: 'Count', value: " 36'S " },
        { label: 'Quality', value: 'VL' },
        { label: 'Blend', value: '' },
        { label: 'count', value: "40'S" },
        { label: 'Bags', value: '30+9' },
      ]),
    ).toEqual([
      { label: 'Count', value: "36'S" },
      { label: 'Quality', value: 'VL' },
      { label: 'Bags', value: '30+9' },
    ]);
  });

  it('stores nothing when no detail was filled', () => {
    expect(specsOf([{ label: 'Count', value: ' ' }])).toBe(Prisma.DbNull);
    expect(specsOf(undefined)).toBe(Prisma.DbNull);
  });
});

describe('details checked at receipt', () => {
  const checks = [
    { label: 'Count', ordered: "36'S", ok: true },
    { label: 'Shade', ordered: 'Raw white', ok: false, received: 'Off white' },
  ];

  it('keeps what came for each detail', () => {
    expect(checksOf(checks)).toEqual([
      { label: 'Count', ordered: "36'S", ok: true, received: "36'S" },
      { label: 'Shade', ordered: 'Raw white', ok: false, received: 'Off white' },
    ]);
    expect(checksOf([])).toBe(Prisma.DbNull);
  });

  it('names what differed', () => {
    expect(differences(checks)).toBe('Shade: ordered Raw white, came Off white');
    expect(differences([checks[0]])).toBeNull();
  });
});
