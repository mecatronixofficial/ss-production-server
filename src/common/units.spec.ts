import { purchaseUnit, stockQuantity } from './units';

describe('purchaseUnit', () => {
  it('stores every way of writing grams as G', () => {
    for (const unit of ['g', 'G', ' gm ', 'GMS', 'grm', 'Gram', 'grams']) expect(purchaseUnit(unit)).toBe('G');
  });
  it('upper-cases other units', () => {
    expect(purchaseUnit(' kg ')).toBe('KG');
    expect(purchaseUnit('cone')).toBe('CONE');
  });
});

describe('stockQuantity', () => {
  it('puts grams into stock as KG', () => {
    expect(stockQuantity(500, 'G')).toEqual({ quantity: 0.5, unit: 'KG' });
    expect(stockQuantity(1250, 'gm')).toEqual({ quantity: 1.25, unit: 'KG' });
    expect(stockQuantity(1, 'G')).toEqual({ quantity: 0.001, unit: 'KG' });
  });
  it('keeps other units as ordered', () => {
    expect(stockQuantity(12.345, 'KG')).toEqual({ quantity: 12.345, unit: 'KG' });
    expect(stockQuantity(40, 'CONE')).toEqual({ quantity: 40, unit: 'CONE' });
  });
});
