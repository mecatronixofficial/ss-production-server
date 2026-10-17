const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Converts a jsonwebtoken-style duration ("15m", "7d", "3600") into milliseconds. */
export function durationToMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(value);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  // A bare number is seconds for jsonwebtoken's expiresIn.
  const unit = (match[2] ?? 's').toLowerCase();
  return Math.round(amount * UNIT_MS[unit]);
}
