import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  SectorContactCandidate,
  SectorPeopleCandidate,
  SectorPerson,
} from '../../schemas/contracts/sector-people.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { buildContactListWhere } from '../contacts/contacts.repository';
import type {
  PeopleActor,
  PeoplePerson,
  PeopleSector,
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
} satisfies Prisma.UserSelect;

export type SectorPersonRow = Prisma.UserGetPayload<{
  select: typeof sectorPersonSelect;
}>;

export type SectorDetail = PeopleSector & {
  name: string;
  code: string;
  manager: { id: string; name: string | null } | null;
};

/** Contato do lote "Dos contatos"; `personId` = usuário já ligado a ele. */
export type BatchContact = {
  id: string;
  name: string | null;
  phoneE164: string;
  personId: string | null;
};

export type CandidatesArgs = {
  sectorId: string;
  q: string;
  /** Gestor (D6): só `sectorId` NULL e `hasAccess` false. */
  onlyUnassignedWithoutAccess: boolean;
};

/** Nome exibido (D2); pessoa sem acesso sempre tem nome. */
function displayName(user: { name: string | null; email: string | null }) {
  return user.name ?? user.email ?? '';
}

/** Ordem pt-BR feita aqui: a collation do banco não ordena acentos como o pt-BR. */
function sortByName<T>(items: T[], nameOf: (item: T) => string): T[] {
  return items.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'pt-BR'));
}

function nameOrPhoneWhere(q: string): Prisma.UserWhereInput {
  if (!q) return {};
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { phoneE164: { contains: q } },
    ],
  };
}

function candidatesScope(args: CandidatesArgs): Prisma.UserWhereInput {
  if (args.onlyUnassignedWithoutAccess) {
    return { sectorId: null, hasAccess: false };
  }
  // `not` sozinho vira `<>` e descarta NULL: quem não tem setor também conta.
  return { OR: [{ sectorId: null }, { sectorId: { not: args.sectorId } }] };
}

/**
 * GC8: o gestor não recebe o telefone de quem tem acesso (só o ADMIN o edita).
 * `role` só faz sentido com acesso (o VIEWER da D1 não é exibido).
 */
export function toSectorPerson(
  row: SectorPersonRow,
  viewer: { isAdmin: boolean },
): SectorPerson {
  const showPhone = viewer.isAdmin || !row.hasAccess;
  return {
    id: row.id,
    name: displayName(row),
    phoneE164: showPhone ? row.phoneE164 : null,
    hasAccess: row.hasAccess,
    role: row.hasAccess ? row.role : null,
    level: row.level,
    jobTitle: row.jobTitle,
    shift: row.workShift,
    editable: row.hasAccess ? 'limited' : 'full',
  };
}

@Injectable()
export class SectorPeopleRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActor(id: string): Promise<PeopleActor | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true, hasAccess: true },
    });
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
      },
    });
  }

  findPerson(
    id: string,
  ): Promise<(PeoplePerson & { name: string | null }) | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        sectorId: true,
        hasAccess: true,
        isActive: true,
      },
    });
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

  /** Ativos com `sectorId` = este, nome asc pt-BR. */
  async listPeople(sectorId: string): Promise<SectorPersonRow[]> {
    const rows = await this.prisma.user.findMany({
      where: { sectorId, isActive: true },
      select: sectorPersonSelect,
    });
    return sortByName<SectorPersonRow>(rows, displayName);
  }

  async listCandidates(args: CandidatesArgs): Promise<SectorPeopleCandidate[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        AND: [candidatesScope(args), nameOrPhoneWhere(args.q)],
      },
      orderBy: { name: 'asc' },
      take: CANDIDATES_LIMIT,
      select: {
        id: true,
        name: true,
        email: true,
        hasAccess: true,
        sector: { select: { id: true, name: true } },
      },
    });
    const items = rows.map(({ email, ...row }) => ({
      ...row,
      name: displayName({ name: row.name, email }),
    }));
    return sortByName(items, (item) => item.name);
  }

  /** Mesmo `where` de `GET /contacts` (D8) com a busca; `person` pela relação `UserContact`. */
  async listContactCandidates(q: string): Promise<SectorContactCandidate[]> {
    const rows = await this.prisma.contact.findMany({
      where: buildContactListWhere({
        page: 1,
        pageSize: CONTACT_CANDIDATES_LIMIT,
        search: q,
      }),
      orderBy: [{ name: { sort: 'asc', nulls: 'last' } }, { phoneE164: 'asc' }],
      take: CONTACT_CANDIDATES_LIMIT,
      select: {
        id: true,
        name: true,
        phoneE164: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            sector: { select: { name: true } },
          },
        },
      },
    });
    return rows.map(({ id, name, phoneE164, user }) => ({
      contactId: id,
      name,
      phoneE164,
      person: user
        ? {
            userId: user.id,
            name: displayName(user),
            sectorName: user.sector?.name ?? null,
          }
        : null,
    }));
  }
}
