import { decryptSecret, encryptionKeyReady, encryptSecret, keyFingerprint } from './crypto';

describe('encryptSecret / decryptSecret', () => {
  const original = process.env.DATA_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
  });
  afterAll(() => {
    process.env.DATA_ENCRYPTION_KEY = original;
  });

  it('round-trips and never stores the plain value', () => {
    const stored = encryptSecret('123456789012');
    expect(stored).not.toContain('123456789012');
    expect(decryptSecret(stored)).toBe('123456789012');
  });

  it('gives a different ciphertext each time', () => {
    expect(encryptSecret('123456789012')).not.toBe(encryptSecret('123456789012'));
  });

  it('rejects tampered values', () => {
    const [v, iv, tag, data] = encryptSecret('123456789012').split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('fingerprints the key without revealing it, and tells keys apart', () => {
    const first = keyFingerprint();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toContain('aaaa');
    expect(keyFingerprint()).toBe(first);
    process.env.DATA_ENCRYPTION_KEY = 'b'.repeat(64);
    expect(keyFingerprint()).not.toBe(first);
  });

  it('reports whether a usable key is set', () => {
    expect(encryptionKeyReady()).toBe(true);
    process.env.DATA_ENCRYPTION_KEY = '';
    expect(encryptionKeyReady()).toBe(false);
    expect(keyFingerprint()).toBeNull();
  });

  it('refuses to work without a valid key', () => {
    process.env.DATA_ENCRYPTION_KEY = 'short';
    expect(() => encryptSecret('1')).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
