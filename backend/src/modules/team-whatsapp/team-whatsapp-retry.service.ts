import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditService } from '../../shared/audit/audit.service';
import {
  QUEUE_NAMES,
  type TeamWhatsappSendJob,
} from '../queue/queue.constants';
import type { RetryTeamDispatchResponse } from '../../schemas/contracts/team-whatsapp.schema';
import type { RetryRecipientsInput } from './dto/retry-recipients.dto';
import { dispatchNotFound, teamForbidden } from './team-whatsapp.errors';
import { requireAreaOf } from './team-dispatch-area';
import { canViewDispatch, isTeamSender } from './team-whatsapp.policy';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { enqueueTeamRetry } from './team-whatsapp.service';

/**
 * "Repetir" (C6/D12): põe de volta na fila as falhas certas de um envio. Quem
 * repete é quem vê o envio no histórico e pode enviar àquela área; a ordem é
 * remetente (403) → envio visível (404) → área (403) → troca atômica → fila. Só
 * depois da autorização o banco é tocado. A garantia contra duplicata não está
 * aqui: está na troca (`requeueFailed`) e no jobId novo de cada repetição.
 */
@Injectable()
export class TeamWhatsappRetryService {
  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND)
    private readonly queue: Queue<TeamWhatsappSendJob>,
  ) {}

  async retry(
    actorId: string,
    dispatchId: string,
    input: RetryRecipientsInput,
  ): Promise<RetryTeamDispatchResponse> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    const dispatch = await this.repo.findDispatchForActor(dispatchId);
    if (!dispatch || !canViewDispatch(actor, dispatch)) {
      throw dispatchNotFound();
    }
    await requireAreaOf(this.repo, actor, dispatch);
    const refs = await this.repo.requeueFailed(
      dispatch.id,
      'all' in input ? 'all' : input.recipientIds,
    );
    if (refs.length === 0) return { requeued: 0 };
    await enqueueTeamRetry(this.queue, this.repo, refs);
    // Auditoria só com ids e contagem (GC8): sem nome, telefone nem texto.
    await this.audit.log(
      'team_whatsapp.retry',
      'TeamWhatsappDispatch',
      dispatch.id,
      { actorId: actor.id, dispatchId: dispatch.id, requeued: refs.length },
    );
    return { requeued: refs.length };
  }
}
