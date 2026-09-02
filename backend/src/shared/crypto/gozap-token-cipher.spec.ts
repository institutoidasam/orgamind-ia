import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken, TokenCipherError } from './gozap-token-cipher';

const KEY = 'a'.repeat(64); // 32 bytes em hex

describe('gozap-token-cipher', () => {
  it('round-trip devolve o texto original', () => {
    const enc = encryptToken('inst_abc123', KEY);
    expect(enc).not.toContain('inst_abc123'); // não vaza plaintext
    expect(decryptToken(enc, KEY)).toBe('inst_abc123');
  });
  it('cada cifragem usa IV novo (ciphertexts diferentes p/ mesmo input)', () => {
    expect(encryptToken('x', KEY)).not.toBe(encryptToken('x', KEY));
  });
  it('rejeita adulteração (GCM tag inválida)', () => {
    const enc = encryptToken('inst_abc', KEY);
    const [iv, tag, ct] = enc.split(':');
    const tampered = [iv, tag, Buffer.from('zzzz').toString('base64')].join(':');
    expect(() => decryptToken(tampered, KEY)).toThrow(TokenCipherError);
  });
  it('rejeita chave de tamanho errado', () => {
    expect(() => encryptToken('x', 'short')).toThrow(TokenCipherError);
  });
  it('rejeita chave com comprimento certo mas charset inválido (não-hex)', () => {
    const wrongCharsetKey = 'z'.repeat(64); // 64 chars, mas 'z' não é dígito hex
    expect(() => encryptToken('x', wrongCharsetKey)).toThrow(TokenCipherError);
  });
  it('rejeita payload malformado', () => {
    expect(() => decryptToken('nope', KEY)).toThrow(TokenCipherError);
  });
});
