import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type TeamWhatsappDispatchState,
  type TeamWhatsappRecipientStatus,
  type TeamWhatsappSkipReason,
  type TeamWhatsappTargetType,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import { rosterSnapshotSchema } from '../../schemas/contracts/team-whatsapp.schema';
import { toDbDate, type CivilDate } from '../staff-schedule/civil-date';
import type {
  ScheduleCycle,
  ScheduleExceptionInput,
} from '../staff-schedule/schedule-resolver';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import type { RosterSnapshot } from './team-whatsapp.roster';
import { findTeamActor } from './team-actor.query';
import {
  TEAM_PROVIDERS,
  isTeamProvider,
  type TeamActor,
} from './team-whatsapp.policy';

/**
 * Alvo/membro: o `sector` alimenta `canSendToUser`; o telefone fica só na memória do POST.
 * `workShift.name` vira o `shiftName` gravado no destinatário (turno do cadastro).
 */
export const teamMemberSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  sectorId: true,
  sector: { select: { isActive: true } },
  phoneE164: true,
  contact: { select: { phoneE164: true } },
  shiftId: true,
  workShift: { select: { name: true } },
} satisfies Prisma.UserSelect;
export type TeamMember = Prisma.UserGetPayload<{
  select: typeof teamMemberSelect;
}>;

/** Membro do envio por data: o do alvo mais a função (`jobTitle`) da foto e o nível (C4). */
const teamMemberRowSelect = {
  ...teamMemberSelect,
  jobTitle: true,
  levelId: true,
  level: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;
export type TeamMemberRow = Prisma.UserGetPayload<{
  select: typeof teamMemberRowSelect;
}>;
/** Membro com a escala que cruza a data (ciclo e exceções), pronto para `resolveDay`. */
export type TeamMemberWithSchedule = TeamMemberRow & {
  cycle: ScheduleCycle | null;
  exceptions: readonly ScheduleExceptionInput[];
};

const shiftRefSelect = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
} satisfies Prisma.ShiftSelect;

const dispatchListSelect = {
  id: true,
  createdAt: true,
  targetType: true,
  targetId: true,
  targetLabel: true,
  shiftId: true,
  shiftName: true,
  shiftStartTime: true,
  shiftEndTime: true,
  rosterDate: true,
  includeOff: true,
  roster: true,
  state: true,
  scheduledFor: true,
  firedAt: true,
  author: { select: { id: true, name: true, email: true } },
  channel: { select: { id: true, name: true } },
  sectors: { select: { sectorId: true, sectorName: true } },
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
  shiftName: string | null;
  status: TeamWhatsappRecipientStatus;
  errorCode: string | null;
  skipReason: TeamWhatsappSkipReason | null;
  // Snapshot (C6): setor em que entrou e nível na hora; null = alvo pessoa ou
  // envio anterior (o backfill preenche só o setor).
  sectorName: string | null;
  levelName: string | null;
};

/**
 * `shiftId`/`shiftName` = snapshot no POST: no alvo setor, o turno da pessoa no
 * dia (null para quem entrou por `includeOff`); no alvo pessoa, o do cadastro.
 */
export type NewTeamRecipient = {
  userId: string;
  userName: string;
  shiftId: string | null;
  shiftName: string | null;
  status: TeamWhatsappRecipientStatus;
  skipReason: TeamWhatsappSkipReason | null;
};

/** Setor do envio (C6): uma linha por setor no alvo setor; nenhuma no alvo pessoa. */
export type DispatchSector = { sectorId: string; sectorName: string };

/**
 * Snapshot de setor/nível do destinatário (C6): o setor em que a pessoa entrou
 * e o nome do nível na hora (gravado a partir da T8b); tudo null no alvo pessoa.
 */
export type RecipientSnapshot = {
  sectorId: string | null;
  sectorName: string | null;
  levelName: string | null;
};
export type NewTeamDispatchRecipient = NewTeamRecipient & RecipientSnapshot;

