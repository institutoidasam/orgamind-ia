import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  SectorContactCandidate,
  SectorPeopleCandidate,
  SectorPerson,
} from '../../schemas/contracts/sector-people.schema';
import { hasPermission } from '../../shared/authz/permissions';
import {
  nameSearchAllowed,
  nameView,
  phoneView,
} from '../../shared/authz/phone-visibility';
import { escapeLike } from '../../shared/prisma/escape-like';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { buildContactListWhere } from '../contacts/contacts.repository';
import { findEffectivePermissions } from '../permissions/permissions.query';
import {
  SECTOR_CHANNEL_SELECT,
  type SectorChannelRow,
} from '../team-whatsapp/sector-channel';
import { toContactAuthorization } from '../users/person-record';
import {
  isSectorAdmin,
  type PeopleActor,
  type PeoplePerson,
  type PeopleSector,
} from './sector-people.policy';

const CANDIDATES_LIMIT = 20;
const CONTACT_CANDIDATES_LIMIT = 30;

/** Linha que `toSectorPerson` mapeia; a T6 relê a pessoa gravada com este select. */
export const sectorPersonSelect = {
  id: true,
  name: true,
  email: true,
  phoneE164: true,
  hasAccess: true,
  role: true,
  jobTitle: true,
  level: { select: { id: true, name: true, isActive: true } },
  workShift: { select: { id: true, name: true } },
  // Ficha (C6): matrícula, situação e autorização de contato (sem a chave nem quem registrou).
  registration: true,
  isActive: true,
  contactAuthorization: true,
  authorizationSource: true,
  authorizationNote: true,
  authorizationDate: true,
  authorizationRecordedAt: true,
} satisfies Prisma.UserSelect;

export type SectorPersonRow = Prisma.UserGetPayload<{
  select: typeof sectorPersonSelect;
}>;

export type SectorDetail = PeopleSector & {
  name: string;
  code: string;
  manager: { id: string; name: string | null } | null;
  channel: SectorChannelRow | null;
};

/** Contato do lote "Dos contatos"; `personId` = usuário já ligado a ele. */
export type BatchContact = {
  id: string;
  name: string | null;
  phoneE164: string;
  personId: string | null;
};

/**
 * Quem lê a página do setor: `isAdmin` (regra GC8 do setor) e `fullPhone` (chave
 * `telefone.ver_completo`, DB8). Sem `fullPhone` só a máscara sai e a busca ignora o telefone.
 */
export type PeopleViewer = { isAdmin: boolean; fullPhone: boolean };

export function peopleViewer(actor: PeopleActor): PeopleViewer {
  return {
    isAdmin: isSectorAdmin(actor),
    fullPhone: hasPermission(actor, 'telefone.ver_completo'),
  };
}

/** Pessoa lida para decidir; `hasPhone` evita levar o número (nem a máscara) à regra. */
export type PersonWithPhone = PeoplePerson & {
  name: string | null;
  hasPhone: boolean;
};

export type CandidatesArgs = {
  sectorId: string;
  q: string;
  /** Busca também por telefone: só com a chave `telefone.ver_completo` (DB8). */
  searchPhone: boolean;
  /** Gestor (D6): só `sectorId` NULL e `hasAccess` false. */
  onlyUnassignedWithoutAccess: boolean;
};

/** Nome exibido (D2); pessoa sem acesso sempre tem nome. */
function displayName(user: { name: string | null; email: string | null }) {
  return user.name ?? user.email ?? '';
}

/** Chave de ordem: o nome EXIBIDO a quem lê e o id da linha. */
export type NameSortKey = { name: string | null; id: string };

/** pt-BR, nulo por último (como o `nulls: 'last'` dos contatos). */
function compareNames(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, 'pt-BR');
}

/** Pelo nome; no empate, pelo id (fixo, sem depender do que o leitor não vê). */
function compareNameKeys(a: NameSortKey, b: NameSortKey): number {
  const byName = compareNames(a.name, b.name);
  if (byName !== 0 || a.id === b.id) return byName;
  return a.id < b.id ? -1 : 1;
}

/**
 * Ordem pt-BR feita aqui: a collation do banco não ordena acentos como o pt-BR.
 * I2: `keyOf` dá o nome EXIBIDO a quem lê, e o empate é pelo id. Ordenar pelo
 * nome real (ou desempatar pelo telefone) deixaria quem não vê o telefone achar
 * o número de um nome-telefone (D11) pela posição dele na lista.
 */
export function sortByName<T>(
  items: T[],
  keyOf: (item: T) => NameSortKey,
): T[] {
  return items.sort((a, b) => compareNameKeys(keyOf(a), keyOf(b)));
}

/**
 * Nome, matrícula (A1: casa pela chave em minúsculas) e, só com a chave, telefone:
 * quem não a tem não descobre o número por tentativa (DB8). Sem a chave, termo
 * sem letra também não busca por nome: casaria o nome-telefone da D11.
 */
