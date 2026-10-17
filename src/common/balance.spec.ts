import { orderPending, processBalance, stockBalance } from './balance';

describe('ERP balance formulas', () => {
  it('calculates knitting balance', () => expect(processBalance(10800, 10350, 250)).toBe(200));
  it('calculates dyeing balance', () => expect(processBalance(10350, 10000, 300)).toBe(50));
  it('calculates order pending', () => expect(orderPending(10000, 8000)).toBe(2000));
  it('calculates immutable-ledger stock balance', () => expect(stockBalance(9950, 8000)).toBe(1950));
});
