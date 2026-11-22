import { Injectable, Logger } from '@nestjs/common';
import type {
  HandoverSkipReason,
  ShiftHandoverInput,
  ShiftHandoverResult,
} from '../../schemas/contracts/chat.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { NotFoundError } from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatEventsService } from './chat-events.service';
import {
  canHandoverFrom,
  handoverChange,
  handoverSkipReason,
} from './conversation-handover.rules';
import { notAssignee } from './conversation-ownership.errors';
import {
  applyOwnershipChange,
  findEligibleAssignee,
  lockConversation,
  runOwnershipTransaction,
  type ChatActor,
} from './conversation-ownership.repository';

type ItemOutcome =
  { skipped: HandoverSkipReason } | { transferred: true; instanceId: string };

type ItemContext = {
  actorId: string;
  fromId: string;
  toId: string;
  note: string;
  now: Date;
};

/**
 * Passagem de turno das conversas (K3-1/K3-2, DT2): transfere em série, cada
 * conversa numa transação curta própria, com a conferência "ainda aberta e
 * ainda com quem sai" sob a trava da linha. Não envia mensagem a ninguém
 * (K3-5) e nunca retoma o robô (K3-7 b).
 */
@Injectable()
export class ConversationHandoverService {
  private readonly logger = new Logger(ConversationHandoverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: ChatEventsService,
  ) {}

  /**
   * Ordem (DT2): 403 `chat.not_assignee` (só o ADMIN passa as de outro) → 404
   * `user.not_found` do destino (ADMIN/OPERATOR ativo e com acesso, e diferente
   * de quem sai), para o pedido inteiro → itens em série, na ordem do pedido.
   */
  async handover(
    actor: ChatActor,
    input: ShiftHandoverInput,
    now: Date,
  ): Promise<ShiftHandoverResult> {
    const fromId = input.fromUserId ?? actor.id;
    if (!canHandoverFrom(actor, fromId)) throw notAssignee();
    const toId = input.toUserId;
    if (toId === fromId || !(await findEligibleAssignee(this.prisma, toId))) {
      throw new NotFoundError('User', toId);
    }
    const ctx = { actorId: actor.id, fromId, toId, note: input.note, now };
    const result: ShiftHandoverResult = { transferred: [], skipped: [] };
    for (const id of input.conversationIds) {
      const outcome = await this.handoverOne(id, ctx);
      if ('skipped' in outcome) {
        result.skipped.push({ id, reason: outcome.skipped });
        continue;
      }
      result.transferred.push({ id });
      await this.publishUpdated(id, outcome.instanceId);
    }
    return result;
  }

  /**
   * Uma conversa, uma transação: trava, decide sobre a linha travada (só a
   * `NotFoundError` da trava vira pulo; o resto relança e desfaz) e grava.
   */
  private handoverOne(id: string, ctx: ItemContext): Promise<ItemOutcome> {
    return runOwnershipTransaction(this.prisma, async (tx) => {
      const locked = await lockConversation(tx, id).catch((error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      });
      if (!locked) return { skipped: 'not_found' };
      const reason = handoverSkipReason(locked, ctx.fromId, ctx.toId);
      if (reason) return { skipped: reason };
      await applyOwnershipChange(
        tx,
        this.audit,
        handoverChange(locked, {
          actorId: ctx.actorId,
          toId: ctx.toId,
          note: ctx.note,
          now: ctx.now,
        }),
      );
      return { transferred: true, instanceId: locked.instanceId };
    });
  }

  /** K1-10: depois do commit da conversa; falha do evento não desfaz nem interrompe o lote (só ids no log). */
  private async publishUpdated(
    conversationId: string,
    instanceId: string,
  ): Promise<void> {
    try {
      await this.events.publish({
        type: 'conversation.updated',
        conversationId,
        instanceId,
      });
    } catch (error) {
      const errName = error instanceof Error ? error.name : 'unknown';
      this.logger.warn({ conversationId, errName }, 'handover event failed');
    }
  }
}