function personSearchWhere(
  q: string,
  searchPhone: boolean,
): Prisma.UserWhereInput {
  if (!q) return {};
  const text = escapeLike(q);
  const byName: Prisma.UserWhereInput = {
    name: { contains: text, mode: 'insensitive' },
  };
  return {
    OR: [
      ...(nameSearchAllowed(q, { full: searchPhone }) ? [byName] : []),
      ...(searchPhone ? [{ phoneE164: { contains: text } }] : []),
      { registrationKey: { contains: text.toLowerCase() } },
    ],
  };
}

/**
 * Sem a chave a busca de contatos usa só o nome, e termo sem letra não casa nada
 * (`null`: só acharia nome-telefone, D11); com ela, o mesmo filtro de `GET /contacts`.
 */
function contactSearchWhere(
  q: string,
  fullPhone: boolean,
): Prisma.ContactWhereInput | null {
  if (fullPhone) {
    return buildContactListWhere({
      page: 1,
      pageSize: CONTACT_CANDIDATES_LIMIT,
      search: q,
    });
  }
  if (!q) return {};
  if (!nameSearchAllowed(q, { full: false })) return null;
  return { name: { contains: escapeLike(q), mode: 'insensitive' } };
}

function candidatesScope(args: CandidatesArgs): Prisma.UserWhereInput {
  if (args.onlyUnassignedWithoutAccess) {
    return { sectorId: null, hasAccess: false };
  }
  // `not` sozinho vira `<>` e descarta NULL: quem não tem setor também conta.
  return { OR: [{ sectorId: null }, { sectorId: { not: args.sectorId } }] };
}

/** GC8: o telefone de pessoa com login fica oculto para quem não é ADMIN. */
function phoneHidden(viewer: PeopleViewer, hasAccess: boolean): boolean {
  return !viewer.isAdmin && hasAccess;
}

/**
 * D11: nome que é telefone segue a regra do telefone desta pessoa — completo só
 * com a chave e sem a ocultação da GC8. Só a resposta muda; o banco guarda o real.
 */
export function personNameView(
  name: string,
  hasAccess: boolean,
  viewer: PeopleViewer,
): string {
  const full = viewer.fullPhone && !phoneHidden(viewer, hasAccess);
  return nameView(name, { full });
}

/** O `name` que `toSectorPerson` devolve; a lista do setor ordena por ele (I2). */
function shownPersonName(row: SectorPersonRow, viewer: PeopleViewer): string {
  return personNameView(displayName(row), row.hasAccess, viewer);
}

/**
 * GC8: o gestor não recebe o telefone de quem tem acesso (só o ADMIN o edita);
 * DB8: o número completo só vai a quem tem a chave, os demais recebem a máscara.
 * `role` só faz sentido com acesso (o VIEWER da D1 não é exibido).
 */
export function toSectorPerson(
  row: SectorPersonRow,
  viewer: PeopleViewer,
): SectorPerson {
  return {
    id: row.id,
    name: shownPersonName(row, viewer),
    ...phoneView(row.phoneE164, {
      full: viewer.fullPhone,
      hidden: phoneHidden(viewer, row.hasAccess),
    }),
    hasAccess: row.hasAccess,
    role: row.hasAccess ? row.role : null,
    level: row.level,
    jobTitle: row.jobTitle,
    shift: row.workShift,
    editable: row.hasAccess ? 'limited' : 'full',
    registration: row.registration,
    isActive: row.isActive,
    contactAuthorization: toContactAuthorization(row),
  };
}

/** O contato sempre tem número: a máscara sai sempre e o completo só com a chave. */
function contactPhone(
  phoneE164: string,
  viewer: Pick<PeopleViewer, 'fullPhone'>,
): { phoneE164: string | null; phoneMasked: string } {
  const view = phoneView(phoneE164, { full: viewer.fullPhone });
  return { phoneE164: view.phoneE164, phoneMasked: view.phoneMasked ?? '' };
}

const contactCandidateSelect = {
  id: true,
  name: true,
  phoneE164: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      hasAccess: true,
      sector: { select: { name: true } },
    },
  },
} satisfies Prisma.ContactSelect;

type ContactCandidateRow = Prisma.ContactGetPayload<{
  select: typeof contactCandidateSelect;
}>;

/** Nome do contato e da pessoa ligada passam por `nameView` (D11), como o telefone. */
function toContactCandidate(
  { id, name, phoneE164, user }: ContactCandidateRow,
  viewer: PeopleViewer,
): SectorContactCandidate {
  return {
    contactId: id,
    name: nameView(name, { full: viewer.fullPhone }),
    ...contactPhone(phoneE164, viewer),
    person: user
      ? {
          userId: user.id,
          name: personNameView(displayName(user), user.hasAccess, viewer),
          sectorName: user.sector?.name ?? null,
        }
      : null,
  };
}

