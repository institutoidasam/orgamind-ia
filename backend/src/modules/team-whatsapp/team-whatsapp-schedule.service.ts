import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditService } from '../../shared/audit/audit.service';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import type {
  CancelTeamDispatchResponse,
  TeamScheduledListResponse,
} from '../../schemas/contracts/team-whatsapp.schema';
import { fromDbDate } from '../staff-schedule/civil-date';
import {
  canSendToSector,
  isTeamSender,
  type TeamActor,
} from './team-whatsapp.policy';
import {
  dispatchNotFound,
  notCancellable,
  teamForbidden,
} from './team-whatsapp.errors';
import {
  TeamWhatsappRepository,
  type ScheduledRow,
  type TeamDispatchForCancel,
} from './team-whatsapp.repository';
import { enqueueTeamSend, shiftSnapshotOf } from './team-whatsapp.service';

type ScheduledItem = TeamScheduledListResponse['items'][number];

/** Agendados vencidos por tick; o resto sai no tick seguinte. */
const DUE_BATCH = 50;

/**
 * Envios agendados para o início do turno (C9): lista, cancelamento e disparo.
 * O agendamento nasce no POST de envio (`TeamWhatsappService.dispatch`); o
 * disparo roda no tick do worker (T9, `TeamWhatsappSchedulerProcessor`). Cancela
 * o ADMIN, ou o gestor que pode enviar para o setor do envio (`canSendToSector`),
 * e só enquanto ainda está SCHEDULED.
 */
@Injectable()
export class TeamWhatsappScheduleService {
  private readonly logger = new Logger(TeamWhatsappScheduleService.name);

  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND)
    private readonly queue: Queue<TeamWhatsappSendJob>,
  ) {}

  /** Um envio que falha não para os outros: o erro vai para o log só com o id. */
  async fireDue(now: Date): Promise<{ fired: number }> {
    const due = await this.repo.findDueScheduled(now, DUE_BATCH);
    let fired = 0;
    for (const { id } of due) {
      try {
        if ((await this.fireOne(id, now)) === 'fired') fired++;
      } catch (err: unknown) {
        this.logger.error(
          { err, dispatchId: id },
          'Scheduled team WhatsApp fire failed',
        );
      }
    }
    return { fired };
  }

  /**
   * `skipped` = outro disparo ou o cancelamento venceu, ou ainda não é a hora.
   * Enfileira como o envio imediato (falha da fila → FAILED queue_unavailable e
   * o erro sobe). Auditoria com contagens, sem nomes nem texto (GC10).
   */
  async fireOne(dispatchId: string, now: Date): Promise<'fired' | 'skipped'> {
    const claim = await this.repo.claimScheduled(dispatchId, now);
    if (!claim) return 'skipped';
    if (claim.queuedIds.length > 0) {
      await enqueueTeamSend(this.queue, this.repo, claim.queuedIds);
    }
    await this.audit.log(
      'team_whatsapp.scheduled_fire',
      'TeamWhatsappDispatch',
      dispatchId,
      {
        dispatchId,
        queued: claim.queuedIds.length,
        skipped: claim.skipped,
        failed: claim.failed,
      },
    );
    return 'fired';
  }

  /** 404 → 403 → 409: a disputa com o disparo é decidida no `updateMany` condicional. */
  async cancel(
    actorId: string,
    dispatchId: string,
  ): Promise<CancelTeamDispatchResponse> {
    const actor = await this.requireSender(actorId);
    const dispatch = await this.repo.findDispatchForCancel(dispatchId);
    if (!dispatch) throw dispatchNotFound();
    await this.requireSectorOf(actor, dispatch);
    const cancelled = await this.repo.cancelScheduled(
      dispatch.id,
      actor.id,
      new Date(),
    );
    if (!cancelled) throw notCancellable();
    await this.audit.log(
      'team_whatsapp.cancel',
      'TeamWhatsappDispatch',
      dispatch.id,
      { actorId: actor.id, dispatchId: dispatch.id },
    );
    return { id: dispatch.id, state: 'CANCELLED' };
  }

  /** ADMIN vê todos os agendados; gestor, os dos setores que gerencia. */
  async listScheduled(actorId: string): Promise<TeamScheduledListResponse> {
    const actor = await this.requireSender(actorId);
    const rows = await this.repo.listScheduled(
      actor.role === 'ADMIN' ? null : actor.managedSectorIds,
    );
    return { items: rows.flatMap(toScheduledItem) };
  }

  private async requireSender(actorId: string): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    return actor;
  }

  /**
   * Só envio a setor é agendável; alvo pessoa não tem setor a conferir → 403.
   * O ADMIN cancela mesmo com o setor desativado depois do agendamento (senão
   * ninguém cancelaria); o gestor depende de `canSendToSector` (setor ativo).
   */
  private async requireSectorOf(
    actor: TeamActor,
    dispatch: TeamDispatchForCancel,
  ): Promise<void> {
    if (dispatch.targetType !== 'SECTOR') throw teamForbidden();
    if (actor.role === 'ADMIN') return;
    const sector = await this.repo.findSector(dispatch.targetId);
    if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
  }
}

/** Agendado sem snapshot do turno, data ou hora não é exibível: fica de fora. */
function toScheduledItem(row: ScheduledRow): ScheduledItem[] {
  const shift = shiftSnapshotOf(row);
  if (!shift || !row.scheduledFor || !row.rosterDate) return [];
  return [
    {
      id: row.id,
      scheduledFor: row.scheduledFor.toISOString(),
      rosterDate: fromDbDate(row.rosterDate),
      shift,
      label: row.targetLabel,
      recipientCount: row.recipientCount,
      channel: row.channel,
      author: row.author,
    },
  ];
}