export type NewTeamDispatch = {
  authorId: string;
  targetType: TeamWhatsappTargetType;
  targetId: string;
  targetLabel: string;
  // Snapshot do filtro de turno do alvo setor; null = todos os turnos ou alvo pessoa.
  // A coluna enum legada `shift` não é mais gravada (fica null; sai na T2b).
  shiftId: string | null;
  shiftName: string | null;
  shiftStartTime: string | null;
  shiftEndTime: string | null;
  channelId: string;
  text: string;
  // `targetId` = primeiro setor; aqui vão todos os setores do envio.
  sectors: DispatchSector[];
  recipients: NewTeamDispatchRecipient[];
  // Foto da escala (C10; gravada no POST pela T7b). Ausente = null / false / null.
  rosterDate?: CivilDate | null;
  includeOff?: boolean;
  roster?: RosterSnapshot | null;
  // Agendado (T8): state SCHEDULED + início do turno; destinatários SCHEDULED ou
  // SKIPPED. Ausente = envio imediato (DISPATCHED, sem scheduledFor).
  state?: TeamWhatsappDispatchState;
  scheduledFor?: Date | null;
};

/** Agendado para a lista "Agendados" (C9): snapshot do turno, sem texto nem telefone. */
const scheduledSelect = {
  id: true,
  scheduledFor: true,
  rosterDate: true,
  targetLabel: true,
  shiftId: true,
  shiftName: true,
  shiftStartTime: true,
  shiftEndTime: true,
  author: { select: { id: true, name: true, email: true } },
  channel: { select: { id: true, name: true } },
  _count: { select: { recipients: { where: { status: 'SCHEDULED' } } } },
} satisfies Prisma.TeamWhatsappDispatchSelect;
type ScheduledPayload = Prisma.TeamWhatsappDispatchGetPayload<{
  select: typeof scheduledSelect;
}>;
/** `recipientCount` = destinatários ainda SCHEDULED (os SKIPPED não contam). */
export type ScheduledRow = Omit<ScheduledPayload, '_count'> & {
  recipientCount: number;
};

export type TeamDispatchForCancel = {
  id: string;
  targetType: TeamWhatsappTargetType;
  targetId: string;
  state: TeamWhatsappDispatchState;
  // Todos os setores do envio (C7); [] no alvo pessoa.
  sectorIds: string[];
};

/**
 * Resultado do claim do disparo agendado (T9): ids que viraram QUEUED (vão para
 * a fila) e quantos viraram SKIPPED/INACTIVE ou FAILED/channel_unavailable agora.
 */
export type ClaimResult = {
  queuedIds: string[];
  skipped: number;
  failed: number;
};

/** Canal inexistente, inativo ou de provedor não-equipe na hora do disparo (C10). */
export const CHANNEL_UNAVAILABLE = 'team_whatsapp.channel_unavailable';

type Tx = Prisma.TransactionClient;

export type TeamStatusCount = {
  dispatchId: string;
  status: TeamWhatsappRecipientStatus;
  count: number;
};

const RECENT_DISPATCHES = 20;

