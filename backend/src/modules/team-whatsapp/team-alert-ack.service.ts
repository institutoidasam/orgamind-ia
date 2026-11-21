import { Injectable } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { requireViewable } from './team-alert-access';
import {
  isRecipientOf,
  markManualAck,
  undoManualAck,
} from './team-alert-manual-ack';
import { ackExists, ackNotManual } from './team-alert.errors';
import { requireUrgencyKey } from './team-alert.policy';
import { loadAlertHeader } from './team-alert.repository';
import { dispatchNotFound, teamForbidden } from './team-whatsapp.errors';
import { isTeamSender, type TeamActor } from './team-whatsapp.policy';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

/**
 * Ciência manual do alerta e o desfazer (I5, CI6). Recusas, nesta ordem (I5,
 * GI4): 403 remetente → 403 chave `equipe.urgencia` (antes de ler o envio,
 * inclusive alerta invisível) → 404 envio invisível ou destinatário de outro
 * envio → 422 `not_an_alert` → 422 `ack_exists`/`ack_not_manual`. As trilhas
 * levam só ids (e o resultado do desfazer): nunca observação, nome ou telefone.
 */
@Injectable()
export class TeamAlertAckService {
  constructor(
    private readonly repo: TeamWhatsappRepository,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async markManual(
    actorId: string,
    dispatchId: string,
    recipientId: string,
    input: { note: string; now: Date },
  ): Promise<void> {
    const actor = await this.requireAlertRecipient(
      actorId,
      dispatchId,
      recipientId,
    );
    const marked = await markManualAck(this.prisma, {
      dispatchId,
      recipientId,
      actorId: actor.id,
      note: input.note,
      now: input.now,
    });
    if (!marked) throw ackExists();
    await this.audit.log(
      'team_whatsapp.ack_manual',
      'TeamWhatsappRecipient',
      recipientId,
      { actorId: actor.id, dispatchId, recipientId },
    );
  }

  async undoManual(
    actorId: string,
    dispatchId: string,
    recipientId: string,
  ): Promise<void> {
    const actor = await this.requireAlertRecipient(
      actorId,
      dispatchId,
      recipientId,
    );
    const result = await undoManualAck(this.prisma, {
      dispatchId,
      recipientId,
    });
    if (!result) throw ackNotManual();
    await this.audit.log(
      'team_whatsapp.ack_manual_undo',
      'TeamWhatsappRecipient',
      recipientId,
      { actorId: actor.id, dispatchId, recipientId, result },
    );
  }

  /** 403 → 403 chave → 404 envio → 404 destinatário → 422 `not_an_alert`. */
  private async requireAlertRecipient(
    actorId: string,
    dispatchId: string,
    recipientId: string,
  ): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !isTeamSender(actor)) throw teamForbidden();
    requireUrgencyKey(actor);
    await requireViewable(this.repo, actor, dispatchId);
    const ref = { dispatchId, recipientId };
    if (!(await isRecipientOf(this.prisma, ref))) throw dispatchNotFound();
    await loadAlertHeader(this.prisma, dispatchId);
    return actor;
  }
}
