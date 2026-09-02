import { describe, it, expect } from 'vitest';
import {
  ZERNIO_RECIPIENTS_CHUNK_DEFAULT,
  ZERNIO_RECIPIENTS_CHUNK_MAX,
  chunkRecipients,
  effectiveChunkSize,
  isChunkTooLargeError,
  shrinkChunk,
} from './zernio-broadcast-chunk.helper';

describe('chunkRecipients', () => {
  it('fatia em blocos do tamanho pedido, sem perder nem repetir ninguém', () => {
    const items = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const chunks = chunkRecipients(items, 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(items);
  });

  it('lista vazia => nenhum bloco (não manda um POST /recipients vazio)', () => {
    expect(chunkRecipients([], 50)).toEqual([]);
  });

  it('um chunk <= 0 nunca vira laço infinito: cai no mínimo de 1', () => {
    expect(chunkRecipients(['a', 'b'], 0)).toEqual([['a'], ['b']]);
    expect(chunkRecipients(['a', 'b'], -10)).toEqual([['a'], ['b']]);
  });
});

describe('effectiveChunkSize', () => {
  it('sem configuração do canal => o default conservador', () => {
    expect(effectiveChunkSize(null)).toBe(ZERNIO_RECIPIENTS_CHUNK_DEFAULT);
    expect(effectiveChunkSize(undefined)).toBe(ZERNIO_RECIPIENTS_CHUNK_DEFAULT);
    expect(effectiveChunkSize(0)).toBe(ZERNIO_RECIPIENTS_CHUNK_DEFAULT);
  });

  it('respeita o canal quando ele configura um valor sensato', () => {
    expect(effectiveChunkSize(25)).toBe(25);
    expect(effectiveChunkSize(100)).toBe(100);
  });

  it('TETO DURO: o site do Zernio anuncia 100/request — nunca acima disso', () => {
    expect(effectiveChunkSize(5000)).toBe(ZERNIO_RECIPIENTS_CHUNK_MAX);
    expect(ZERNIO_RECIPIENTS_CHUNK_MAX).toBe(100);
  });

  it('valor negativo do banco não vira laço infinito', () => {
    expect(effectiveChunkSize(-1)).toBe(ZERNIO_RECIPIENTS_CHUNK_DEFAULT);
  });
});

describe('isChunkTooLargeError', () => {
  it('413 é sempre "grande demais"', () => {
    expect(isChunkTooLargeError(413, undefined)).toBe(true);
  });

  it('400 que FALA de limite de destinatários é "grande demais"', () => {
    expect(
      isChunkTooLargeError(400, { error: 'Maximum 100 recipients per request' }),
    ).toBe(true);
    expect(isChunkTooLargeError(400, { error: 'too many recipients' })).toBe(
      true,
    );
    expect(
      isChunkTooLargeError(400, { error: 'phones array exceeds maximum length' }),
    ).toBe(true);
  });

  it('400 de OUTRA coisa NÃO é: encolher o chunk não conserta um telefone inválido', () => {
    expect(
      isChunkTooLargeError(400, { error: 'Invalid phone number: 55' }),
    ).toBe(false);
    expect(isChunkTooLargeError(400, { error: 'broadcast already sent' })).toBe(
      false,
    );
  });

  it('401/404/500 nunca são "grande demais" — retentar menor só queima o balde', () => {
    expect(isChunkTooLargeError(401, { error: 'too many recipients' })).toBe(
      false,
    );
    expect(isChunkTooLargeError(500, undefined)).toBe(false);
  });
});

describe('shrinkChunk', () => {
  it('LÊ O NÚMERO DO CORPO DO ERRO — é ele que revela o limite real', () => {
    expect(shrinkChunk(200, { error: 'Maximum 100 recipients per request' })).toBe(
      100,
    );
    expect(shrinkChunk(100, { error: 'maximum of 25 recipients allowed' })).toBe(
      25,
    );
  });

  it('ignora um número do corpo que NÃO reduz (senão o retry repete o mesmo erro)', () => {
    expect(shrinkChunk(50, { error: 'Maximum 100 recipients' })).toBe(25);
  });

  it('sem número no corpo => metade', () => {
    expect(shrinkChunk(100, { error: 'payload too large' })).toBe(50);
    expect(shrinkChunk(50, undefined)).toBe(25);
    expect(shrinkChunk(3, undefined)).toBe(1);
  });

  it('chunk 1 já é o mínimo => null (desiste; não há como encolher mais)', () => {
    expect(shrinkChunk(1, undefined)).toBeNull();
  });
});
