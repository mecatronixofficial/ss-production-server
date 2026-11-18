import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PurchaseOrderItemDto } from './dto/procurement.dto';
import { purchaseMoney } from './purchase-money';

describe('purchase order GST', () => {
  it('adds different item GST rates to the order total', () => {
    const result = purchaseMoney(
      [
        { quantity: '10', rate: '100.00', gstRate: '5.00' },
        { quantity: '2', rate: '250.00', gstRate: '18.00' },
      ],
      true,
    );
    expect(result).toMatchObject({ subtotal: '1500.00', gstAmount: '140.00', totalAmount: '1640.00' });
    expect(result.items[0]).toMatchObject({ subtotal: '1000.00', gstAmount: '50.00', totalAmount: '1050.00' });
    expect(result.items[1]).toMatchObject({ subtotal: '500.00', gstAmount: '90.00', totalAmount: '590.00' });
  });

  it('rounds each taxable line and GST before summing, including half-paise values', () => {
    const result = purchaseMoney(
      [
        { quantity: '1.005', rate: '1', gstRate: '5' },
        { quantity: '0.333', rate: '0.05', gstRate: '18' },
        { quantity: '1', rate: '0.10', gstRate: '5' },
      ],
      true,
    );
    expect(result).toMatchObject({ subtotal: '1.13', gstAmount: '0.06', totalAmount: '1.19' });
  });

  it('keeps old orders without GST and empty totals at zero', () => {
    expect(purchaseMoney([{ quantity: 2, rate: 100 }], true)).toMatchObject({ gstAmount: '0.00', totalAmount: '200.00' });
    expect(purchaseMoney([], true)).toMatchObject({ subtotal: '0.00', gstAmount: '0.00', totalAmount: '0.00' });
  });

  it('hides line and order money from warehouse viewers', () => {
    const result = purchaseMoney([{ quantity: 10, rate: 100, gstRate: 5 }], false);
    expect(result).toMatchObject({ subtotal: null, gstAmount: null, totalAmount: null });
    expect(result.items[0]).toMatchObject({ rate: null, subtotal: null, gstAmount: null, totalAmount: null });
  });

  const item = { itemName: 'Yarn', category: 'YARN', quantity: 10, unit: 'KG', rate: 100 };
  it('defaults new items to 18% and keeps an explicit 0% choice', () => {
    expect(plainToInstance(PurchaseOrderItemDto, item).gstRate).toBe(18);
    expect(plainToInstance(PurchaseOrderItemDto, { ...item, gstRate: 0 }).gstRate).toBe(0);
  });
  it.each([undefined, 0, 5, 12, 18, 28, 5.25, 100])('accepts GST %s', async (gstRate) => {
    const errors = await validate(plainToInstance(PurchaseOrderItemDto, { ...item, gstRate }));
    expect(errors).toHaveLength(0);
  });

  it.each([-1, 100.01, 5.123, '5', NaN, Infinity])('rejects invalid GST %s', async (gstRate) => {
    const errors = await validate(plainToInstance(PurchaseOrderItemDto, { ...item, gstRate }));
    expect(errors.some((error) => error.property === 'gstRate')).toBe(true);
  });
});
