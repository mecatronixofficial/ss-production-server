import { ChequeStatus, PaymentMode } from '@prisma/client';
import { counts, isOpenCheque, nameKey, salePayment } from './money-rules';

describe('money rules', () => {
  const entry = (mode: PaymentMode, chequeStatus: ChequeStatus | null, cancelledAt: Date | null = null) => ({
    mode,
    chequeStatus,
    cancelledAt,
  });

  it('counts cash / UPI / bank at once, a cheque only once cleared, nothing cancelled', () => {
    expect(counts(entry(PaymentMode.CASH, null))).toBe(true);
    expect(counts(entry(PaymentMode.UPI, null))).toBe(true);
    expect(counts(entry(PaymentMode.CHEQUE, ChequeStatus.PENDING))).toBe(false);
    expect(counts(entry(PaymentMode.CHEQUE, ChequeStatus.DEPOSITED))).toBe(false);
    expect(counts(entry(PaymentMode.CHEQUE, ChequeStatus.CLEARED))).toBe(true);
    expect(counts(entry(PaymentMode.CHEQUE, ChequeStatus.BOUNCED))).toBe(false);
    expect(counts(entry(PaymentMode.CASH, null, new Date()))).toBe(false);
  });

  it('treats only pending / deposited cheques as open', () => {
    expect(isOpenCheque(entry(PaymentMode.CHEQUE, ChequeStatus.PENDING))).toBe(true);
    expect(isOpenCheque(entry(PaymentMode.CHEQUE, ChequeStatus.DEPOSITED))).toBe(true);
    expect(isOpenCheque(entry(PaymentMode.CHEQUE, ChequeStatus.CLEARED))).toBe(false);
    expect(isOpenCheque(entry(PaymentMode.CHEQUE, ChequeStatus.PENDING, new Date()))).toBe(false);
  });

  it('works out how much of a bill is paid', () => {
    expect(salePayment(1000)).toEqual({ received: 0, pending: 0, due: 1000, status: 'UNPAID' });
    expect(salePayment(1000, { received: 400, pending: 0 })).toEqual({ received: 400, pending: 0, due: 600, status: 'PART_PAID' });
    expect(salePayment(1000, { received: 400, pending: 600 }).status).toBe('CHEQUE_PENDING');
    expect(salePayment(1000, { received: 0, pending: 300 }).status).toBe('PART_PAID');
    expect(salePayment(1000, { received: 1000, pending: 0 }).status).toBe('PAID');
    // Loaded short after money came in: nothing is due, never negative.
    expect(salePayment(800, { received: 1000, pending: 0 })).toEqual({ received: 1000, pending: 0, due: 0, status: 'PAID' });
  });

  it('matches textile names in any case or spacing', () => {
    expect(nameKey('  Sri  Murugan   TEX ')).toBe(nameKey('sri murugan tex'));
  });
});
