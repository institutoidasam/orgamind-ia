import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type {
  TeamWhatsappRecipientStatus,
  TeamWhatsappTargetType,
} from '@prisma/client';
import { ConsentService } from '../consent/consent.service';
import { LevelsRepository } from '../levels/levels.repository';
import { AuditService } from '../../shared/audit/audit.service';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import {
  teamConnectionStateSchema,
  type CreateTeamDispatchResponse,
  type TeamDispatchCounts,
  type TeamDispatchListResponse,
  type TeamRosterQuery,
  type TeamRosterPerson,
  type TeamRosterResponse,
  type TeamShiftSnapshot,
  type TeamTargetsResponse,
} from '../../schemas/contracts/team-whatsapp.schema';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import { fromDbDate, todayIn, zonedStart } from '../staff-schedule/civil-date';
import type { CreateTeamDispatchInput } from './dto/create-team-dispatch.dto';
import {
  canSendToSector,
  canSendToUser,
  isTeamProvider,
  isTeamSender,
  type TeamActor,
} from './team-whatsapp.policy';
import {
  channelDisconnected,
  channelInvalid,
  invalidLevel,
  invalidSelection,
  invalidShift,
  noRecipients,
  scheduleInPast,
  teamForbidden,
} from './team-whatsapp.errors';
import { overnightInProgress, selectMembers } from './team-whatsapp.selection';
import {
  dayMembers,
  dayShift,
  eligibleAcross,
  parseRosterSnapshot,
  pickLevels,
  rosterGroups,
  rosterSnapshot,
  sectorTargetLabel,
  shiftStarts,
  toRosterMember,
  type LevelFilter,
  type RosterSnapshot,
  type SectorDay,
  type SectorMember,
} from './team-whatsapp.roster';
import {
  TeamWhatsappRepository,
  type DispatchSector,
  type NewTeamDispatchRecipient,
  type NewTeamRecipient,
  type RecipientSnapshot,
  type TeamCreatedDispatch,
  type TeamDispatchRow,
  type TeamMember,
  type TeamRecipientRow,
  type TeamSector,
  type TeamStatusCount,
} from './team-whatsapp.repository';

const QUEUE_UNAVAILABLE = 'team_whatsapp.queue_unavailable';

/**
 * Destinatário resolvido: o membro, o turno gravado nele (dia ou cadastro) e o
 * snapshot de setor/nível (C6; tudo null no alvo pessoa).
 */
type TargetMember = {
  member: TeamMember;
  shiftId: string | null;
  shiftName: string | null;
  snapshot: RecipientSnapshot;
};

/** Alvo pessoa: sem setor do envio nem nível no destinatário. */
const NO_SECTOR_SNAPSHOT: RecipientSnapshot = {
  sectorId: null,
  sectorName: null,
  levelName: null,
};

/** Foto da escala do alvo setor (C10); o alvo pessoa não tem. */
type DayRoster = {
  rosterDate: string;
  includeOff: boolean;
  roster: RosterSnapshot;
};

type ResolvedTarget = {
  targetType: TeamWhatsappTargetType;
  targetId: string;
  targetLabel: string;
  // Setores do envio (C6): o do alvo setor; [] no alvo pessoa.
  sectors: DispatchSector[];
  // Turno do filtro do alvo setor; null = todos os turnos ou alvo pessoa.
  shift: TeamShiftSnapshot | null;
  members: TargetMember[];
  day: DayRoster | null;
};

type SectorTargetInput = Extract<
  CreateTeamDispatchInput['target'],
  { type: 'sector' }
>;

type SkippedRecipient = CreateTeamDispatchResponse['skipped'][number];

/** Status de quem vai receber: QUEUED (agora) ou SCHEDULED (início do turno). */
type PendingStatus = Extract<
  TeamWhatsappRecipientStatus,
  'QUEUED' | 'SCHEDULED'
>;

/** Envio já gravado, a enfileirar (agora) ou só auditar (agendado). */
type CreatedDispatch = {
  actorId: string;
  channelId: string;
  target: ResolvedTarget;
  created: TeamCreatedDispatch;
  skipped: SkippedRecipient[];
};

const displayName = (u: { name: string | null; email: string | null }) =>
  u.name ?? u.email ?? '';

