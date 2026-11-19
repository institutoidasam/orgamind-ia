import { describe, it, expect } from 'vitest';
import type { Role } from '@prisma/client';
import {
  canChangePersonStatus,
  canDeletePerson,
  canEditContactAuthorization,
  canQueryAuditTrail,
  canViewPersonHistory,
  personHistoryCategories,
  type PermissionActor,
} from './person-actions.policy';
import { actorWith, type PermissionChange } from './actor.test-fixtures';

const actor = (role: Role, change?: PermissionChange): PermissionActor =>
  actorWith(role, change);
const withLogin = { hasAccess: true };
const noLogin = { hasAccess: false };

/** Lote A, por papel fixo: papel, pessoa com login, no alcance → [inativa, edita autorização, vê histórico]. */
const LOTE_A = [
  ['ADMIN', true, true, [true, true, true]],
  ['ADMIN', true, false, [true, true, true]],
  ['ADMIN', false, true, [true, true, true]],
  ['ADMIN', false, false, [true, true, true]],
  ['SUPERVISOR', true, true, [false, false, true]],
  ['SUPERVISOR', true, false, [false, false, false]],
  ['SUPERVISOR', false, true, [true, true, true]],
  ['SUPERVISOR', false, false, [false, true, false]],
  ['OPERATOR', true, true, [false, false, false]],
  ['OPERATOR', true, false, [false, false, false]],
  ['OPERATOR', false, true, [false, true, false]],
  ['OPERATOR', false, false, [false, true, false]],
  ['VIEWER', true, true, [false, false, false]],
  ['VIEWER', true, false, [false, false, false]],
  ['VIEWER', false, true, [false, false, false]],
  ['VIEWER', false, false, [false, false, false]],
] as const;

describe('por permissão: matriz inicial (GB1)', () => {
  it.each(LOTE_A)(
    'matriz inicial, %s (com login %s, no alcance %s): igual ao do Lote A',
    (role, hasAccess, inReach, [status, edit, history]) => {
      const who = actor(role);

      expect(canChangePersonStatus(who, { hasAccess }, inReach)).toBe(status);
      expect(canEditContactAuthorization(who, { hasAccess })).toBe(edit);
      expect(canViewPersonHistory(who, inReach)).toBe(history);
    },
  );
});

describe('por permissão: matriz alterada', () => {
  it('OPERATOR com pessoas.inativar inativa pessoa sem login no alcance; nunca pessoa com login', () => {
    const operator = actor('OPERATOR', { grant: ['pessoas.inativar'] });

    expect(canChangePersonStatus(operator, noLogin, true)).toBe(true);
    expect(canChangePersonStatus(operator, noLogin, false)).toBe(false);
    expect(canChangePersonStatus(operator, withLogin, true)).toBe(false);
  });

  it('SUPERVISOR sem pessoas.inativar não inativa', () => {
    const supervisor = actor('SUPERVISOR', { revoke: ['pessoas.inativar'] });

    expect(canChangePersonStatus(supervisor, noLogin, true)).toBe(false);
  });

  it('OPERATOR com trilha.consultar vê histórico no alcance; SUPERVISOR sem a chave não vê', () => {
    const operator = actor('OPERATOR', { grant: ['trilha.consultar'] });
    const supervisor = actor('SUPERVISOR', { revoke: ['trilha.consultar'] });

    expect(canViewPersonHistory(operator, true)).toBe(true);
    expect(canViewPersonHistory(operator, false)).toBe(false);
    expect(canViewPersonHistory(supervisor, true)).toBe(false);
  });

  it('canEditContactAuthorization: sem pessoas.editar recusa pessoa sem login; pessoa com login só ADMIN', () => {
    const noEdit = actor('SUPERVISOR', { revoke: ['pessoas.editar'] });
    const everything = actor('OPERATOR', {
      grant: ['pessoas.editar', 'pessoas.inativar', 'trilha.consultar'],
    });

    expect(canEditContactAuthorization(noEdit, noLogin)).toBe(false);
    expect(canEditContactAuthorization(everything, withLogin)).toBe(false);
    expect(canEditContactAuthorization(actor('ADMIN'), withLogin)).toBe(true);
  });
});

describe('canChangePersonStatus', () => {
  it('ADMIN inativa qualquer pessoa, com login e fora do alcance', () => {
    expect(canChangePersonStatus(actor('ADMIN'), withLogin, false)).toBe(true);
  });

  it('SUPERVISOR inativa pessoa sem login dentro do alcance', () => {
    expect(canChangePersonStatus(actor('SUPERVISOR'), noLogin, true)).toBe(
      true,
    );
  });

  it.each([
    ['pessoa com login', withLogin, true],
    ['pessoa fora do alcance', noLogin, false],
  ])('SUPERVISOR não inativa %s', (_label, person, inReach) => {
    expect(canChangePersonStatus(actor('SUPERVISOR'), person, inReach)).toBe(
      false,
    );
  });

  it.each(['OPERATOR', 'VIEWER'] as const)('%s nunca inativa', (role) => {
    expect(canChangePersonStatus(actor(role), noLogin, true)).toBe(false);
  });
});

describe('canViewPersonHistory', () => {
  it('ADMIN sempre vê o histórico', () => {
    expect(canViewPersonHistory(actor('ADMIN'), false)).toBe(true);
  });

  it('SUPERVISOR vê só no alcance', () => {
    expect(canViewPersonHistory(actor('SUPERVISOR'), true)).toBe(true);
    expect(canViewPersonHistory(actor('SUPERVISOR'), false)).toBe(false);
  });

  it.each(['OPERATOR', 'VIEWER'] as const)('%s nunca vê', (role) => {
    expect(canViewPersonHistory(actor(role), true)).toBe(false);
  });
});

describe('canQueryAuditTrail', () => {
  it.each([
    ['ADMIN', true],
    ['SUPERVISOR', false],
    ['OPERATOR', false],
    ['VIEWER', false],
  ] as const)('%s: %s', (role, expected) => {
    expect(canQueryAuditTrail(actor(role))).toBe(expected);
  });
});

describe('personHistoryCategories', () => {
  it('ADMIN não restringe categoria; os demais veem Pessoa, Vínculo e Escala', () => {
    expect(personHistoryCategories(actor('ADMIN'))).toBeNull();
    expect(personHistoryCategories(actor('SUPERVISOR'))).toEqual([
      'PERSON',
      'ASSIGNMENT',
      'SCHEDULE',
    ]);
  });
});

describe('canEditContactAuthorization', () => {
  it('pessoa com login: só ADMIN', () => {
    expect(canEditContactAuthorization(actor('ADMIN'), withLogin)).toBe(true);
    expect(canEditContactAuthorization(actor('SUPERVISOR'), withLogin)).toBe(
      false,
    );
    expect(canEditContactAuthorization(actor('OPERATOR'), withLogin)).toBe(
      false,
    );
  });

  it.each([
    ['ADMIN', true],
    ['SUPERVISOR', true],
    ['OPERATOR', true],
    ['VIEWER', false],
  ] as const)('pessoa sem login, %s: %s', (role, expected) => {
    expect(canEditContactAuthorization(actor(role), noLogin)).toBe(expected);
  });
});

describe('canDeletePerson', () => {
  it.each([
    ['ADMIN', true],
    ['SUPERVISOR', false],
    ['OPERATOR', false],
    ['VIEWER', false],
  ] as const)('%s: %s', (role, expected) => {
    expect(canDeletePerson(actor(role))).toBe(expected);
  });
});
