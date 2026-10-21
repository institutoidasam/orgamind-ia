import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type {
  TeamWhatsappRecipientStatus,
  TeamWhatsappTargetType,
  WorkShift,
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
  type TeamTargetsResponse,
} from '../../schemas/contracts/team-whatsapp.schema';
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
  noRecipients,
  teamForbidden,
} from './team-whatsapp.errors';
import { sectorTargetLabel, selectMembers } from './team-whatsapp.selection';
import {
  TeamWhatsappRepository,
  type NewTeamRecipient,
  type TeamDispatchRow,
  type TeamMember,
  type TeamRecipientRow,
  type TeamStatusCount,
} from './team-whatsapp.repository';

const QUEUE_UNAVAILABLE = 'team_whatsapp.queue_unavailable';

type ResolvedTarget = {
  targetType: TeamWhatsappTargetType;
  targetId: string;
  targetLabel: string;
  // Filtro de turno do alvo setor; null = todos os turnos ou alvo pessoa.
  shift: WorkShift | null;
  members: TeamMember[];
};

type SectorTargetInput = Extract<
  CreateTeamDispatchInput['target'],
  { type: 'sector' }
>;

type SkippedRecipient = CreateTeamDispatchResponse['skipped'][number];

const displayName = (u: { name: string | null; email: string }) =>
  u.name ?? u.email;

/**
 * Recado de ADMIN/gestor para a equipe. Ordem do POST: remetente → alvo +
 * política (403) → seleção de setor/turno (422 `invalid_selection`) → canal
 * (422/409) → destinatários (422 `no_recipients`) → grava → enfileira →
 * auditoria. A política vem antes da seleção (`userIds` não abre outro setor)
 * e antes do canal (não revela canais a quem não pode). A seleção é refeita
 * sobre os membros ativos atuais: inválida = nada gravado, enfileirado ou
 * auditado. Texto e telefones nunca vão para log nem auditoria.
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
    await this.requireChannel(input.channelId);
    const recipients = await this.classify(target.members);
    if (!recipients.some((r) => r.status === 'QUEUED')) throw noRecipients();

    const { targetType, targetId, targetLabel } = target;
    const created = await this.repo.createDispatch({
      authorId: actor.id,
      targetType,
      targetId,
      targetLabel,
      shift: target.shift,
      channelId: input.channelId,
      text: input.text,
      recipients,
    });
    const queuedIds = created.recipients
      .filter((r) => r.status === 'QUEUED')
      .map((r) => r.id);
    await this.enqueue(queuedIds);

    const skipped = recipients.filter(isSkipped).map(toSkipped);
    await this.audit.log(
      'team_whatsapp.dispatch',
      'TeamWhatsappDispatch',
      created.id,
      {
        actorId: actor.id,
        targetType,
        targetId,
        channelId: input.channelId,
        queued: queuedIds.length,
        skipped: skipped.length,
      },
    );
    return { dispatchId: created.id, queued: queuedIds.length, skipped };
  }

  /** Alvos permitidos ao remetente: ADMIN vê todos os setores ativos; gestor, os seus. */
  async targets(actorId: string): Promise<TeamTargetsResponse> {
    const actor = await this.requireSender(actorId);
    const onlyIds = actor.role === 'ADMIN' ? null : actor.managedSectorIds;
    const [channels, sectors] = await Promise.all([
      this.repo.listEligibleChannels(),
      this.repo.listSectors(onlyIds),
    ]);
    const eligible = channels.flatMap(
      ({ provider, connectionEvents, ...rest }) =>
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
    return { channels: eligible, sectors };
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
      members: [user],
    };
  }

  /** Política (403) antes da seleção (422): `userIds` não abre outro setor. */
  private async resolveSector(
    actor: TeamActor,
    target: SectorTargetInput,
  ): Promise<ResolvedTarget> {
    const sector = await this.repo.findSectorWithActiveMembers(target.sectorId);
    if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
    // O repositório já filtra ativos; o filtro aqui protege contra um select mais largo.
    const active = sector.members.filter((m) => m.isActive);
    const members = selectMembers(active, target.shift, target.userIds);
    if (members === null) throw invalidSelection();
    const shift = target.shift ?? null;
    const selected = target.userIds ? members.length : null;
    return {
      targetType: 'SECTOR',
      targetId: sector.id,
      targetLabel: sectorTargetLabel(sector.name, shift, selected),
      shift,
      members,
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

  /** O contato carrega a grafia que o merge elegeu como a que entrega. */
  private async classify(
    members: readonly TeamMember[],
  ): Promise<NewTeamRecipient[]> {
    const recipients: NewTeamRecipient[] = [];
    for (const m of members) {
      const phone = m.contact?.phoneE164 ?? m.phoneE164;
      const base = { userId: m.id, userName: displayName(m), shift: m.shift };
      if (!phone) {
        recipients.push({ ...base, status: 'SKIPPED', skipReason: 'NO_PHONE' });
      } else if (await this.consent.isSuppressed(phone)) {
        recipients.push({
          ...base,
          status: 'SKIPPED',
          skipReason: 'SUPPRESSED',
        });
      } else {
        recipients.push({ ...base, status: 'QUEUED', skipReason: null });
      }
    }
    return recipients;
  }

  /** Sem fila não há envio: quem ficou QUEUED vira FAILED e o erro sobe (500). */
  private async enqueue(recipientIds: readonly string[]): Promise<void> {
    try {
      await this.queue.addBulk(
        recipientIds.map((id) => ({
          name: 'send',
          data: { recipientId: id },
          opts: { jobId: id },
        })),
      );
    } catch (err) {
      await this.repo.markFailed(recipientIds, QUEUE_UNAVAILABLE);
      throw err;
    }
  }
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
};

const zeroCounts = (): TeamDispatchCounts => ({
  queued: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
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
      shift: r.shift,
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
      shift: row.shift,
    },
    channel: row.channel,
    counts: counts ?? zeroCounts(),
    recipients,
  };
}