@Injectable()
export class TeamWhatsappRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: StaffScheduleRepository,
  ) {}

  async findActor(id: string): Promise<TeamActor | null> {
    return findTeamActor(this.prisma, id);
  }

  async findTargetUser(id: string): Promise<TeamMember | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: teamMemberSelect,
    });
  }

  /** Setor do alvo (a política checa `isActive`); os membros vêm de `loadDayPeople`. */
  async findSector(id: string) {
    return this.prisma.sector.findUnique({
      where: { id },
      select: { id: true, name: true, isActive: true },
    });
  }

  /** Turnos ativos por sortOrder (C6); o filtro do envio é validado contra eles. */
  async listActiveShifts(): Promise<ShiftRef[]> {
    return this.prisma.shift.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: shiftRefSelect,
    });
  }

  /** Ativos do setor principal mais os visitantes pedidos (ativos), por nome. */
  async findMembersForDay(
    sectorId: string,
    visitorIds: readonly string[],
  ): Promise<TeamMemberRow[]> {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [{ sectorId }, { id: { in: [...visitorIds] } }],
      },
      orderBy: { name: 'asc' },
      select: teamMemberRowSelect,
    });
  }

  /**
   * Quem pode estar na escala do setor na data: os ativos do setor e os de fora
   * com OTHER_SECTOR para ele nessa data, cada um com o ciclo e as exceções que
   * cruzam a data (StaffScheduleRepository, T5). Quem entra decide `dayMembers`.
   */
  async loadDayPeople(
    sectorId: string,
    date: CivilDate,
  ): Promise<TeamMemberWithSchedule[]> {
    const visitorIds = await this.schedule.listVisitorIds(sectorId, date, date);
    const rows = await this.findMembersForDay(sectorId, visitorIds);
    const data = await this.schedule.loadScheduleData(
      rows.map((r) => r.id),
      date,
      date,
    );
    return rows.map((row) => ({
      ...row,
      cycle: data.get(row.id)?.cycle ?? null,
      exceptions: data.get(row.id)?.exceptions ?? [],
    }));
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

  /** `onlyIds = null` → todos os setores ativos (ADMIN). Sem membros (C6). */
  async listSectors(
    onlyIds: readonly string[] | null,
  ): Promise<{ id: string; name: string; code: string }[]> {
    return this.prisma.sector.findMany({
      where: {
        isActive: true,
        ...(onlyIds ? { id: { in: [...onlyIds] } } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    });
  }

  async createDispatch(data: NewTeamDispatch) {
    const { recipients, sectors, rosterDate, includeOff, roster, ...dispatch } =
      data;
    return this.prisma.teamWhatsappDispatch.create({
      data: {
        ...dispatch,
        sectors: { create: sectors },
        rosterDate: rosterDate ? toDbDate(rosterDate) : null,
        includeOff: includeOff ?? false,
        // parse descarta chaves fora do contrato (ex.: telefone) antes de gravar (GC10).
        roster: roster ? rosterSnapshotSchema.parse(roster) : Prisma.DbNull,
        recipients: { create: recipients },
      },
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

  async findDispatchForCancel(
    id: string,
  ): Promise<TeamDispatchForCancel | null> {
    const row = await this.prisma.teamWhatsappDispatch.findUnique({
      where: { id },
      select: {
        id: true,
        targetType: true,
        targetId: true,
        state: true,
        sectors: { select: { sectorId: true } },
      },
    });
    if (!row) return null;
    const { sectors, ...dispatch } = row;
    return { ...dispatch, sectorIds: sectors.map((s) => s.sectorId) };
  }

  /**
   * Cancela só se ainda SCHEDULED: o `updateMany` condicional disputa com o
   * disparo (T9), que faz o mesmo em `state = SCHEDULED`; quem chega depois vê
   * count 0 (false → 409) e não mexe nos destinatários.
   */
  async cancelScheduled(
    id: string,
    actorId: string,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.teamWhatsappDispatch.updateMany({
        where: { id, state: 'SCHEDULED' },
        data: { state: 'CANCELLED', cancelledAt: now, cancelledById: actorId },
      });
      if (count === 0) return false;
      await tx.teamWhatsappRecipient.updateMany({
        where: { dispatchId: id, status: 'SCHEDULED' },
        data: { status: 'CANCELLED' },
      });
      return true;
    });
  }

  /** Agendados vencidos (SCHEDULED, `scheduledFor <= now`), os mais antigos primeiro. */
  async findDueScheduled(now: Date, take: number): Promise<{ id: string }[]> {
    return this.prisma.teamWhatsappDispatch.findMany({
      where: { state: 'SCHEDULED', scheduledFor: { lte: now } },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take,
      select: { id: true },
    });
  }

  /**
   * Disparo único do agendado: o `updateMany` condicional em `state = SCHEDULED`
   * disputa com outro disparo e com `cancelScheduled` (a linha fica travada até o
   * commit; quem chega depois vê count 0 → null e não mexe em nada). Na mesma
   * transação resolve os destinatários SCHEDULED: canal indisponível → FAILED;
   * senão usuário inativo/apagado → SKIPPED INACTIVE (D8) e o resto → QUEUED.
   * A lista congelada vale mesmo com o setor desativado depois (spec §6).
   */
  async claimScheduled(id: string, now: Date): Promise<ClaimResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.teamWhatsappDispatch.updateMany({
        where: { id, state: 'SCHEDULED', scheduledFor: { lte: now } },
        data: { state: 'DISPATCHED', firedAt: now },
      });
      if (count === 0) return null;
      const { channel } = await tx.teamWhatsappDispatch.findUniqueOrThrow({
        where: { id },
        select: { channel: { select: { isActive: true, provider: true } } },
      });
      if (!channel?.isActive || !isTeamProvider(channel.provider)) {
        return { queuedIds: [], skipped: 0, failed: await failAll(tx, id) };
      }
      return { ...(await queueActive(tx, id)), failed: 0 };
    });
  }

  /**
   * Só `state = SCHEDULED`, por `scheduledFor` asc; `onlySectorIds = null` →
   * todos (ADMIN). Gestor (C7/D5): só alvo setor com ≥1 setor e TODOS os setores
   * do envio entre os dele (`every` sozinho aceitaria envio sem setor).
   */
  async listScheduled(
    onlySectorIds: readonly string[] | null,
  ): Promise<ScheduledRow[]> {
    const rows = await this.prisma.teamWhatsappDispatch.findMany({
      where: {
        state: 'SCHEDULED',
        ...(onlySectorIds
          ? {
              targetType: 'SECTOR',
              sectors: {
                some: {},
                every: { sectorId: { in: [...onlySectorIds] } },
              },
            }
          : {}),
      },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
      select: scheduledSelect,
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      recipientCount: _count.recipients,
    }));
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
        shiftName: true,
        status: true,
        errorCode: true,
        skipReason: true,
        sectorName: true,
        levelName: true,
      },
    });
  }
}

