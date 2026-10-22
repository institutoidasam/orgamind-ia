import { describe, expect, it } from 'vitest';
import {
  canEditPerson,
  canManageSector,
  canPickExisting,
  canRemove,
  type PeopleActor,
  type PeoplePerson,
  type PeopleSector,
  type PersonField,
} from './sector-people.policy';

const ADMIN: PeopleActor = {
  id: 'user_admin',
  role: 'ADMIN',
  isActive: true,
  hasAccess: true,
};
const MANAGER: PeopleActor = {
  id: 'user_manager',
  role: 'SUPERVISOR',
  isActive: true,
  hasAccess: true,
};

const OPERATION: PeopleSector = {
  id: 'sector_operation',
  isActive: true,
  managerId: MANAGER.id,
};
const IT: PeopleSector = {
  id: 'sector_it',
  isActive: true,
  managerId: 'user_other_manager',
};

function person(over: Partial<PeoplePerson> = {}): PeoplePerson {
  return {
    id: 'user_person',
    sectorId: OPERATION.id,
    hasAccess: false,
    isActive: true,
    ...over,
  };
}

describe('canManageSector', () => {
  it.each<[string, PeopleActor, PeopleSector, boolean]>([
    ['ADMIN em setor inativo', ADMIN, { ...IT, isActive: false }, true],
    ['gestor de Operação em Operação', MANAGER, OPERATION, true],
    ['gestor de Operação em TI', MANAGER, IT, false],
    [
      'gestor em setor inativo',
      MANAGER,
      { ...OPERATION, isActive: false },
      false,
    ],
    ['gestor sem acesso', { ...MANAGER, hasAccess: false }, OPERATION, false],
    ['gestor inativo', { ...MANAGER, isActive: false }, OPERATION, false],
    ['VIEWER', { ...MANAGER, role: 'VIEWER' }, OPERATION, false],
  ])('%s → %s', (_label, actor, sector, expected) => {
    expect(canManageSector(actor, sector)).toBe(expected);
  });
});

describe('canEditPerson', () => {
  it.each<[string, PeoplePerson, PersonField[], boolean]>([
    [
      'sem acesso deste setor, nome e telefone',
      person(),
      ['name', 'phone'],
      true,
    ],
    [
      'com acesso, nível, função e turno',
      person({ hasAccess: true }),
      ['levelId', 'jobTitle', 'shiftId'],
      true,
    ],
    ['com acesso, nome', person({ hasAccess: true }), ['name'], false],
    [
      'pessoa de TI no setor Operação',
      person({ sectorId: IT.id }),
      ['levelId'],
      false,
    ],
  ])('%s → %s', (_label, target, fields, expected) => {
    expect(canEditPerson(OPERATION, target, fields)).toBe(expected);
  });
});

describe('canPickExisting / canRemove', () => {
  it.each<[string, PeopleActor, PeoplePerson, boolean]>([
    ['gestor × pessoa de TI', MANAGER, person({ sectorId: IT.id }), false],
    [
      'gestor × sem setor e sem acesso',
      MANAGER,
      person({ sectorId: null }),
      true,
    ],
    [
      'gestor × sem setor com acesso',
      MANAGER,
      person({ sectorId: null, hasAccess: true }),
      false,
    ],
    [
      'ADMIN × pessoa de TI',
      ADMIN,
      person({ sectorId: IT.id, hasAccess: true }),
      true,
    ],
    ['ADMIN × pessoa já deste setor', ADMIN, person(), false],
  ])('canPickExisting: %s → %s', (_label, actor, target, expected) => {
    expect(canPickExisting(actor, OPERATION, target)).toBe(expected);
  });

  it.each<[string, PeoplePerson, boolean]>([
    ['sem acesso deste setor', person(), true],
    ['com acesso', person({ hasAccess: true }), false],
    ['sem acesso de TI', person({ sectorId: IT.id }), false],
  ])('canRemove: %s → %s', (_label, target, expected) => {
    expect(canRemove(OPERATION, target)).toBe(expected);
  });
});