/** Ordem dos setores no rótulo, nas linhas do envio e no roster (GC12). */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'pt-BR');

/**
 * Recado de ADMIN/gestor para a equipe. Ordem do POST: remetente → alvo +
 * política de cada setor (403) → turno ativo (422 `invalid_shift`) → níveis
 * ativos (422 `invalid_level`) → escala da data refeita no servidor e seleção
 * contra ela (422 `invalid_selection`) → no agendado,
 * início do turno no futuro (422 `schedule_in_past`) → canal (422/409, D7) →
 * destinatários (422 `no_recipients`) → grava (com a foto da escala) →
 * enfileira (agendado: não; o disparo é da T9) → auditoria. A política vem antes da seleção (`userIds`
 * não abre outro setor) e antes do canal (não revela canais a quem não pode).
 * Seleção inválida = nada gravado, enfileirado ou auditado (GC9). Texto e
 * telefones nunca vão para log, auditoria nem foto.
 */
@Injectable()
export class TeamWhatsappService {
  /**
   * Níveis ativos (C4, e o filtro de nível do POST, C5). Injeção por
   * propriedade: o construtor já tem 4 dependências, o limite da GC2.
   */
  @Inject(LevelsRepository)
  private readonly levels!: LevelsRepository;

  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly consent: ConsentService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND)
    private readonly queue: Queue<TeamWhatsappSendJob>,
  ) {}

  async dispatch(
    actorId: string,
    input: CreateTeamDispatchInput,
  ): Promise<CreateTeamDispatchResponse> {
    const actor = await this.requireSender(actorId);
    const target = await this.resolveTarget(actor, input.target);
    const scheduledFor =
      input.when === 'shift_start' ? shiftStartOf(target, new Date()) : null;
    await this.requireChannel(input.channelId);
    const pending: PendingStatus = scheduledFor ? 'SCHEDULED' : 'QUEUED';
    const recipients = await this.classify(target.members, pending);
    if (!recipients.some((r) => r.status === pending)) throw noRecipients();

    const created = await this.repo.createDispatch({
      authorId: actor.id,
      targetType: target.targetType,
      targetId: target.targetId,
      targetLabel: target.targetLabel,
      ...shiftColumns(target.shift),
      ...target.day,
      sectors: target.sectors,
      channelId: input.channelId,
      text: input.text,
      recipients,
      ...(scheduledFor ? { state: 'SCHEDULED' as const, scheduledFor } : {}),
    });
    const done: CreatedDispatch = {
      actorId: actor.id,
      channelId: input.channelId,
      target,
      created,
      skipped: recipients.filter(isSkipped).map(toSkipped),
    };
    return scheduledFor
      ? this.scheduled(done, scheduledFor)
      : this.dispatchNow(done);
  }

  /** Agendado (T8): nada vai para a fila agora; o disparo é do worker (T9). */
  private async scheduled(
    { actorId, created, skipped }: CreatedDispatch,
    scheduledFor: Date,
  ): Promise<CreateTeamDispatchResponse> {
    const scheduled = created.recipients.filter(
      (r) => r.status === 'SCHEDULED',
    ).length;
    await this.audit.log(
      'team_whatsapp.schedule',
      'TeamWhatsappDispatch',
      created.id,
      { actorId, dispatchId: created.id, scheduled, skipped: skipped.length },
    );
    return {
      dispatchId: created.id,
      queued: 0,
      scheduled,
      scheduledFor: scheduledFor.toISOString(),
      skipped,
    };
  }

  private async dispatchNow({
    actorId,
    channelId,
    target,
    created,
    skipped,
  }: CreatedDispatch): Promise<CreateTeamDispatchResponse> {
    const queuedIds = created.recipients
      .filter((r) => r.status === 'QUEUED')
      .map((r) => r.id);
    await enqueueTeamSend(this.queue, this.repo, queuedIds);
    await this.audit.log(
      'team_whatsapp.dispatch',
      'TeamWhatsappDispatch',
      created.id,
      {
        actorId,
        targetType: target.targetType,
        targetId: target.targetId,
        ...(target.targetType === 'SECTOR'
          ? { sectorIds: target.sectors.map((s) => s.sectorId) }
          : {}),
        channelId,
        queued: queuedIds.length,
        skipped: skipped.length,
      },
    );
    return {
      dispatchId: created.id,
      queued: queuedIds.length,
      scheduled: 0,
      scheduledFor: null,
      skipped,
    };
  }

  /**
   * Alvos permitidos ao remetente: ADMIN vê todos os setores ativos; gestor, os
   * seus. `today`/`inProgress` no fuso de Manaus (GC5).
   */
  async targets(actorId: string): Promise<TeamTargetsResponse> {
    const actor = await this.requireSender(actorId);
    const onlyIds = actor.role === 'ADMIN' ? null : actor.managedSectorIds;
    const [channels, sectors, shifts, levels] = await Promise.all([
      this.repo.listEligibleChannels(),
      this.repo.listSectors(onlyIds),
      this.repo.listActiveShifts(),
      this.levels.listActive(),
    ]);
    const now = new Date();
    return {
      today: todayIn(now),
      inProgress: overnightInProgress(shifts, now),
      shifts,
      channels: eligibleChannels(channels),
      sectors,
      levels,
    };
  }

  /**
   * Escala dos setores na data (C4): cada setor passa pela política antes de
   * ler pessoas (403 no primeiro que falhar, GC6); depois um setor por vez
   * (M2), com a regra de hoje (`dayMembers`: uma pessoa em um setor só).
   */
  async roster(
    actorId: string,
    query: TeamRosterQuery,
  ): Promise<TeamRosterResponse> {
    const actor = await this.requireSender(actorId);
    const sectors = await this.requireSectors(actor, query.sectorIds);
    const { date } = query;
    const [shifts, days] = await Promise.all([
      this.repo.listActiveShifts(),
      this.sectorDays(sectors, date),
    ]);
    const rows = days.map((d) => ({
      sectorId: d.sectorId,
      name: d.sectorName,
      members: d.members.map(toRosterMember),
    }));
    return {
      date,
      shiftStarts: shiftStarts(shifts, date),
      sectors: rows.sort(byName),
    };
  }

  /** 20 envios mais novos: ADMIN vê todos; gestor, os próprios. */
  async listDispatches(actorId: string): Promise<TeamDispatchListResponse> {
    const actor = await this.requireSender(actorId);
    const rows = await this.repo.listDispatches(
      actor.role === 'ADMIN' ? null : actor.id,
    );
    const ids = rows.map((r) => r.id);
    const counts = countsByDispatch(await this.repo.countByStatus(ids));
    const recipients = recipientsByDispatch(
      await this.repo.listRecipients(ids),
    );
    return {
      items: rows.map((row) =>
        toListItem(row, counts.get(row.id), recipients.get(row.id) ?? []),
      ),
    };
  }

  private async requireSender(actorId: string): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    return actor;
  }

  private resolveTarget(
    actor: TeamActor,
    target: CreateTeamDispatchInput['target'],
  ): Promise<ResolvedTarget> {
    return target.type === 'user'
      ? this.resolveUser(actor, target.userId)
      : this.resolveSector(actor, target);
  }

  private async resolveUser(
    actor: TeamActor,
    userId: string,
  ): Promise<ResolvedTarget> {
    const user = await this.repo.findTargetUser(userId);
    if (!user || !canSendToUser(actor, user)) throw teamForbidden();
    return {
      targetType: 'USER',
      targetId: user.id,
      targetLabel: displayName(user),
      sectors: [],
      shift: null,
      // Alvo pessoa: o turno gravado é o do cadastro.
      members: [
        {
          member: user,
          shiftId: user.shiftId,
          shiftName: user.workShift?.name ?? null,
          snapshot: NO_SECTOR_SNAPSHOT,
        },
      ],
      day: null,
    };
  }

  private async requireSector(
    actor: TeamActor,
    sectorId: string,
  ): Promise<TeamSector> {
    const sector = await this.repo.findSector(sectorId);
    if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
    return sector;
  }

  /** GC6: um setor por vez, na ordem pedida; o primeiro fora do alcance dá 403. */
  private async requireSectors(
    actor: TeamActor,
    sectorIds: readonly string[],
  ): Promise<TeamSector[]> {
    const sectors: TeamSector[] = [];
    for (const id of sectorIds) {
      sectors.push(await this.requireSector(actor, id));
    }
    return sectors;
  }

  /**
   * C5: política de cada setor (403) → turno (422 `invalid_shift`) → níveis
   * (422 `invalid_level`) → lista refeita → seleção (422 `invalid_selection`):
   * `userIds` não abre outro setor. A seleção é validada contra a escala da data
   * refeita agora, com os mesmos setores, níveis, turno e folga (GC7), não contra
   * a lista da tela. Setores por nome: o primeiro é o `targetId` (C6).
   */
  private async resolveSector(
    actor: TeamActor,
    target: SectorTargetInput,
  ): Promise<ResolvedTarget> {
    const ids = [...new Set(target.sectorIds)];
    const sectors = (await this.requireSectors(actor, ids)).sort(byName);
    const shifts = await this.repo.listActiveShifts();
    const shift = requireShift(shifts, target.shiftId);
    const levels = await this.requireLevels(target);
    const { date, shiftId } = target;
    const days = await this.sectorDays(sectors, date);
    const includeOff = shiftId === undefined && target.includeOff === true;
    const filter = { shiftId, includeOff, level: levels.filter };
    const members = selectMembers(eligibleAcross(days, filter), target.userIds);
    if (members === null) throw invalidSelection();
    const names = new Map(shifts.map((s) => [s.id, s.name]));
    return {
      targetType: 'SECTOR',
      targetId: sectors[0].id,
      targetLabel: sectorTargetLabel({
        sectorNames: sectors.map((s) => s.name),
        levelNames: levels.names,
        shiftName: shift?.name ?? null,
        date,
        selected: target.userIds ? members.length : null,
      }),
      sectors: sectors.map((s) => ({ sectorId: s.id, sectorName: s.name })),
      shift,
      members: members.map((m) => toTargetMember(m, names)),
      day: {
        rosterDate: date,
        includeOff,
        roster: rosterSnapshot(days, { shiftId, level: levels.filter }, names),
      },
    };
  }

  /** C5: só lê os níveis ativos com `levelIds`; inexistente ou inativo → 422. */
  private async requireLevels(
    target: SectorTargetInput,
  ): Promise<{ filter: LevelFilter; names: string[] }> {
    const active = target.levelIds?.length
      ? await this.levels.listActive()
      : [];
    const levels = pickLevels(active, target);
    if (!levels) throw invalidLevel();
    return levels;
  }

  /** Escala de cada setor na data (regra de hoje: uma pessoa em um setor só). */
  private async sectorDays(
    sectors: readonly TeamSector[],
    date: SectorTargetInput['date'],
  ): Promise<SectorDay[]> {
    const people = await Promise.all(
      sectors.map((s) => this.repo.loadDayPeople(s.id, date)),
    );
    return sectors.map((s, i) => ({
      sectorId: s.id,
      sectorName: s.name,
      members: dayMembers({ sectorId: s.id, date, people: people[i] }),
    }));
  }

  private async requireChannel(channelId: string): Promise<void> {
    const channel = await this.repo.findChannel(channelId);
    if (!channel || !channel.isActive || !isTeamProvider(channel.provider)) {
      throw channelInvalid();
    }
    if (channel.connectionEvents[0]?.state === 'close')
      throw channelDisconnected();
  }

  /**
   * O contato carrega a grafia que o merge elegeu como a que entrega. Sem
   * telefone/suprimido → SKIPPED já aqui, também no agendamento (D9); o resto
   * fica `pending` (QUEUED agora, SCHEDULED no agendado).
   */
  private async classify(
    targets: readonly TargetMember[],
    pending: PendingStatus,
  ): Promise<NewTeamDispatchRecipient[]> {
    const recipients: NewTeamDispatchRecipient[] = [];
    for (const { member: m, shiftId, shiftName, snapshot } of targets) {
      const phone = m.contact?.phoneE164 ?? m.phoneE164;
      const base = {
        userId: m.id,
        userName: displayName(m),
        shiftId,
        shiftName,
        ...snapshot,
      };
      if (!phone) {
        recipients.push({ ...base, status: 'SKIPPED', skipReason: 'NO_PHONE' });
      } else if (await this.consent.isSuppressed(phone)) {
        recipients.push({
          ...base,
          status: 'SKIPPED',
          skipReason: 'SUPPRESSED',
        });
      } else {
        recipients.push({ ...base, status: pending, skipReason: null });
      }
    }
    return recipients;
  }
}