async function failAll(tx: Tx, dispatchId: string): Promise<number> {
  const { count } = await tx.teamWhatsappRecipient.updateMany({
    where: { dispatchId, status: 'SCHEDULED' },
    data: { status: 'FAILED', errorCode: CHANNEL_UNAVAILABLE },
  });
  return count;
}

/** Apagado = `userId` null (SetNull); inativo = `isActive` false. O resto vira QUEUED. */
async function queueActive(
  tx: Tx,
  dispatchId: string,
): Promise<Omit<ClaimResult, 'failed'>> {
  const { count: skipped } = await tx.teamWhatsappRecipient.updateMany({
    where: {
      dispatchId,
      status: 'SCHEDULED',
      OR: [{ userId: null }, { user: { isActive: false } }],
    },
    data: { status: 'SKIPPED', skipReason: 'INACTIVE' },
  });
  const rows = await tx.teamWhatsappRecipient.findMany({
    where: { dispatchId, status: 'SCHEDULED' },
    select: { id: true },
  });
  const queuedIds = rows.map((r) => r.id);
  await tx.teamWhatsappRecipient.updateMany({
    where: { id: { in: queuedIds } },
    data: { status: 'QUEUED' },
  });
  return { queuedIds, skipped };
}

type Found<K extends keyof TeamWhatsappRepository> =
  TeamWhatsappRepository[K] extends (...args: never[]) => Promise<infer R>
    ? NonNullable<R>
    : never;
export type TeamSector = Found<'findSector'>;
export type TeamChannel = Found<'findChannel'>;
export type TeamCreatedDispatch = Found<'createDispatch'>;
