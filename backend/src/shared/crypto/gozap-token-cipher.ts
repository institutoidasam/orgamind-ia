import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

export class TokenCipherError extends Error {}

function keyBuffer(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new TokenCipherError('GOZAP_TOKEN_ENCRYPTION_KEY deve ser 32 bytes em hex (64 chars)');
  }
  return Buffer.from(keyHex, 'hex');
}

/** Cifra um segredo curto. Formato: base64(iv):base64(tag):base64(ciphertext). */
export function encryptToken(plaintext: string, keyHex: string): string {
  const key = keyBuffer(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptToken(payload: string, keyHex: string): string {
  const key = keyBuffer(keyHex);
  const parts = payload.split(':');
  if (parts.length !== 3) throw new TokenCipherError('payload cifrado malformado');
  try {
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new TokenCipherError(
      `falha ao decifrar token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
