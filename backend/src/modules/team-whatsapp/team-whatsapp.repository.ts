import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  TeamWhatsappRecipientStatus,
  TeamWhatsappSkipReason,
  TeamWhatsappTargetType,
  WorkShift,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TEAM_PROVIDERS, type TeamActor } from './team-whatsapp.policy';

/** Alvo/membro: o `sector` alimenta `canSendToUser`; o telefone fica só na memória do POST. */
export const teamMemberSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  sectorId: true,
  sector: { select: { isActive: true } },
  phoneE164: true,
  contact: { select: { phoneE164: true } },
  shift: true,
} satisfies Prisma.UserSelect;
export type TeamMember = Prisma.UserGetPayload<{
  select: typeof teamMemberSelect;
}>;

const dispatchListSelect = {
  id: true,
  createdAt: true,
  targetType: true,
  targetId: true,
  targetLabel: true,
  shift: true,
  author: { select: { id: true, name: true, email: true } },
  channel: { select: { id: true, name: true } },
} satisfies Prisma.TeamWhatsappDispatchSelect;
export type TeamDispatchRow = Prisma.TeamWhatsappDispatchGetPayload<{
  select: typeof dispatchListSelect;
}>;

/** Destinatário na lista de envios: nome e turno do snapshot, sem telefone. */
export type TeamRecipientRow = {
  dispatchId: string;
  // null quando o usuário foi apagado depois do envio (FK SetNull).
  userId: string | null;
  userName: string;
  shift: WorkShift | null;
  status: TeamWhatsappRecipientStatus;
  errorCode: string | null;
  skipReason: TeamWhatsappSkipReason | null;
};

/** `shift` = turno do destinatário no momento do POST (snapshot). */
export type NewTeamRecipient = {
  userId: string;
  userName: string;
  shift: WorkShift | null;
  status: TeamWhatsappRecipientStatus;
  skipReason: TeamWhatsappSkipReason | null;
};

export type NewTeamDispatch = {
  authorId: string;
  targetType: TeamWhatsappTargetType;
  targetId: string;
  targetLabel: string;
  // Filtro de turno do alvo setor; null = todos os turnos ou alvo pessoa.
  shift: WorkShift | null;
  channelId: string;
  text: string;
  recipients: NewTeamRecipient[];
};

export type TeamStatusCount = {
  dispatchId: string;
  status: TeamWhatsappRecipientStatus;
  count: number;
};

const RECENT_DISPATCHES = 20;

@Injectable()
export class TeamWhatsappRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActor(id: string): Promise<TeamActor | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        role: true,
        isActive: true,
        managedSectors: { where: { isActive: true }, select: { id: true } },
      },
    });
    if (!user) return null;
    const { managedSectors, ...rest } = user;
    return { ...rest, managedSectorIds: managedSectors.map((s) => s.id) };
  }

  async findTargetUser(id: string): Promise<TeamMember | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: teamMemberSelect,
    });
  }

  async findSectorWithActiveMembers(id: string) {
    return this.prisma.sector.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        isActive: true,
        members: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          select: teamMemberSelect,
        },
      },
    });
  }

  async findChannel(id: string) {
    return this.prisma.channel.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        provider: true,
        isActive: true,
        connectionEvents: {
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { state: true },
        },
      },
    });
  }

  async listEligibleChannels() {
    return this.prisma.channel.findMany({
      where: { isActive: true, provider: { in: [...TEAM_PROVIDERS] } },
      select: {
        id: true,
        name: true,
        phoneE164: true,
        provider: true,
        connectionEvents: {
          orderBy: { occurredAt: 'desc' },
          take: 1,
          select: { state: true },
        },
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /** `onlyIds = null` → todos os setores ativos (ADMIN). */
  async listSectors(onlyIds: readonly string[] | null) {
    return this.prisma.sector.findMany({
      where: {
        isActive: true,
        ...(onlyIds ? { id: { in: [...onlyIds] } } : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        code: true,
        members: {
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            email: true,
            phoneE164: true,
            isActive: true,
            shift: true,
          },
        },
      },
    });
  }

  async createDispatch(data: NewTeamDispatch) {
    const { recipients, ...dispatch } = data;
    return this.prisma.teamWhatsappDispatch.create({
      data: { ...dispatch, recipients: { create: recipients } },
      select: { id: true, recipients: { select: { id: true, status: true } } },
    });
  }

  /** Só mexe em quem ainda está QUEUED: não sobrescreve o que o processor já resolveu. */
  async markFailed(ids: readonly string[], errorCode: string): Promise<number> {
    const { count } = await this.prisma.teamWhatsappRecipient.updateMany({
      where: { id: { in: [...ids] }, status: 'QUEUED' },
      data: { status: 'FAILED', errorCode },
    });
    return count;
  }

  /** `authorId = null` → envios de todos (ADMIN); senão só os do autor. */
  async listDispatches(authorId: string | null): Promise<TeamDispatchRow[]> {
    return this.prisma.teamWhatsappDispatch.findMany({
      where: authorId === null ? {} : { authorId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_DISPATCHES,
      select: dispatchListSelect,
    });
  }

  async countByStatus(
    dispatchIds: readonly string[],
  ): Promise<TeamStatusCount[]> {
    if (dispatchIds.length === 0) return [];
    const rows = await this.prisma.teamWhatsappRecipient.groupBy({
      by: ['dispatchId', 'status'],
      where: { dispatchId: { in: [...dispatchIds] } },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      dispatchId: r.dispatchId,
      status: r.status,
      count: r._count._all,
    }));
  }

  /** Todos os destinatários dos envios já filtrados por `listDispatches`; sem telefone. */
  async listRecipients(
    dispatchIds: readonly string[],
  ): Promise<TeamRecipientRow[]> {
    if (dispatchIds.length === 0) return [];
    return this.prisma.teamWhatsappRecipient.findMany({
      where: { dispatchId: { in: [...dispatchIds] } },
      select: {
        dispatchId: true,
        userId: true,
        userName: true,
        shift: true,
        status: true,
        errorCode: true,
        skipReason: true,
      },
    });
  }
}

type Found<K extends keyof TeamWhatsappRepository> =
  TeamWhatsappRepository[K] extends (...args: never[]) => Promise<infer R>
    ? NonNullable<R>
    : never;
export type TeamSector = Found<'findSectorWithActiveMembers'>;
export type TeamChannel = Found<'findChannel'>;
export type TeamCreatedDispatch = Found<'createDispatch'>;
