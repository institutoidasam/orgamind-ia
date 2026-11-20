import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditService } from '../../shared/audit/audit.service';
import { nameView } from '../../shared/authz/phone-visibility';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import type {
  CancelTeamDispatchResponse,
  TeamScheduledListResponse,
} from '../../schemas/contracts/team-whatsapp.schema';
import { fromDbDate } from '../staff-schedule/civil-date';
import type { PageQuery } from './dto/page-query.dto';
import { authorView, seesFullPhone } from './team-whatsapp.name-view';
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
  type RecheckSummary,
  type ScheduledRow,
  type TeamDispatchForCancel,
} from './team-whatsapp.repository';
import { recheckAudience } from './scheduled-recheck.runner';
import { enqueueTeamSend, shiftSnapshotOf } from './team-whatsapp.service';

type ScheduledItem = TeamScheduledListResponse['items'][number];

/** Agendados vencidos por tick; o resto sai no tick seguinte. */
const DUE_BATCH = 50;

/**
 * Envios agendados para o início do turno (C9): lista, cancelamento e disparo.
 * O agendamento nasce no POST de envio (`TeamWhatsappService.dispatch`); o
 * disparo roda no tick do worker (T9, `TeamWhatsappSchedulerProcessor`). Cancela
 * o ADMIN, ou o gestor que pode enviar para TODOS os setores do envio
 * (`canSendToSector`, C7), e só enquanto ainda está SCHEDULED.
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

  /**
   * Um envio que falha (inclusive na reconferência) não para os outros: o erro
   * vai para o log só com o id, e o envio segue SCHEDULED para o tick seguinte.
   * Só `'fired'` conta; vencido e pulado, não.
   */
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
   * Claim com a reconferência (DG2/DG5): a função fecha sobre o `now` do tick e
   * só roda para quem venceu o claim; se ela lança, nada sai e o envio segue
   * SCHEDULED. Sem claim, tenta o vencimento (passou de 2 h → `expired`);
   * `skipped` = outro disparo ou o cancelamento venceu, ou ainda não é a hora.
   * Enfileira como o envio imediato (falha da fila → FAILED queue_unavailable e
   * o erro sobe). Trilhas com ids e contagens, sem nomes, telefone nem texto (GG8).
   */
  async fireOne(
    dispatchId: string,
    now: Date,
  ): Promise<'fired' | 'expired' | 'skipped'> {
    const claim = await this.repo.claimScheduled(dispatchId, now, (claimed) =>
      recheckAudience(this.repo, claimed, now),
    );
    if (!claim) return this.expire(dispatchId, now);
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
        ...recheckTrailOf(claim.rechecked),
      },
    );
    return 'fired';
  }

  /** Vencimento (DG5): agendado que passou do teto vira EXPIRED; trilha só com ids e contagens. */
  private async expire(
    dispatchId: string,
    now: Date,
  ): Promise<'expired' | 'skipped'> {
    const expired = await this.repo.expireScheduled(dispatchId, now);
    if (!expired) return 'skipped';
    await this.audit.log(
      'team_whatsapp.scheduled_expired',
      'TeamWhatsappDispatch',
      dispatchId,
      { dispatchId, skipped: expired.skipped },
    );
    return 'expired';
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

  /** Uma página: ADMIN vê todos os agendados; gestor, os que têm todos os setores entre os seus (C7). */
  async listScheduled(
    actorId: string,
    page: PageQuery,
  ): Promise<TeamScheduledListResponse> {
    const actor = await this.requireSender(actorId);
    const { rows, total } = await this.repo.listScheduled(
      actor.role === 'ADMIN' ? null : actor.managedSectorIds,
      page,
    );
    const full = seesFullPhone(actor);
    return {
      items: rows.flatMap((row) => toScheduledItem(row, full)),
      total,
      ...page,
    };
  }

  private async requireSender(actorId: string): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    return actor;
  }

  /**
   * Só envio a setor é agendável; alvo pessoa não tem setor a conferir → 403.
   * O ADMIN cancela mesmo com o setor desativado depois do agendamento (senão
   * ninguém cancelaria); o gestor depende de `canSendToSector` (setor ativo) em
   * CADA setor do envio (C7). Envio a setor sem linha de setor → 403 (o backfill
   * dá uma linha a todo envio a setor; "todos" de uma lista vazia não autoriza).
   */
  private async requireSectorOf(
    actor: TeamActor,
    dispatch: TeamDispatchForCancel,
  ): Promise<void> {
    if (dispatch.targetType !== 'SECTOR') throw teamForbidden();
    if (actor.role === 'ADMIN') return;
    if (dispatch.sectorIds.length === 0) throw teamForbidden();
    for (const sectorId of dispatch.sectorIds) {
      const sector = await this.repo.findSector(sectorId);
      if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
    }
  }
}

/** Política e contagens da reconferência na trilha do disparo; regra antiga = `policy` nulo. */
function recheckTrailOf(rechecked: RecheckSummary | null | undefined) {
  return {
    policy: rechecked ? ('frozen_recheck' as const) : null,
    recheckSkipped: rechecked?.skipped ?? 0,
    lateJoined: rechecked?.lateJoined ?? 0,
  };
}

/**
 * Agendado sem data ou hora não é exibível: fica de fora. Sem snapshot do turno
 * ("data e hora" com vários ou todos os turnos) vai com `shift: null`, para
 * aparecer na lista e poder ser cancelado (G1/G3).
 */
function toScheduledItem(row: ScheduledRow, full: boolean): ScheduledItem[] {
  if (!row.scheduledFor || !row.rosterDate) return [];
  return [
    {
      id: row.id,
      scheduledFor: row.scheduledFor.toISOString(),
      rosterDate: fromDbDate(row.rosterDate),
      shift: shiftSnapshotOf(row),
      label: nameView(row.targetLabel, { full }),
      recipientCount: row.recipientCount,
      channel: row.channel,
      author: authorView(row.author, full),
    },
  ];
}
