import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { retryRecipientsSchema } from './retry-recipients.dto';

describe('retryRecipientsSchema (C6)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['uma lista de ids', { recipientIds: ['r1', 'r2'] }],
    [
      'o limite de 100 ids',
      { recipientIds: Array.from({ length: 100 }, (_, i) => `r${i}`) },
    ],
    ['todas as falhas certas', { all: true }],
  ])('%s é aceito', (_caso, body) => {
    expect(retryRecipientsSchema.parse(body)).toEqual(body);
  });

  it.each<[string, Record<string, unknown>]>([
    ['corpo vazio', {}],
    ['all false', { all: false }],
    ['lista vazia', { recipientIds: [] }],
    ['os dois juntos', { recipientIds: ['r1'], all: true }],
    [
      '101 ids',
      { recipientIds: Array.from({ length: 101 }, (_, i) => `r${i}`) },
    ],
    ['id vazio', { recipientIds: [''] }],
    ['id que não é texto', { recipientIds: [1] }],
    ['chave desconhecida com ids', { recipientIds: ['r1'], extra: 1 }],
    ['chave desconhecida com all', { all: true, extra: 1 }],
  ])('%s → 400 pelo pipe da rota', (_caso, body) => {
    const pipe = new ZodValidationPipe(retryRecipientsSchema);
    expect(() => {
      pipe.transform(body, { type: 'body' });
    }).toThrow(BadRequestException);
  });
});
