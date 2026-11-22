import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  authorizationColumns,
  normalizeRegistration,
  rethrowRegistrationConflict,
  toContactAuthorization,
  type AuthorizationRow,
} from './person-record';

// 02:00 UTC de 20/11 = 22:00 de 19/11 em Manaus (UTC-4): "hoje" é 19/11.
const NOW = new Date('2026-11-20T02:00:00.000Z');
const ACTOR = 'admin-1';
const TODAY_DB = new Date('2026-11-19T00:00:00.000Z');

const signedToday: AuthorizationRow = {
  contactAuthorization: 'AUTORIZADO',
  authorizationSource: 'TERMO_ASSINADO',
  authorizationNote: null,
  authorizationDate: TODAY_DB,
  authorizationRecordedAt: new Date('2026-11-19T21:00:00.000Z'),
};

const notAuthorized: AuthorizationRow = {
  contactAuthorization: 'NAO_AUTORIZADO',
  authorizationSource: null,
  authorizationNote: null,
  authorizationDate: null,
  authorizationRecordedAt: new Date('2026-11-19T21:00:00.000Z'),
};

describe('authorizationColumns: nota da origem', () => {
  it('só a origem OUTRO guarda a nota, aparada', () => {
    const input = {
      status: 'AUTORIZADO',
      source: 'OUTRO',
      note: '  Ligação  ',
    } as const;
    expect(authorizationColumns(input, ACTOR, NOW)).toMatchObject({
      authorizationSource: 'OUTRO',
      authorizationNote: 'Ligação',
    });
  });

  it('nas demais origens a nota enviada é descartada e grava nulo', () => {
    const input = {
      status: 'AUTORIZADO',
      source: 'TERMO_ASSINADO',
      note: 'Pasta 3',
    } as const;
    expect(authorizationColumns(input, ACTOR, NOW)).toMatchObject({
      authorizationSource: 'TERMO_ASSINADO',
      authorizationNote: null,
    });
  });

  it('na edição, nota enviada fora de OUTRO não conta como mudança (D17)', () => {
    const input = {
      status: 'AUTORIZADO',
      source: 'TERMO_ASSINADO',
      note: 'Pasta 3',
    } as const;
    expect(authorizationColumns(input, ACTOR, NOW, signedToday)).toEqual({});
  });
});

describe('authorizationColumns: edição para não autorizado', () => {
  it('AUTORIZADO para NAO_AUTORIZADO limpa origem, nota e data e registra autor e momento', () => {
    const outro: AuthorizationRow = {
      ...signedToday,
      authorizationSource: 'OUTRO',
      authorizationNote: 'Ligação',
    };
    expect(
      authorizationColumns({ status: 'NAO_AUTORIZADO' }, 'admin-2', NOW, outro),
    ).toEqual({
      contactAuthorization: 'NAO_AUTORIZADO',
      authorizationSource: null,
      authorizationNote: null,
      authorizationDate: null,
      authorizationRecordedById: 'admin-2',
      authorizationRecordedAt: NOW,
    });
  });

  it('NAO_AUTORIZADO reenviado sobre NAO_AUTORIZADO não mexe nas colunas (D17)', () => {
    const input = { status: 'NAO_AUTORIZADO' } as const;
    expect(authorizationColumns(input, ACTOR, NOW, notAuthorized)).toEqual({});
  });
});

describe('normalizeRegistration', () => {
  it('apara o que foi digitado e deriva a chave em minúsculas', () => {
    expect(normalizeRegistration(' Ab-12 ')).toEqual({
      registration: 'Ab-12',
      registrationKey: 'ab-12',
    });
  });

  it.each([undefined, null, '', '   '])('vazio (%j) vira nulos', (raw) => {
    expect(normalizeRegistration(raw)).toEqual({
      registration: null,
      registrationKey: null,
    });
  });
});

describe('authorizationColumns: criação', () => {
  it('sem autorização na criação grava NAO_AUTORIZADO com autor e momento', () => {
    expect(authorizationColumns(undefined, ACTOR, NOW)).toEqual({
      contactAuthorization: 'NAO_AUTORIZADO',
      authorizationSource: null,
      authorizationNote: null,
      authorizationDate: null,
      authorizationRecordedById: ACTOR,
      authorizationRecordedAt: NOW,
    });
  });

  it('AUTORIZADO sem data usa hoje no fuso do app, não o dia UTC', () => {
    const cols = authorizationColumns(
      { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' },
      ACTOR,
      NOW,
    );
    expect(cols).toMatchObject({
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'TERMO_ASSINADO',
      authorizationDate: TODAY_DB,
      authorizationRecordedById: ACTOR,
      authorizationRecordedAt: NOW,
    });
  });

  it('data futura no fuso do app é recusada com 422, mesmo sendo hoje em UTC', () => {
    const input = {
      status: 'AUTORIZADO',
      source: 'OUTRO',
      note: 'Ligação',
      date: '2026-11-20',
    } as const;
    expect(() => authorizationColumns(input, ACTOR, NOW)).toThrow(
      expect.objectContaining({
        code: 'user.authorization_future_date',
        status: 422,
      }),
    );
  });
});

describe('authorizationColumns: edição', () => {
  it('na edição, reenviar a mesma autorização não mexe nas colunas (D17)', () => {
    const same = { status: 'AUTORIZADO', source: 'TERMO_ASSINADO' } as const;
    expect(authorizationColumns(same, ACTOR, NOW, signedToday)).toEqual({});
    expect(authorizationColumns(undefined, ACTOR, NOW, signedToday)).toEqual(
      {},
    );
  });

  it('na edição, origem diferente grava as colunas novas com autor e momento', () => {
    const input = { status: 'AUTORIZADO', source: 'FICHA_ADMISSAO' } as const;
    expect(authorizationColumns(input, 'admin-2', NOW, signedToday)).toEqual({
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'FICHA_ADMISSAO',
      authorizationNote: null,
      authorizationDate: TODAY_DB,
      authorizationRecordedById: 'admin-2',
      authorizationRecordedAt: NOW,
    });
  });
});

describe('toContactAuthorization', () => {
  it('linha da migração (CADASTRO_ANTERIOR) sai sem data e com o momento em ISO', () => {
    expect(
      toContactAuthorization({
        contactAuthorization: 'AUTORIZADO',
        authorizationSource: 'CADASTRO_ANTERIOR',
        authorizationNote: null,
        authorizationDate: null,
        authorizationRecordedAt: new Date('2026-11-19T10:00:00.000Z'),
      }),
    ).toEqual({
      status: 'AUTORIZADO',
      source: 'CADASTRO_ANTERIOR',
      note: null,
      date: null,
      recordedAt: '2026-11-19T10:00:00.000Z',
    });
  });

  it('a data da coluna vira data civil', () => {
    expect(toContactAuthorization(signedToday).date).toBe('2026-11-19');
  });
});

describe('rethrowRegistrationConflict', () => {
  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    });

  it('P2002 na chave da matrícula vira 422 user.registration_taken', () => {
    expect(() =>
      rethrowRegistrationConflict(p2002(['registrationKey'])),
    ).toThrow(
      expect.objectContaining({
        code: 'user.registration_taken',
        status: 422,
        message: 'Já existe uma pessoa com esta matrícula',
      }),
    );
  });

  it('qualquer outro erro é relançado como veio', () => {
    const email = p2002(['email']);
    expect(() => rethrowRegistrationConflict(email)).toThrow(email);
    const boom = new Error('boom');
    expect(() => rethrowRegistrationConflict(boom)).toThrow(boom);
  });
});
