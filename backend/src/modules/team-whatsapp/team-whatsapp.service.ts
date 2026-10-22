import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type {
  TeamWhatsappRecipientStatus,
  TeamWhatsappTargetType,
} from '@prisma/client';
import { ConsentService } from '../consent/consent.service';
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
  invalidSelection,
  invalidShift,
  noRecipients,
  scheduleInPast,
  teamForbidden,
} from './team-whatsapp.errors';
import {
  overnightInProgress,
  sectorTargetLabel,
  selectMembers,
} from './team-whatsapp.selection';
import {
  dayMembers,
  dayShift,
  eligibleFor,
  parseRosterSnapshot,
  rosterGroups,
  rosterSnapshot,
  shiftStarts,
  toRosterMember,
  type RosterSnapshot,
} from './team-whatsapp.roster';
import {
  TeamWhatsappRepository,
  type NewTeamRecipient,
  type TeamCreatedDispatch,
  type TeamDispatchRow,
  type TeamMember,
  type TeamRecipientRow,
  type TeamSector,
  type TeamStatusCount,
} from './team-whatsapp.repository';

const QUEUE_UNAVAILABLE = 'team_whatsapp.queue_unavailable';

/** Destinatário resolvido: o membro e o turno gravado nele (dia ou cadastro). */
type TargetMember = {
  member: TeamMember;
  shiftId: string | null;
  shiftName: string | null;
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

const displayName = (u: { name: string | null; email: string }) =>
  u.name ?? u.email;

/**
 * Recado de ADMIN/gestor para a equipe. Ordem do POST: remetente → alvo +
 * política (403) → turno ativo (422 `invalid_shift`) → escala da data refeita
 * no servidor e seleção contra ela (422 `invalid_selection`) → no agendado,
 * início do turno no futuro (422 `schedule_in_past`) → canal (422/409, D7) →
 * destinatários (422 `no_recipients`) → grava (com a foto da escala) →
 * enfileira (agendado: não; o disparo é da T9) → auditoria. A política vem antes da seleção (`userIds`
 * não abre outro setor) e antes do canal (não revela canais a quem não pode).
 * Seleção inválida = nada gravado, enfileirado ou auditado (GC9). Texto e
 * telefones nunca vão para log, auditoria nem foto.
 */
@Injectable()
export class TeamWhatsappService {
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
    const [channels, sectors, shifts] = await Promise.all([
      this.repo.listEligibleChannels(),
      this.repo.listSectors(onlyIds),
      this.repo.listActiveShifts(),
    ]);
    const now = new Date();
    return {
      today: todayIn(now),
      inProgress: overnightInProgress(shifts, now),
      shifts,
      channels: eligibleChannels(channels),
      sectors,
    };
  }

  /** Escala do setor na data (C6); 403 pela política de envio (GC7). */
  async roster(
    actorId: string,
    query: TeamRosterQuery,
  ): Promise<TeamRosterResponse> {
    const actor = await this.requireSender(actorId);
    const sector = await this.requireSector(actor, query.sectorId);
    const [shifts, people] = await Promise.all([
      this.repo.listActiveShifts(),
      this.repo.loadDayPeople(sector.id, query.date),
    ]);
    const members = dayMembers({
      sectorId: sector.id,
      date: query.date,
      people,
    });
    return {
      sectorId: sector.id,
      date: query.date,
      shiftStarts: shiftStarts(shifts, query.date),
      members: members.map(toRosterMember),
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
      shift: null,
      // Alvo pessoa: o turno gravado é o do cadastro.
      members: [
        {
          member: user,
          shiftId: user.shiftId,
          shiftName: user.workShift?.name ?? null,
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

  /**
   * Política (403) antes do turno (422 `invalid_shift`) e da seleção (422
   * `invalid_selection`): `userIds` não abre outro setor. A seleção é validada
   * contra a escala da data refeita agora (GC9), não contra a lista da tela.
   */
  private async resolveSector(
    actor: TeamActor,
    target: SectorTargetInput,
  ): Promise<ResolvedTarget> {
    const sector = await this.requireSector(actor, target.sectorId);
    const shifts = await this.repo.listActiveShifts();
    const shift = requireShift(shifts, target.shiftId);
    const { date, shiftId } = target;
    const people = await this.repo.loadDayPeople(sector.id, date);
    const day = dayMembers({ sectorId: sector.id, date, people });
    const includeOff = shiftId === undefined && target.includeOff === true;
    const eligible = eligibleFor(day, { shiftId, includeOff });
    const members = selectMembers(eligible, target.userIds);
    if (members === null) throw invalidSelection();
    const names = new Map(shifts.map((s) => [s.id, s.name]));
    const selected = target.userIds ? members.length : null;
    return {
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: sectorTargetLabel(
        sector.name,
        shift?.name ?? null,
        date,
        selected,
      ),
      shift,
      members: members.map((m) => ({ member: m, ...dayShift(m, names) })),
      day: {
        rosterDate: date,
        includeOff,
        roster: rosterSnapshot(day, { shiftId }, names),
      },
    };
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
  ): Promise<NewTeamRecipient[]> {
    const recipients: NewTeamRecipient[] = [];
    for (const { member: m, shiftId, shiftName } of targets) {
      const phone = m.contact?.phoneE164 ?? m.phoneE164;
      const base = {
        userId: m.id,
        userName: displayName(m),
        shiftId,
        shiftName,
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

function isSkipped(r: NewTeamRecipient): r is NewTeamRecipient & {
  skipReason: NonNullable<NewTeamRecipient['skipReason']>;
} {
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

/** Foto da escala → escalados não marcados e de folga, fora dos destinatários. */
function rosterOf(row: TeamDispatchRow, recipients: TeamRecipientItem[]) {
  const recipientIds = new Set(
    recipients.flatMap((r) => (r.userId ? [r.userId] : [])),
  );
  return rosterGroups(parseRosterSnapshot(row.roster), recipientIds);
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
