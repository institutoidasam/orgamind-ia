import { describe, it, expect } from 'vitest';
import type { FilterGroup } from './schemas';
import {
  excludeInvalidGroup,
  hasExcludeInvalid,
  hasLegacyValidOnlyRule,
  isExcludeInvalidGroup,
  withExcludeInvalid,
  withoutExcludeInvalid,
} from './exclude-invalid';

const EMPTY: FilterGroup = { combinator: 'and', rules: [] };

describe('excludeInvalidGroup — as 4 regras null-safe da spec', () => {
  it('é exatamente (whatsappValid isNull OU eq true) E (lastFailureReason isNull OU notIn os dois motivos)', () => {
    expect(excludeInvalidGroup()).toEqual({
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
    });
  });

  /**
   * ★ O DEFEITO QUE ISTO SUBSTITUI. O toggle antigo emitia `whatsappValid eq
   * true` — numa base em que `whatsappValid` é NULL para quase todo mundo,
   * isso seleciona ZERO pessoas, e a campanha sai vazia sem nenhum erro.
   */
  it('NÃO é o `whatsappValid eq true` sozinho do toggle antigo', () => {
    expect(
      isExcludeInvalidGroup({
        field: 'whatsappValid',
        op: 'eq',
        value: true,
      }),
    ).toBe(false);
  });

  it('reconhece o próprio grupo mesmo com chaves extras (os __uid do builder)', () => {
    const withUids = {
      ...excludeInvalidGroup(),
      __uid: 'x',
      rules: excludeInvalidGroup().rules.map((r) => ({ ...r, __uid: 'y' })),
    };
    expect(isExcludeInvalidGroup(withUids)).toBe(true);
  });

  it('não confunde um grupo parecido (motivo a mais na lista)', () => {
    const quase = excludeInvalidGroup();
    (quase.rules[1] as FilterGroup).rules[1] = {
      field: 'lastFailureReason',
      op: 'notIn',
      value: ['SEM_WHATSAPP'],
    };
    expect(isExcludeInvalidGroup(quase)).toBe(false);
  });
});

describe('withExcludeInvalid / withoutExcludeInvalid', () => {
  it('acrescenta o grupo à raiz e passa a ser detectado', () => {
    const g = withExcludeInvalid(EMPTY);
    expect(hasExcludeInvalid(g)).toBe(true);
    expect(g.rules).toHaveLength(1);
  });

  it('é idempotente — ligar duas vezes não duplica o grupo', () => {
    const g = withExcludeInvalid(withExcludeInvalid(EMPTY));
    expect(g.rules).toHaveLength(1);
  });

  it('remove só o grupo canônico, preservando as regras do operador', () => {
    const comRegra: FilterGroup = {
      combinator: 'and',
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    };
    const ligado = withExcludeInvalid(comRegra);
    const desligado = withoutExcludeInvalid(ligado);
    expect(desligado.rules).toEqual([{ field: 'city', op: 'eq', value: 'Manaus' }]);
  });

  it('desligar num filtro que nunca teve o grupo é no-op', () => {
    expect(withoutExcludeInvalid(EMPTY).rules).toEqual([]);
  });
});

describe('hasLegacyValidOnlyRule — o filtro que zera a audiência', () => {
  it('detecta o `whatsappValid eq true` de campanhas/segmentos antigos', () => {
    expect(
      hasLegacyValidOnlyRule({
        combinator: 'and',
        rules: [{ field: 'whatsappValid', op: 'eq', value: true }],
      }),
    ).toBe(true);
  });

  it('o grupo novo NÃO é confundido com o legado', () => {
    expect(hasLegacyValidOnlyRule(withExcludeInvalid(EMPTY))).toBe(false);
  });
});
