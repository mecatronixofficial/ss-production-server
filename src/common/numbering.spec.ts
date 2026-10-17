import { formatDocumentNo } from './numbering';

describe('document numbering', () => {
  it('pads the yearly sequence to six digits', () => expect(formatDocumentNo('SO', 2026, 42)).toBe('SO-2026-000042'));
  it('keeps growing past six digits', () => expect(formatDocumentNo('INV', 2026, 1234567)).toBe('INV-2026-1234567'));
});