/**
 * Sem fila não há envio: quem ficou QUEUED vira FAILED e o erro sobe (500 no
 * POST). Um job por destinatário, jobId = recipientId. Usado pelo envio imediato
 * e pelo disparo agendado (T9).
 */
export async function enqueueTeamSend(
  queue: Queue<TeamWhatsappSendJob>,
  repo: Pick<TeamWhatsappRepository, 'markFailed'>,
  recipientIds: readonly string[],
): Promise<void> {
  try {
    await queue.addBulk(
      recipientIds.map((id) => ({
        name: 'send',
        data: { recipientId: id },
        opts: { jobId: id },
      })),
    );
  } catch (err) {
    await repo.markFailed(recipientIds, QUEUE_UNAVAILABLE);
    throw err;
  }
}

/**
 * Início do turno do filtro na data da escala, em Manaus (GC5). O DTO garante
 * alvo setor com turno em `shift_start`; agora ou no passado → 422.
 */
function shiftStartOf(target: ResolvedTarget, now: Date): Date {
  if (!target.shift || !target.day) throw invalidShift();
  const start = zonedStart(target.day.rosterDate, target.shift.startTime);
  if (start.getTime() <= now.getTime()) throw scheduleInPast();
  return start;
}

/** Destinatário do alvo setor: turno do dia, setor em que entrou e nível na hora (C6). */
function toTargetMember(
  m: SectorMember,
  shiftNames: ReadonlyMap<string, string>,
): TargetMember {
  return {
    member: m,
    ...dayShift(m, shiftNames),
    snapshot: {
      ...m.inSector,
      levelName: m.level?.name ?? null,
    },
  };
}

