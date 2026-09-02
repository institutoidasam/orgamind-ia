import { describe, it, expect } from 'vitest';
import { FailureReason } from '@prisma/client';
import {
  CONTACT_VALIDITIES,
  CONTACT_VALIDITY_LABELS,
  INVALID_FAILURE_REASONS,
  classifyContactValidity,
  contactValidityWhere,
  excludeInvalidWhere,
  invalidContactWhere,
  unvalidatedContactWhere,
  validContactWhere,
} from './contact-validity';

/**
 * O `NOT IN` do SQL é TRÊS-VALORADO: `lastFailureReason NOT IN ('SEM_WHATSAPP')`
 * NÃO casa a linha cujo valor é NULL. Numa base em que quase todo mundo tem
 * NULL nos dois campos (é literalmente a base de produção do cliente), a
 * versão ingênua deste helper selecionaria ZERO pessoas — o mesmo defeito que
 * o toggle "Apenas números válidos" tem hoje. Os testes abaixo travam a forma
 * do `where`, e não o retorno de um mock: mock de Prisma ignora `where`.
 */
describe('contact-validity — as três classes', () => {
  it('as três classes existem e têm rótulo em PT-BR', () => {
    expect([...CONTACT_VALIDITIES]).toEqual([
      'valid',
      'invalid',
      'unvalidated',
    ]);
    expect(CONTACT_VALIDITY_LABELS.valid).toBe('Válido');
    expect(CONTACT_VALIDITY_LABELS.invalid).toBe('Inválido confirmado');
    expect(CONTACT_VALIDITY_LABELS.unvalidated).toBe('Não validado');
  });

  it('inválido confirmado = whatsappValid false OU lastFailureReason em SEM_WHATSAPP/TELEFONE_INVALIDO', () => {
    expect(INVALID_FAILURE_REASONS).toEqual([
      FailureReason.SEM_WHATSAPP,
      FailureReason.TELEFONE_INVALIDO,
    ]);
    expect(invalidContactWhere()).toEqual({
      OR: [
        { whatsappValid: false },
        { lastFailureReason: { in: INVALID_FAILURE_REASONS } },
      ],
    });
  });

  // ★ A FALSIFICAÇÃO DO `NOT IN`: sem o ramo `{ lastFailureReason: null }` este
  // teste passa a falhar, e é ele que impede a regressão que já mordeu o repo
  // duas vezes.
  it('excludeInvalidWhere é NULL-SAFE nos dois campos (4 regras, 2 ORs)', () => {
    expect(excludeInvalidWhere()).toEqual({
      AND: [
        { OR: [{ whatsappValid: null }, { whatsappValid: true }] },
        {
          OR: [
            { lastFailureReason: null },
            { lastFailureReason: { notIn: INVALID_FAILURE_REASONS } },
          ],
        },
      ],
    });
  });

  it('não validado exige whatsappValid NULL, motivo não-inválido null-safe e nenhuma entrega provada', () => {
    expect(unvalidatedContactWhere()).toEqual({
      AND: [
        { whatsappValid: null },
        {
          OR: [
            { lastFailureReason: null },
            { lastFailureReason: { notIn: INVALID_FAILURE_REASONS } },
          ],
        },
        {
          messages: {
            none: {
              direction: 'OUTBOUND',
              status: { in: ['DELIVERED', 'READ'] },
            },
          },
        },
      ],
    });
  });

  it('válido = não-inválido E (whatsappValid true OU entrega DELIVERED/READ)', () => {
    expect(validContactWhere()).toEqual({
      AND: [
        excludeInvalidWhere(),
        {
          OR: [
            { whatsappValid: true },
            {
              messages: {
                some: {
                  direction: 'OUTBOUND',
                  status: { in: ['DELIVERED', 'READ'] },
                },
              },
            },
          ],
        },
      ],
    });
  });

  it('contactValidityWhere despacha para as três', () => {
    expect(contactValidityWhere('invalid')).toEqual(invalidContactWhere());
    expect(contactValidityWhere('valid')).toEqual(validContactWhere());
    expect(contactValidityWhere('unvalidated')).toEqual(
      unvalidatedContactWhere(),
    );
  });
});

