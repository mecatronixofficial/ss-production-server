import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import { BadRequestException } from '@nestjs/common';

/**
 * Field-level encryption for secrets kept in the database (bank account numbers). AES-256-GCM with a random IV per
 * value, so equal numbers give different ciphertexts and any tampering fails to decrypt. The key is
 * `DATA_ENCRYPTION_KEY` (64 hex characters); without it nothing secret can be stored. Losing the key makes stored
 * values unreadable, so back it up with the database credentials.
 *
 * Stored format: `v1:<iv>:<tag>:<ciphertext>`, each part base64.
 */
const VERSION = 'v1';

export const MISSING_KEY_MESSAGE =
  'Bank account numbers are stored encrypted, and the server has no encryption key yet. Ask the administrator to set DATA_ENCRYPTION_KEY (64 hex characters) in the backend .env and restart.';

const rawKey = () => {
  const raw = process.env.DATA_ENCRYPTION_KEY?.trim();
  return raw && /^[0-9a-fA-F]{64}$/.test(raw) ? raw : null;
};

/** Whether a valid key is configured, so secrets can be stored. */
export const encryptionKeyReady = () => rawKey() !== null;

/**
 * A non-secret fingerprint of the key (HMAC, first 16 hex characters): tells whether the key in use is the one the
 * stored values were encrypted with, without revealing it. Null when there is no key.
 */
export function keyFingerprint() {
  const raw = rawKey();
  return raw ? createHmac('sha256', Buffer.from(raw, 'hex')).update('ss-erp:data-encryption-key-check').digest('hex').slice(0, 16) : null;
}

function key() {
  const raw = rawKey();
  if (!raw) throw new BadRequestException(MISSING_KEY_MESSAGE);
  return Buffer.from(raw, 'hex');
}

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(payload: string) {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('Unknown encrypted value format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
