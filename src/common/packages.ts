/** Bags / rolls as written on a DC: "12", "30+9" (two lots of bags), with spaces allowed. */
export const PACKAGES_PATTERN = /^\s*\d+(\s*\+\s*\d+)*\s*$/;

/** Their total ("30+9" is 39); null when none were written. */
export function packageTotal(text?: string | null) {
  const parts = (text ?? '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.reduce((sum, p) => sum + Number(p), 0);
}

/** What a material comes packed in: yarn in bags, fabric in rolls, anything else in packages. */
export const packageUnitOf = (category?: string | null) => (category === 'YARN' ? 'bags' : category?.endsWith('_FABRIC') ? 'rolls' : 'packages');

/** "Short 5.000 KG", "Excess 2 rolls" or "Matches": what arrived against what was sent. */
export function checkText(sent: number | null | undefined, received: number, unit: string) {
  if (sent === null || sent === undefined) return null;
  const diff = Math.round((received - sent) * 1000) / 1000;
  if (Math.abs(diff) < 0.0005) return 'Matches';
  return `${diff < 0 ? 'Short' : 'Excess'} ${Math.abs(diff)} ${unit}`;
}
