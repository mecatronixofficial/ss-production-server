import { checkText, packageTotal, packageUnitOf, PACKAGES_PATTERN } from './packages';

describe('bags and rolls as written on a DC', () => {
  it('adds up lots of bags and refuses words', () => {
    expect(packageTotal('30+9')).toBe(39);
    expect(packageTotal('30 + 9 + 1')).toBe(40);
    expect(packageTotal('12')).toBe(12);
    expect(packageTotal('')).toBeNull();
    expect(PACKAGES_PATTERN.test('30+9')).toBe(true);
    expect(PACKAGES_PATTERN.test('30 bags')).toBe(false);
    expect(PACKAGES_PATTERN.test('30+')).toBe(false);
  });

  it('packs yarn in bags and fabric in rolls', () => {
    expect(packageUnitOf('YARN')).toBe('bags');
    expect(packageUnitOf('DYED_FABRIC')).toBe('rolls');
    expect(packageUnitOf('CHEMICAL')).toBe('packages');
  });

  it('says whether what arrived matches what was sent', () => {
    expect(checkText(1825, 1825, 'KG')).toBe('Matches');
    expect(checkText(1825, 1819.5, 'KG')).toBe('Short 5.5 KG');
    expect(checkText(39, 40, 'bags')).toBe('Excess 1 bags');
    expect(checkText(null, 10, 'KG')).toBeNull();
  });
});
