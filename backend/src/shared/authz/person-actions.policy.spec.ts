import { describe, it, expect } from 'vitest';
import type { Role } from '@prisma/client';
import {
  canChangePersonStatus,
  canDeletePerson,
  canEditContactAuthorization,
  canQueryAuditTrail,
  canViewPersonHistory,
  personHistoryCategories,
  type PolicyActor,
} from './person-actions.policy';

const actor = (role: Role): PolicyActor => ({ id: `u-${role}`, role });
const withLogin = { hasAccess: true };
const noLogin = { hasAccess: false };

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
