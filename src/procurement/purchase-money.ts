import { Prisma } from '@prisma/client';

type PurchaseMoneyLine = {
  quantity: Prisma.Decimal | string | number;
  rate: Prisma.Decimal | string | number;
  gstRate?: Prisma.Decimal | string | number | null;
};

/** Round each taxable line and its GST separately to paise. */
export function purchaseLineAmounts(line: PurchaseMoneyLine) {
  const subtotal = new Prisma.Decimal(line.quantity).mul(line.rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const gstAmount = subtotal
    .mul(line.gstRate ?? 0)
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { subtotal, gstAmount, totalAmount: subtotal.add(gstAmount) };
}

/** Authoritative amounts for create, list, detail and incoming PO responses. */
export function purchaseMoney<T extends PurchaseMoneyLine>(lines: T[], prices: boolean) {
  let subtotal = new Prisma.Decimal(0);
  let gstAmount = new Prisma.Decimal(0);
  const items = lines.map((line) => {
    const amounts = purchaseLineAmounts(line);
    subtotal = subtotal.add(amounts.subtotal);
    gstAmount = gstAmount.add(amounts.gstAmount);
    return {
      ...line,
      rate: prices ? line.rate : null,
      subtotal: prices ? amounts.subtotal.toFixed(2) : null,
      gstAmount: prices ? amounts.gstAmount.toFixed(2) : null,
      totalAmount: prices ? amounts.totalAmount.toFixed(2) : null,
    };
  });
  return {
    items,
    subtotal: prices ? subtotal.toFixed(2) : null,
    gstAmount: prices ? gstAmount.toFixed(2) : null,
    totalAmount: prices ? subtotal.add(gstAmount).toFixed(2) : null,
  };
}
