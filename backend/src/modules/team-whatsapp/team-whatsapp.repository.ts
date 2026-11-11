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
import type { PageQuery } from './dto/page-query.dto';
import { tooManyPeople } from './team-whatsapp.errors';
import { NOT_REPEATABLE_CODES } from './team-whatsapp.outcome';
import type { RosterSnapshot } from './team-whatsapp.roster';
import { findTeamActor } from './team-actor.query';
import {
  SECTOR_CHANNEL_SELECT,
  effectiveChannel,
  type SectorChannelRef,
} from './sector-channel';
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

/**
 * Número efetivo da área (D2) mais o nome da instância Evolution, que o estado
 * ao vivo (D7) precisa; o `evolutionInstanceName` nunca vai para a API.
 */
export type TeamSectorChannelRow = SectorChannelRef & {
  evolutionInstanceName: string | null;
};

/** Escala que cruza a data (ciclo e exceções) de uma pessoa, pronta para `resolveDay`. */
export type PersonSchedule = Pick<
  TeamMemberWithSchedule,
  'cycle' | 'exceptions'
>;

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
  state: true,
  scheduledFor: true,
  firedAt: true,
  author: { select: { id: true, name: true, email: true } },
  sectors: { select: { sectorId: true, sectorName: true } },
} satisfies Prisma.TeamWhatsappDispatchSelect;
export type TeamDispatchRow = Prisma.TeamWhatsappDispatchGetPayload<{
  select: typeof dispatchListSelect;
}>;

/** Topo da tela de resultado (C5): o texto e a foto da escala, sem destinatários. */
const dispatchDetailSelect = {
  id: true,
  targetLabel: true,
  text: true,
  state: true,
  createdAt: true,
  scheduledFor: true,
  firedAt: true,
  roster: true,
  author: { select: { id: true, name: true } },
  sectors: { select: { sectorId: true, sectorName: true } },
} satisfies Prisma.TeamWhatsappDispatchSelect;
export type DispatchDetailRow = Prisma.TeamWhatsappDispatchGetPayload<{
  select: typeof dispatchDetailSelect;
}>;

/** O que a política precisa de um envio (T11 `canViewDispatch`; a T12 reusa). */
export type DispatchForActor = {
  id: string;
  authorId: string | null;
  targetType: TeamWhatsappTargetType;
  targetId: string;
  state: TeamWhatsappDispatchState;
  sectors: { sectorId: string }[];
};

/** Número de uma linha da tela de resultado: o snapshot do destinatário (D3), sem telefone de pessoa. */
export type RecipientChannel = {
  name: string | null;
  phoneE164: string | null;
};

/** Destinatário na tela de resultado (C5): turno, setor e nível do snapshot; sem telefone de pessoa. */
export type DispatchRecipientRow = {
  id: string;
  userName: string;
  sectorName: string | null;
  levelName: string | null;
  shiftName: string | null;
  status: TeamWhatsappRecipientStatus;
  errorCode: string | null;
  skipReason: TeamWhatsappSkipReason | null;
  attempts: number;
  // null = sem número (pulado antes de escolher o canal).
  channel: RecipientChannel | null;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  repliedAt: Date | null;
};

/** Quantos destinatários do envio saem por cada número (snapshot); null = número removido. */
export type TeamChannelCount = RecipientChannel & {
  dispatchId: string;
  count: number;
};

