import { businessDate, factoryToday } from './business-date';

describe('Manual business dates', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-18T20:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('uses the factory calendar rather than the hosting server calendar', () => {
    expect(factoryToday()).toBe('2026-11-19');
    expect(businessDate(undefined, 'Entry date')).toEqual(new Date('2026-11-19'));
  });
  it('accepts 10 July and earlier years without replacing the date with the save date', () => {
    expect(businessDate('2026-07-10', 'Purchase')).toEqual(new Date('2026-07-10'));
    expect(businessDate('2025-12-31', 'Purchase')).toEqual(new Date('2025-12-31'));
  });
  it('allows all stages on the same calendar date even if a legacy record includes a time', () => {
    const day = businessDate('2026-07-10', 'Dyeing', new Date('2026-07-10T15:00:00Z'));
    expect(day).toEqual(new Date('2026-07-10'));
  });
  it.each(['2026-02-30', '2026-13-01', 'bad', ''])('rejects an invalid calendar date: %s', (value) => {
    expect(() => businessDate(value, 'Purchase')).toThrow('valid calendar date');
  });
  it('rejects future dates and dates earlier than the previous process', () => {
    expect(() => businessDate('2026-11-20', 'Purchase')).toThrow('future');
    expect(() => businessDate('2026-07-09', 'Dyeing', new Date('2026-07-10'))).toThrow('before 2026-07-10');
  });
});
