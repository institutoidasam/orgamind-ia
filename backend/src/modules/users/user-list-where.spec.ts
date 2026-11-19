import { describe, expect, it } from 'vitest';
import { foldAuthorizationCounts, userListWhere } from './user-list-where';

describe('userListWhere', () => {
  it('sem filtro nenhum devolve {} (lista todos, como antes)', () => {
    expect(userListWhere({})).toEqual({});
    expect(userListWhere({ status: 'all' })).toEqual({});
  });

  it('q aparada monta o OR: nome sem diferenciar caixa e matrícula pela chave em minúsculas', () => {
    expect(userListWhere({ q: '  AB-12 ' })).toEqual({
      OR: [
        { name: { contains: 'AB-12', mode: 'insensitive' } },
        { registrationKey: { contains: 'ab-12' } },
      ],
    });
  });

  it('q escapa os coringas do LIKE: "_", "%" e "\\" valem como texto', () => {
    expect(userListWhere({ q: 'a_b%c\\d' })).toEqual({
      OR: [
        { name: { contains: 'a\\_b\\%c\\\\d', mode: 'insensitive' } },
        { registrationKey: { contains: 'a\\_b\\%c\\\\d' } },
      ],
    });
  });

  it('q vazia ou só espaços não filtra', () => {
    expect(userListWhere({ q: '' })).toEqual({});
    expect(userListWhere({ q: '   ' })).toEqual({});
  });

  it('hasAccess false entra no filtro (não é confundido com ausente)', () => {
    expect(userListWhere({ hasAccess: false })).toEqual({ hasAccess: false });
    expect(userListWhere({ hasAccess: true })).toEqual({ hasAccess: true });
  });
});

describe('userListWhere: status, autorização e filtros combinados', () => {
  it.each([
    ['active', { isActive: true }],
    ['inactive', { isActive: false }],
  ] as const)('status %s filtra por isActive', (status, expected) => {
    expect(userListWhere({ status })).toEqual(expected);
  });

  it('UNVERIFIED = autorizado com origem "cadastro anterior"; NOT_AUTHORIZED = sem autorização', () => {
    expect(userListWhere({ authorization: 'UNVERIFIED' })).toEqual({
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'CADASTRO_ANTERIOR',
    });
    expect(userListWhere({ authorization: 'NOT_AUTHORIZED' })).toEqual({
      contactAuthorization: 'NAO_AUTORIZADO',
    });
  });

  it('filtros combinados valem todos ao mesmo tempo', () => {
    expect(
      userListWhere({
        hasAccess: true,
        q: 'Ana',
        status: 'active',
        authorization: 'NOT_AUTHORIZED',
      }),
    ).toEqual({
      hasAccess: true,
      isActive: true,
      contactAuthorization: 'NAO_AUTORIZADO',
      OR: [
        { name: { contains: 'Ana', mode: 'insensitive' } },
        { registrationKey: { contains: 'ana' } },
      ],
    });
  });
});

describe('foldAuthorizationCounts', () => {
  it('soma os grupos: não verificadas = autorizado/cadastro anterior; sem autorização = NAO_AUTORIZADO de qualquer origem', () => {
    const group = (
      contactAuthorization: 'AUTORIZADO' | 'NAO_AUTORIZADO',
      authorizationSource: 'CADASTRO_ANTERIOR' | 'TERMO_ASSINADO' | null,
      all: number,
    ) => ({ contactAuthorization, authorizationSource, _count: { _all: all } });
    expect(
      foldAuthorizationCounts([
        group('AUTORIZADO', 'CADASTRO_ANTERIOR', 4),
        group('AUTORIZADO', 'TERMO_ASSINADO', 7),
        group('NAO_AUTORIZADO', null, 3),
        group('NAO_AUTORIZADO', 'TERMO_ASSINADO', 2),
      ]),
    ).toEqual({ unverified: 4, notAuthorized: 5 });
  });

  it('sem pessoas zera os dois', () => {
    expect(foldAuthorizationCounts([])).toEqual({
      unverified: 0,
      notAuthorized: 0,
    });
  });
});
