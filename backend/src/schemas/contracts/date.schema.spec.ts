import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { dateFromIso } from './date.schema';

/**
 * O teste que importa aqui não é "parseia data" — é "NÃO derruba o boot".
 * O `main.ts` monta o Swagger sempre que `NODE_ENV !== 'production'`, e o
 * `toJSONSchema` LANÇA em qualquer campo cujo tipo de ENTRADA seja `Date`
 * (o caso do `z.coerce.date()`), matando o processo. Um `.nullable()` ou
 * `.optional()` a mais no caminho não pode reintroduzir isso, daí as 4
 * variantes.
 */
describe('dateFromIso — representável em JSON Schema', () => {
  const variantes = {
    pelado: dateFromIso(),
    nullable: dateFromIso().nullable(),
    optional: dateFromIso().optional(),
    'nullable+optional': dateFromIso().nullable().optional(),
    'com mensagem custom': dateFromIso({ error: 'Informe a data.' }),
  };

  for (const [nome, schema] of Object.entries(variantes)) {
    it(`gera JSON Schema (io: 'input') para a variante ${nome}`, () => {
      expect(() =>
        z.toJSONSchema(z.object({ f: schema }), { io: 'input' }),
      ).not.toThrow();
    });
  }
});

describe('dateFromIso — aceitação', () => {
  // Os 5 formatos que o `z.coerce.date()` aceitava e que o front/os provedores
  // realmente mandam. Regressão em qualquer um deles é um 400 em produção.
  it.each([
    ['ISO com Z', '2026-07-27T12:00:00.000Z', '2026-07-27T12:00:00.000Z'],
    ['ISO com offset', '2026-07-27T12:00:00-03:00', '2026-07-27T15:00:00.000Z'],
    ['data-só', '2026-07-27', '2026-07-27T00:00:00.000Z'],
  ])('aceita %s', (_nome, entrada, esperado) => {
    const r = dateFromIso().parse(entrada);
    expect(r.toISOString()).toBe(esperado);
  });

  it('aceita ISO local sem zona (lido como hora local, como no new Date())', () => {
    // Sem asserção de instante: o resultado depende do TZ de quem roda.
    expect(dateFromIso().parse('2026-07-27T12:00:00')).toBeInstanceOf(Date);
    expect(dateFromIso().parse('2026-07-27T12:00:00.123')).toBeInstanceOf(Date);
  });

  it('a saída é um Date (o código e o Prisma dependem disso)', () => {
    expect(dateFromIso().parse('2026-07-27T12:00:00.000Z')).toBeInstanceOf(
      Date,
    );
  });

  it('REJEITA null — o z.coerce.date() coagia para a epoch de 1970', () => {
    // Era um bug latente: data ausente virava 01/01/1970 sem ninguém notar.
    // Quem pode ser nulo declara `.nullable()`, que é o que a coluna diz.
    expect(dateFromIso().safeParse(null).success).toBe(false);
    expect(dateFromIso().nullable().safeParse(null).success).toBe(true);
  });

  it('rejeita string que não é data', () => {
    expect(dateFromIso().safeParse('ontem').success).toBe(false);
  });

  it('preserva a mensagem de erro custom em PT-BR', () => {
    const schema = z.object({
      collectedAt: dateFromIso({ error: 'Informe a data da coleta.' }),
    });
    const res = schema.safeParse({});
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain(
      'Informe a data da coleta.',
    );
  });
});