@Injectable()
export class SectorPeopleRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Ator com o papel e as permissões efetivas lidos do banco a cada chamada (GB3). */
  async findActor(id: string): Promise<PeopleActor | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true, hasAccess: true },
    });
    if (!user) return null;
    const permissions = await findEffectivePermissions(this.prisma, user.role);
    return { ...user, permissions };
  }

  findSector(id: string): Promise<SectorDetail | null> {
    return this.prisma.sector.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        code: true,
        isActive: true,
        managerId: true,
        manager: { select: { id: true, name: true } },
        channel: { select: SECTOR_CHANNEL_SELECT },
      },
    });
  }

  async findPerson(id: string): Promise<PersonWithPhone | null> {
    const row = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        sectorId: true,
        hasAccess: true,
        isActive: true,
        phoneE164: true,
      },
    });
    if (!row) return null;
    const { phoneE164, ...person } = row;
    return { ...person, hasPhone: Boolean(phoneE164) };
  }

  /** Pessoas do `move`, ativas ou não (o serviço devolve 404 às inativas). */
  findPeople(ids: readonly string[]): Promise<PeoplePerson[]> {
    return this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, sectorId: true, hasAccess: true, isActive: true },
    });
  }

  /** Relê o que foi gravado com o select do mapper (ordem livre). */
  findPersonRows(ids: readonly string[]): Promise<SectorPersonRow[]> {
    return this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: sectorPersonSelect,
    });
  }

  /** Nível e turno do pedido (Q3), conferidos antes de criar qualquer pessoa. */
  async findLevelAndShift(
    levelId: string | null,
    shiftId: string,
  ): Promise<{
    level: { isActive: boolean } | null;
    shift: { isActive: boolean } | null;
  }> {
    const active = { select: { isActive: true } } as const;
    const [level, shift] = await Promise.all([
      levelId
        ? this.prisma.staffLevel.findUnique({
            where: { id: levelId },
            ...active,
          })
        : null,
      this.prisma.shift.findUnique({ where: { id: shiftId }, ...active }),
    ]);
    return { level, shift };
  }

  async findContactsForBatch(ids: readonly string[]): Promise<BatchContact[]> {
    const rows = await this.prisma.contact.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        name: true,
        phoneE164: true,
        user: { select: { id: true } },
      },
    });
    return rows.map(({ user, ...row }) => ({
      ...row,
      personId: user?.id ?? null,
    }));
  }

  /** Depois de um `phone_taken`: o contato já ficou com outra pessoa (corrida, D10)? */
  async isContactLinked(contactId: string): Promise<boolean> {
    const count = await this.prisma.user.count({ where: { contactId } });
    return count > 0;
  }

  /**
   * Com `sectorId` = este, pelo nome exibido a `viewer` asc pt-BR e empate pelo id
   * (I2); os inativos só entram com `includeInactive` (A3).
   */
  async listPeople(
    sectorId: string,
    includeInactive: boolean,
    viewer: PeopleViewer,
  ): Promise<SectorPersonRow[]> {
    const rows = await this.prisma.user.findMany({
      where: { sectorId, ...(includeInactive ? {} : { isActive: true }) },
      select: sectorPersonSelect,
    });
    return sortByName(rows, (row) => ({
      name: shownPersonName(row, viewer),
      id: row.id,
    }));
  }

  async listCandidates(args: CandidatesArgs): Promise<SectorPeopleCandidate[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        AND: [
          candidatesScope(args),
          personSearchWhere(args.q, args.searchPhone),
        ],
      },
      orderBy: { name: 'asc' },
      take: CANDIDATES_LIMIT,
      select: {
        id: true,
        name: true,
        email: true,
        hasAccess: true,
        registration: true,
        sector: { select: { id: true, name: true } },
      },
    });
    const items = rows.map(({ email, ...row }) => ({
      ...row,
      name: displayName({ name: row.name, email }),
    }));
    // Nome real aqui: o serviço mascara (D11) e reordena pelo nome exibido (I2).
    return sortByName(items, ({ name, id }) => ({ name, id }));
  }

  /** Mesmo `where` de `GET /contacts` (D8) com a busca; `person` pela relação `UserContact`. */
  async listContactCandidates(
    q: string,
    viewer: PeopleViewer,
  ): Promise<SectorContactCandidate[]> {
    const where = contactSearchWhere(q, viewer.fullPhone);
    if (!where) return [];
    const rows = await this.prisma.contact.findMany({
      where,
      // Sem a chave o desempate é o id: ordenar pelo número também o revelaria.
      orderBy: [
        { name: { sort: 'asc', nulls: 'last' } },
        viewer.fullPhone ? { phoneE164: 'asc' } : { id: 'asc' },
      ],
      take: CONTACT_CANDIDATES_LIMIT,
      select: contactCandidateSelect,
    });
    const items = rows.map((row) => toContactCandidate(row, viewer));
    // I2: sem a chave o nome do contato pode ser um número (D11, WhatsApp) e sai
    // mascarado; a página volta na ordem do nome exibido. Com a chave, a do banco.
    if (viewer.fullPhone) return items;
    return sortByName(items, (item) => ({
      name: item.name,
      id: item.contactId,
    }));
  }
}