describe('classifyContactValidity — o contato TODO NULO', () => {
  // O caso que a base do cliente tem aos milhares.
  it('null em tudo, sem entrega => "unvalidated" (nunca "invalid")', () => {
    expect(
      classifyContactValidity({
        whatsappValid: null,
        lastFailureReason: null,
        hasProvenDelivery: false,
      }),
    ).toBe('unvalidated');
  });

  it('null em tudo, COM entrega provada => "valid"', () => {
    expect(
      classifyContactValidity({
        whatsappValid: null,
        lastFailureReason: null,
        hasProvenDelivery: true,
      }),
    ).toBe('valid');
  });

  it('whatsappValid false => "invalid"', () => {
    expect(
      classifyContactValidity({
        whatsappValid: false,
        lastFailureReason: null,
        hasProvenDelivery: false,
      }),
    ).toBe('invalid');
  });

  it('SEM_WHATSAPP => "invalid" mesmo sem whatsappValid', () => {
    expect(
      classifyContactValidity({
        whatsappValid: null,
        lastFailureReason: FailureReason.SEM_WHATSAPP,
        hasProvenDelivery: false,
      }),
    ).toBe('invalid');
  });

  it('OPT_OUT não é invalidez de NÚMERO => "unvalidated"', () => {
    expect(
      classifyContactValidity({
        whatsappValid: null,
        lastFailureReason: FailureReason.OPT_OUT,
        hasProvenDelivery: false,
      }),
    ).toBe('unvalidated');
  });

  // O conflito real: os dois sinais opostos na mesma linha. Inválido vence.
  it('whatsappValid true + TELEFONE_INVALIDO => "invalid" (a evidência negativa vence)', () => {
    expect(
      classifyContactValidity({
        whatsappValid: true,
        lastFailureReason: FailureReason.TELEFONE_INVALIDO,
        hasProvenDelivery: true,
      }),
    ).toBe('invalid');
  });
});

import type { FilterGroup } from '../schemas/contracts/filter.schema';
import {
  hasExcludeInvalidGroup,
  isExcludeInvalidGroup,
  stripExcludeInvalidGroup,
} from './contact-validity';

const GRUPO: FilterGroup = {
  combinator: 'and',
  rules: [
    {
      combinator: 'or',
      rules: [
        { field: 'whatsappValid', op: 'isNull' },
        { field: 'whatsappValid', op: 'eq', value: true },
      ],
    },
    {
      combinator: 'or',
      rules: [
        { field: 'lastFailureReason', op: 'isNull' },
        {
          field: 'lastFailureReason',
          op: 'notIn',
          value: ['SEM_WHATSAPP', 'TELEFONE_INVALIDO'],
        },
      ],
    },
  ],
};

describe('exclusão de inválidos dentro do filtro da campanha', () => {
  it('reconhece o grupo canônico que o assistente emite', () => {
    expect(isExcludeInvalidGroup(GRUPO)).toBe(true);
  });

  it('não confunde o filtro legado `whatsappValid eq true`', () => {
    expect(
      isExcludeInvalidGroup({ field: 'whatsappValid', op: 'eq', value: true }),
    ).toBe(false);
  });

  it('detecta o grupo na raiz do filtro', () => {
    expect(
      hasExcludeInvalidGroup({
        combinator: 'and',
        rules: [{ field: 'city', op: 'eq', value: 'Manaus' }, GRUPO],
      }),
    ).toBe(true);
  });

  // É isto que permite CONTAR quantos a exclusão tirou: a audiência sem a
  // exclusão, cruzada com "quem é inválido".
  it('remove só o grupo, preservando as regras do operador', () => {
    expect(
      stripExcludeInvalidGroup({
        combinator: 'and',
        rules: [{ field: 'city', op: 'eq', value: 'Manaus' }, GRUPO],
      }),
    ).toEqual({
      combinator: 'and',
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    });
  });

  // Achado (review): deixar `{combinator:'or', rules:[]}` para trás não é
  // neutro. `groupToPrisma` (filter.converter.ts) renderiza um grupo vazio
  // como `{}` — e `{}` dentro de um `OR` do Prisma é sempre-verdadeiro. Se o
  // grupo de exclusão fosse o ÚNICO filho de um `or`, o grupo pai colapsaria
  // para "casa todo mundo", e `excludedInvalid` contaria TODO inválido da
  // janela, não só os que o filtro do operador de fato tiraria. A correção:
  // grupo aninhado que fica vazio depois do strip é removido do pai (a raiz
  // continua podendo ficar vazia — é o `{combinator:'and', rules:[]}` que
  // `toPrismaWhere` já trata como "sem filtro do usuário").
  it('remove também em grupos aninhados — e o grupo `or` que ficou vazio some do pai (não vira {rules:[]} solto)', () => {
    expect(
      stripExcludeInvalidGroup({
        combinator: 'and',
        rules: [{ combinator: 'or', rules: [GRUPO] }],
      }),
    ).toEqual({ combinator: 'and', rules: [] });
  });

  it('grupo `or` com uma regra irmã ao lado de GRUPO: a irmã sobrevive, só o GRUPO some', () => {
    expect(
      stripExcludeInvalidGroup({
        combinator: 'and',
        rules: [
          {
            combinator: 'or',
            rules: [GRUPO, { field: 'city', op: 'eq', value: 'Manaus' }],
          },
        ],
      }),
    ).toEqual({
      combinator: 'and',
      rules: [
        {
          combinator: 'or',
          rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
        },
      ],
    });
  });

  it('filtro sem o grupo passa intacto', () => {
    const g: FilterGroup = { combinator: 'and', rules: [] };
    expect(hasExcludeInvalidGroup(g)).toBe(false);
    expect(stripExcludeInvalidGroup(g)).toEqual(g);
  });
});
