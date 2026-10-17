import { durationToMs } from './duration';

describe('durationToMs', () => {
  it('parses jsonwebtoken-style durations', () => {
    expect(durationToMs('15m', 0)).toBe(15 * 60_000);
    expect(durationToMs('7d', 0)).toBe(7 * 86_400_000);
    expect(durationToMs('12h', 0)).toBe(12 * 3_600_000);
  });
  it('treats a bare number as seconds', () => expect(durationToMs('3600', 0)).toBe(3_600_000));
  it('falls back on missing or invalid input', () => {
    expect(durationToMs(undefined, 42)).toBe(42);
    expect(durationToMs('soon', 42)).toBe(42);
  });
});