/** Sem `shiftId` = todos os turnos; com, o turno precisa estar entre os ativos. */
function requireShift(
  active: readonly ShiftRef[],
  shiftId: string | undefined,
): TeamShiftSnapshot | null {
  if (shiftId === undefined) return null;
  const shift = active.find((s) => s.id === shiftId);
  if (!shift) throw invalidShift();
  return shift;
}

type ChannelRow = Awaited<
  ReturnType<TeamWhatsappRepository['listEligibleChannels']>
>[number];

/** Só provedores de equipe (defesa além do filtro do repositório), com o último estado. */
function eligibleChannels(
  rows: readonly ChannelRow[],
): TeamTargetsResponse['channels'] {
  return rows.flatMap(({ provider, connectionEvents, ...rest }) =>
    isTeamProvider(provider)
      ? [
          {
            ...rest,
            provider,
            connectionState: toConnectionState(connectionEvents[0]?.state),
          },
        ]
      : [],
  );
}

/** Colunas de snapshot do envio; null = todos os turnos ou alvo pessoa. */
function shiftColumns(shift: TeamShiftSnapshot | null) {
  return {
    shiftId: shift?.id ?? null,
    shiftName: shift?.name ?? null,
    shiftStartTime: shift?.startTime ?? null,
    shiftEndTime: shift?.endTime ?? null,
  };
}

