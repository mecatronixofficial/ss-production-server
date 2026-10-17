/** Ways people write grams; all are stored as G. */
const GRAM_UNITS = new Set(['G', 'GM', 'GMS', 'GRM', 'GRAM', 'GRAMS']);
export const purchaseUnit = (unit: string) => {
  const u = unit.trim().toUpperCase();
  return GRAM_UNITS.has(u) ? 'G' : u;
};
/**
 * What a received line puts into stock. Grams go in as KG (500 G → 0.5 KG), so a dye bought in grams sits with
 * every other weight; other units are kept as ordered.
 */
export const stockQuantity = (quantity: number, unit: string) =>
  purchaseUnit(unit) === 'G' ? { quantity: Math.round(quantity) / 1000, unit: 'KG' } : { quantity, unit };