/** Filtro e página da lista de destinatários (C5). */
export type RecipientsPage = PageQuery & {
  status?: TeamWhatsappRecipientStatus;
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
  // Número por onde sai (D3): o efetivo da área em que a pessoa aparece, com o
  // snapshot de nome e telefone (o histórico sobrevive à remoção do canal).
  channelId: string | null;
  channelName: string | null;
  channelPhoneE164: string | null;
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
  // O canal quando o envio tem um número só; null com mais de um (D3).
  channelId: string | null;
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

/** Pessoas na lista do dia de todos os setores pedidos; acima disso, 422 (D13). */
export const DAY_PEOPLE_LIMIT = 2000;

const recipientRowSelect = {
  id: true,
  userName: true,
  sectorName: true,
  levelName: true,
  shiftName: true,
  status: true,
  errorCode: true,
  skipReason: true,
  attempts: true,
  channelName: true,
  channelPhoneE164: true,
  acceptedAt: true,
  deliveredAt: true,
  readAt: true,
  repliedAt: true,
  dispatch: {
    select: { channel: { select: { name: true, phoneE164: true } } },
  },
} satisfies Prisma.TeamWhatsappRecipientSelect;
type RecipientPayload = Prisma.TeamWhatsappRecipientGetPayload<{
  select: typeof recipientRowSelect;
}>;

const hasNumber = (c: RecipientChannel) =>
  c.name !== null || c.phoneE164 !== null;

function toRecipientRow({
  channelName,
  channelPhoneE164,
  dispatch,
  ...row
}: RecipientPayload): DispatchRecipientRow {
  const own = { name: channelName, phoneE164: channelPhoneE164 };
  // Sem snapshot, não-pulado: canal do envio; apagado = "Número removido" (como em channelsByDispatch).
  const legacy =
    row.status === 'SKIPPED'
      ? null
      : (dispatch.channel ?? { name: null, phoneE164: null });
  return { ...row, channel: hasNumber(own) ? own : legacy };
}

/** Grupos com o mesmo número (ex.: snapshot + canal do envio) somam; maior primeiro, depois por nome. */
function mergeChannelCounts(
  rows: readonly TeamChannelCount[],
): TeamChannelCount[] {
  const merged = new Map<string, TeamChannelCount>();
  for (const row of rows) {
    const key = JSON.stringify([row.dispatchId, row.name, row.phoneE164]);
    const seen = merged.get(key);
    merged.set(key, seen ? { ...seen, count: seen.count + row.count } : row);
  }
  return [...merged.values()].sort(
    (a, b) =>
      b.count - a.count || (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR'),
  );
}

function pageWindow({ page, pageSize }: PageQuery) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

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

  /**
   * Ativos dos setores principais mais os visitantes pedidos (ativos), por
   * nome. Mais de `DAY_PEOPLE_LIMIT` → 422 `too_many_people`, nunca corte.
   */
  async findMembersForDay(
    sectorIds: readonly string[],
    visitorIds: readonly string[],
  ): Promise<TeamMemberRow[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { sectorId: { in: [...sectorIds] } },
          { id: { in: [...visitorIds] } },
        ],
      },
      orderBy: { name: 'asc' },
      take: DAY_PEOPLE_LIMIT + 1,
      select: teamMemberRowSelect,
    });
    if (rows.length > DAY_PEOPLE_LIMIT) throw tooManyPeople();
    return rows;
  }

  /**
   * Quem pode estar na escala de cada setor na data, em uma rodada de
   * consultas para todos (visitantes, pessoas, ciclo e exceções): os ativos do
   * setor e os de fora com OTHER_SECTOR para ele nessa data. Quem entra decide
   * `dayMembers`. Todo setor pedido tem entrada, ainda que vazia.
   */
  async loadDayPeopleMany(
    sectorIds: readonly string[],
    date: CivilDate,
  ): Promise<Map<string, TeamMemberWithSchedule[]>> {
    const visitors = await this.schedule.listVisitorIdsBySector(
      sectorIds,
      date,
      date,
    );
    const rows = await this.findMembersForDay(sectorIds, [
      ...new Set([...visitors.values()].flat()),
    ]);
    const data = await this.schedule.loadScheduleData(
      rows.map((r) => r.id),
      date,
      date,
    );
    const people = rows.map((row) => ({
      ...row,
      cycle: data.get(row.id)?.cycle ?? null,
      exceptions: data.get(row.id)?.exceptions ?? [],
    }));
    return new Map(
      sectorIds.map((sectorId) => {
        const visiting = new Set(visitors.get(sectorId));
        return [
          sectorId,
          people.filter((p) => p.sectorId === sectorId || visiting.has(p.id)),
        ];
      }),
    );
  }

  /**
   * Número efetivo (D2) de cada setor pedido, numa consulta. Todo id pedido tem
   * entrada: `null` = sem número (sem canal, inativo ou fora de GOZAP/EVOLUTION).
   */
  async findSectorChannels(
    sectorIds: readonly string[],
  ): Promise<Map<string, TeamSectorChannelRow | null>> {
    const rows = await this.prisma.sector.findMany({
      where: { id: { in: [...sectorIds] } },
      select: {
        id: true,
        channel: {
          select: { ...SECTOR_CHANNEL_SELECT, evolutionInstanceName: true },
        },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r.channel]));
    return new Map(
      sectorIds.map((id) => {
        const channel = byId.get(id) ?? null;
        const ref = effectiveChannel(channel);
        const row = ref && {
          ...ref,
          evolutionInstanceName: channel?.evolutionInstanceName ?? null,
        };
        return [id, row];
      }),
    );
  }

  /** Ciclo e exceções da pessoa na data (a mesma leitura da escala dos setores). */
  async loadPersonSchedule(
    userId: string,
    date: CivilDate,
  ): Promise<PersonSchedule> {
    const data = (
      await this.schedule.loadScheduleData([userId], date, date)
    ).get(userId);
    return { cycle: data?.cycle ?? null, exceptions: data?.exceptions ?? [] };
  }

  /** Um setor só: o mesmo resultado de `loadDayPeopleMany([sectorId], date)`. */
  async loadDayPeople(
    sectorId: string,
    date: CivilDate,
  ): Promise<TeamMemberWithSchedule[]> {
    const many = await this.loadDayPeopleMany([sectorId], date);
    return many.get(sectorId) ?? [];
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

  /**
   * Troca atômica do "Repetir" (D12): um único `UPDATE ... RETURNING` tira de
   * FAILED só as falhas certas do envio e devolve exatamente as linhas que ESTA
   * chamada trocou. Dois cliques ou duas abas: uma recebe a linha, a outra recebe
   * `[]`. O `WHERE` repete `isRepeatable` (C4): FAILED com código que não seja de
   * número inválido nem de timeout. Mesmo destinatário, texto e número: só o
   * status, o código e `manualRetries` mudam. SQL parametrizado, sem interpolar.
   */
  async requeueFailed(
    dispatchId: string,
    recipientIds: readonly string[] | 'all',
  ): Promise<{ id: string; manualRetries: number }[]> {
    const onlyIds =
      recipientIds === 'all'
        ? Prisma.empty
        : Prisma.sql`AND "id" = ANY(${[...recipientIds]}::text[])`;
    return this.prisma.$queryRaw<{ id: string; manualRetries: number }[]>(
      Prisma.sql`
        UPDATE "TeamWhatsappRecipient"
        SET "status" = 'QUEUED',
            "errorCode" = NULL,
            "manualRetries" = "manualRetries" + 1,
            "updatedAt" = now()
        WHERE "dispatchId" = ${dispatchId}
          AND "status" = 'FAILED'
          AND "errorCode" IS NOT NULL
          AND "errorCode" <> ALL(${[...NOT_REPEATABLE_CODES]}::text[])
          AND "errorCode" NOT LIKE '%.timeout'
          ${onlyIds}
        RETURNING "id", "manualRetries"`,
    );
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
   * O canal é o de CADA destinatário (D3/D7): um número inativo falha só as
   * pessoas dele, e as dos outros números seguem. O estado ao vivo não é
   * consultado aqui (sem chamada ao provedor dentro da transação): o processor
   * confere cada mensagem. A lista congelada vale mesmo com o setor desativado
   * depois (spec §6).
   */
  async claimScheduled(id: string, now: Date): Promise<ClaimResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.teamWhatsappDispatch.updateMany({
        where: { id, state: 'SCHEDULED', scheduledFor: { lte: now } },
        data: { state: 'DISPATCHED', firedAt: now },
      });
      if (count === 0) return null;
      const failed = await failUnavailable(tx, id);
      return { ...(await queueActive(tx, id)), failed };
    });
  }

  /**
   * D6: uma tentativa = uma chamada ao provedor. O processor chama imediatamente
   * antes de `sendTeamMessage`; o `where` em QUEUED impede contar em linha que
   * um recibo ou outra execução já fechou.
   */
  async countAttempt(recipientId: string): Promise<void> {
    await this.prisma.teamWhatsappRecipient.updateMany({
      where: { id: recipientId, status: 'QUEUED' },
      data: { attempts: { increment: 1 } },
    });
  }

  /**
   * Só `state = SCHEDULED`, por `scheduledFor` asc, uma página (D13) com o
   * total; `onlySectorIds = null` → todos (ADMIN). Gestor (C7/D5): só alvo
   * setor com ≥1 setor e TODOS os setores do envio entre os dele (`every`
   * sozinho aceitaria envio sem setor); o filtro vale para a página e o total.
   */
  async listScheduled(
    onlySectorIds: readonly string[] | null,
    page: PageQuery,
  ): Promise<{ rows: ScheduledRow[]; total: number }> {
    const where: Prisma.TeamWhatsappDispatchWhereInput = {
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
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamWhatsappDispatch.findMany({
        where,
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        ...pageWindow(page),
        select: scheduledSelect,
      }),
      this.prisma.teamWhatsappDispatch.count({ where }),
    ]);
    return {
      rows: rows.map(({ _count, ...row }) => ({
        ...row,
        recipientCount: _count.recipients,
      })),
      total,
    };
  }

  /** `authorId = null` → envios de todos (ADMIN); senão só os do autor. Uma página, mais novos primeiro. */
  async listDispatches(
    authorId: string | null,
    page: PageQuery,
  ): Promise<{ rows: TeamDispatchRow[]; total: number }> {
    const where = authorId === null ? {} : { authorId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamWhatsappDispatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageWindow(page),
        select: dispatchListSelect,
      }),
      this.prisma.teamWhatsappDispatch.count({ where }),
    ]);
    return { rows, total };
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
  /** Autor, alvo e setores do envio para a política (GC5); a visibilidade é decidida por quem chama. */
  findDispatchForActor(id: string): Promise<DispatchForActor | null> {
    return this.prisma.teamWhatsappDispatch.findUnique({
      where: { id },
      select: {
        id: true,
        authorId: true,
        targetType: true,
        targetId: true,
        state: true,
        sectors: { select: { sectorId: true } },
      },
    });
  }

  findDispatchDetail(id: string): Promise<DispatchDetailRow | null> {
    return this.prisma.teamWhatsappDispatch.findUnique({
      where: { id },
      select: dispatchDetailSelect,
    });
  }

  /** Dos `userIds` da foto da escala, os que são destinatários do envio (o resto ficou de fora). */
  async findRecipientUserIds(
    dispatchId: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.teamWhatsappRecipient.findMany({
      where: { dispatchId, userId: { in: [...userIds] } },
      select: { userId: true },
    });
    return rows.flatMap((r) => (r.userId ? [r.userId] : []));
  }

  /**
   * Uma página dos destinatários do envio, por `userName` e depois `id`, com o
   * `total` do filtro. Envio sem snapshot de número (anterior ao backfill) cai
   * no canal do envio; o pulado nunca teve número (C5).
   */
  async listDispatchRecipients(
    dispatchId: string,
    { status, ...page }: RecipientsPage,
  ): Promise<{ rows: DispatchRecipientRow[]; total: number }> {
    const where: Prisma.TeamWhatsappRecipientWhereInput = {
      dispatchId,
      ...(status ? { status } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamWhatsappRecipient.findMany({
        where,
        orderBy: [{ userName: 'asc' }, { id: 'asc' }],
        ...pageWindow(page),
        select: recipientRowSelect,
      }),
      this.prisma.teamWhatsappRecipient.count({ where }),
    ]);
    return { rows: rows.map(toRecipientRow), total };
  }

  /**
   * Quantos destinatários saem por cada número, pelo snapshot (D3). Sem snapshot
   * (envio anterior ao backfill) cai no canal do envio; pulado sem snapshot nunca
   * teve número e fica de fora.
   */
  async channelsByDispatch(
    dispatchIds: readonly string[],
  ): Promise<TeamChannelCount[]> {
    if (dispatchIds.length === 0) return [];
    const groups = await this.prisma.teamWhatsappRecipient.groupBy({
      by: ['dispatchId', 'channelName', 'channelPhoneE164'],
      where: {
        dispatchId: { in: [...dispatchIds] },
        NOT: { status: 'SKIPPED', channelName: null, channelPhoneE164: null },
      },
      _count: { _all: true },
    });
    const unnamed = groups
      .filter(
        (g) =>
          !hasNumber({ name: g.channelName, phoneE164: g.channelPhoneE164 }),
      )
      .map((g) => g.dispatchId);
    const fallback = await this.dispatchChannels(unnamed);
    return mergeChannelCounts(
      groups.map((g) => {
        const own = { name: g.channelName, phoneE164: g.channelPhoneE164 };
        return {
          dispatchId: g.dispatchId,
          ...(hasNumber(own) ? own : (fallback.get(g.dispatchId) ?? own)),
          count: g._count._all,
        };
      }),
    );
  }

  /** Nome e telefone do canal de cada envio que ainda o tem (SetNull remove). */
  private async dispatchChannels(
    dispatchIds: readonly string[],
  ): Promise<Map<string, RecipientChannel>> {
    if (dispatchIds.length === 0) return new Map();
    const rows = await this.prisma.teamWhatsappDispatch.findMany({
      where: { id: { in: [...dispatchIds] }, channelId: { not: null } },
      select: {
        id: true,
        channel: { select: { name: true, phoneE164: true } },
      },
    });
    return new Map(
      rows.flatMap((r) => (r.channel ? [[r.id, r.channel] as const] : [])),
    );
  }
}

const usableChannelSelect = {
  select: { isActive: true, provider: true },
} as const;

/**
 * SCHEDULED cujo número (o do destinatário; o do envio só na linha legada sem
 * canal) está inativo, removido ou fora de TEAM_PROVIDERS → FAILED
 * `channel_unavailable`. Devolve quantos falharam.
 */
async function failUnavailable(tx: Tx, dispatchId: string): Promise<number> {
  const rows = await tx.teamWhatsappRecipient.findMany({
    where: { dispatchId, status: 'SCHEDULED' },
    select: {
      id: true,
      channel: usableChannelSelect,
      dispatch: { select: { channel: usableChannelSelect } },
    },
  });
  const unavailable = rows
    .filter((r) => {
      const channel = r.channel ?? r.dispatch.channel;
      return !channel?.isActive || !isTeamProvider(channel.provider);
    })
    .map((r) => r.id);
  if (unavailable.length === 0) return 0;
  const { count } = await tx.teamWhatsappRecipient.updateMany({
    where: { id: { in: unavailable }, status: 'SCHEDULED' },
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
export type TeamCreatedDispatch = Found<'createDispatch'>;