function isSkipped<R extends NewTeamRecipient>(
  r: R,
): r is R & { skipReason: NonNullable<NewTeamRecipient['skipReason']> } {
  return r.status === 'SKIPPED' && r.skipReason !== null;
}

function toSkipped(
  r: NewTeamRecipient & { skipReason: SkippedRecipient['reason'] },
) {
  return { userId: r.userId, name: r.userName, reason: r.skipReason };
}

const STATUS_KEY: Record<
  TeamWhatsappRecipientStatus,
  keyof TeamDispatchCounts
> = {
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  SCHEDULED: 'scheduled',
  CANCELLED: 'cancelled',
};

const zeroCounts = (): TeamDispatchCounts => ({
  queued: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  scheduled: 0,
  cancelled: 0,
});

function countsByDispatch(
  rows: readonly TeamStatusCount[],
): Map<string, TeamDispatchCounts> {
  const byDispatch = new Map<string, TeamDispatchCounts>();
  for (const row of rows) {
    const counts = byDispatch.get(row.dispatchId) ?? zeroCounts();
    counts[STATUS_KEY[row.status]] += row.count;
    byDispatch.set(row.dispatchId, counts);
  }
  return byDispatch;
}

type TeamRecipientItem =
  TeamDispatchListResponse['items'][number]['recipients'][number];

