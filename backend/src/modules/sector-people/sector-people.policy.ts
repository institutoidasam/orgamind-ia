import type { Role } from '@prisma/client';

/**
 * Política P1 da página do setor (pura). O serviço resolve existência (404 só
 * para ADMIN) e atividade da pessoa antes; aqui só a regra de quem pode o quê.
 */
export type PeopleActor = {
  id: string;
  role: Role;
  isActive: boolean;
  hasAccess: boolean;
};
export type PeopleSector = {
  id: string;
  isActive: boolean;
  managerId: string | null;
};
export type PeoplePerson = {
  id: string;
  sectorId: string | null;
  hasAccess: boolean;
  isActive: boolean;
};
export type PersonField = 'name' | 'phone' | 'levelId' | 'jobTitle' | 'shiftId';

/** Papéis de escrita: VIEWER nunca passa, mesmo que seja `managerId` do setor. */
const WRITE_ROLES: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];

/** Pessoa com acesso: nome e telefone ficam com o cadastro de Usuários (ADMIN). */
const LIMITED_FIELDS: readonly PersonField[] = [
  'levelId',
  'jobTitle',
  'shiftId',
];

function isValidActor(actor: PeopleActor): boolean {
  return actor.isActive && actor.hasAccess && WRITE_ROLES.includes(actor.role);
}

/** ADMIN ativo e com acesso: único que recebe 404 de setor inexistente e vê todos os telefones. */
export function isSectorAdmin(actor: PeopleActor): boolean {
  return isValidActor(actor) && actor.role === 'ADMIN';
}

/** ADMIN: qualquer setor existente. Gestor (`managerId`): só o seu, e ativo. */
export function canManageSector(
  actor: PeopleActor,
  sector: PeopleSector,
): boolean {
  if (!isValidActor(actor)) return false;
  if (actor.role === 'ADMIN') return true;
  return sector.isActive && sector.managerId === actor.id;
}

/** Pessoa deste setor; com acesso, só nível, função e turno (ADMIN e gestor). */
export function canEditPerson(
  sector: PeopleSector,
  person: PeoplePerson,
  fields: readonly PersonField[],
): boolean {
  if (person.sectorId !== sector.id) return false;
  return !person.hasAccess || fields.every((f) => LIMITED_FIELDS.includes(f));
}

/** ADMIN: quem não é deste setor. Gestor: só sem setor e sem acesso (D6). */
export function canPickExisting(
  actor: PeopleActor,
  sector: PeopleSector,
  person: PeoplePerson,
): boolean {
  if (!canManageSector(actor, sector) || person.sectorId === sector.id) {
    return false;
  }
  if (actor.role === 'ADMIN') return true;
  return person.sectorId === null && !person.hasAccess;
}

/** Só sai do setor quem é dele e não tem acesso. */
export function canRemove(sector: PeopleSector, person: PeoplePerson): boolean {
  return person.sectorId === sector.id && !person.hasAccess;
}
