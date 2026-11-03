import { dyeingLotCode, formatDocumentNo, formatYarnCode, knittingCode } from './numbering';

describe('document numbering', () => {
  it('pads the yearly sequence to six digits', () => expect(formatDocumentNo('SO', 2026, 42)).toBe('SO-2026-000042'));
  it('keeps growing past six digits', () => expect(formatDocumentNo('INV', 2026, 1234567)).toBe('INV-2026-1234567'));
});

describe('production codes', () => {
  it('gives yarn its number, SS and the year', () => {
    expect(formatYarnCode(1, 2026)).toBe('01SS26');
    expect(formatYarnCode(42, 2027)).toBe('42SS27');
    expect(formatYarnCode(100, 2026)).toBe('100SS26');
  });
  it('codes knitting batches on the yarn and dyeing lots on the knitting batch', () => {
    expect(knittingCode('01SS26', 1)).toBe('01SS26-KT01');
    expect(dyeingLotCode('01SS26-KT01', 2)).toBe('01SS26-KT01-DY02');
  });
});