/** Estado fora do enum (ex.: `qrcode`) ou ausente vira null: o front não adivinha. */
function toConnectionState(
  state: string | undefined,
): TeamTargetsResponse['channels'][number]['connectionState'] {
  const parsed = teamConnectionStateSchema.safeParse(state);
  return parsed.success ? parsed.data : null;
}

/** Todos os destinatários, por nome; reason = errorCode (FAILED) ou skipReason (SKIPPED). */
function recipientsByDispatch(
  rows: readonly TeamRecipientRow[],
): Map<string, TeamRecipientItem[]> {
  const sorted = [...rows].sort((a, b) =>
    a.userName.localeCompare(b.userName, 'pt-BR'),
  );
  const byDispatch = new Map<string, TeamRecipientItem[]>();
  for (const r of sorted) {
    const list = byDispatch.get(r.dispatchId) ?? [];
    list.push({
      userId: r.userId,
      name: r.userName,
      shiftName: r.shiftName,
      status: r.status,
      reason: reasonOf(r),
      sectorName: r.sectorName,
      levelName: r.levelName,
    });
    byDispatch.set(r.dispatchId, list);
  }
  return byDispatch;
}

function reasonOf(r: TeamRecipientRow): string | null {
  if (r.status === 'FAILED') return r.errorCode;
  if (r.status === 'SKIPPED') return r.skipReason;
  return null;
}

/** Snapshot gravado no envio; incompleto (todos os turnos, alvo pessoa) → null. */
export function shiftSnapshotOf(
  row: Pick<
    TeamDispatchRow,
    'shiftId' | 'shiftName' | 'shiftStartTime' | 'shiftEndTime'
  >,
): TeamShiftSnapshot | null {
  const { shiftId, shiftName, shiftStartTime, shiftEndTime } = row;
  if (!shiftId || !shiftName || !shiftStartTime || !shiftEndTime) return null;
  return {
    id: shiftId,
    name: shiftName,
    startTime: shiftStartTime,
    endTime: shiftEndTime,
  };
}

type TeamListPerson =
  TeamDispatchListResponse['items'][number]['unselected'][number];

/** Foto anterior à T7/T8b não tem setor nem nível da pessoa → null (C6). */
function withSnapshot(p: TeamRosterPerson): TeamListPerson {
  return {
    ...p,
    sectorName: p.sectorName ?? null,
    levelName: p.levelName ?? null,
  };
}

/** Foto da escala → escalados não marcados e de folga, fora dos destinatários. */
function rosterOf(row: TeamDispatchRow, recipients: TeamRecipientItem[]) {
  const recipientIds = new Set(
    recipients.flatMap((r) => (r.userId ? [r.userId] : [])),
  );
  const { unselected, off } = rosterGroups(
    parseRosterSnapshot(row.roster),
    recipientIds,
  );
  return {
    unselected: unselected.map(withSnapshot),
    off: off.map(withSnapshot),
  };
}

/** Setores do envio por nome (pt-BR); [] no alvo pessoa. */
function sectorsOf(row: TeamDispatchRow) {
  return row.sectors
    .map((s) => ({ id: s.sectorId, name: s.sectorName }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

function toListItem(
  row: TeamDispatchRow,
  counts: TeamDispatchCounts | undefined,
  recipients: TeamRecipientItem[],
): TeamDispatchListResponse['items'][number] {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    author: row.author,
    target: {
      type: row.targetType === 'USER' ? 'user' : 'sector',
      id: row.targetId,
      label: row.targetLabel,
      shift: shiftSnapshotOf(row),
    },
    sectors: sectorsOf(row),
    channel: row.channel,
    counts: counts ?? zeroCounts(),
    recipients,
    rosterDate: row.rosterDate ? fromDbDate(row.rosterDate) : null,
    ...rosterOf(row, recipients),
    state: row.state,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    firedAt: row.firedAt?.toISOString() ?? null,
  };
}
