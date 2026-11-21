import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  AssignConversationInput,
  ChatAssigneesResponse,
  ConversationHistoryResponse,
  ConversationSummary,
  ReopenConversationInput,
  ResolveConversationInput,
} from '../../schemas/contracts/chat.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { NotFoundError } from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatEventsService } from './chat-events.service';
import { ChatRepository } from './chat.repository';
import {
  assignChange,
  assignHasNoEffect,
  assignKind,
  canAssign,
} from './conversation-assign.rules';
import { claimForReply } from './conversation-claim';
import {
  conversationChanged,
  notAssignee,
} from './conversation-ownership.errors';
import {
  applyOwnershipChange,
  findAssigneeRef,
  findEligibleAssignee,
  listConversationHistory,
  listEligibleAssignees,
  lockConversation,
  runOwnershipTransaction,
  type ChatActor,
  type LockedConversation,
  type OwnershipChange,
} from './conversation-ownership.repository';
import {
  canResolve,
  resolveStateChanged,
} from './conversation-ownership.rules';
import {
  conversationSummaryInclude,
  toConversationSummary,
} from './conversation-summary.mapper';

/**
 * Decide, sob a trava da linha, o que gravar; lança o 403/409 se o estado não
 * serve. `null` = o pedido já é o estado: nada gravado, nenhum evento.
 */
type ChangePlan = (
  tx: Prisma.TransactionClient,
  locked: LockedConversation,
) => Promise<OwnershipChange | null>;

/** Atendente atual da linha travada, para o `detail` dos 409 (DK14). */
function currentAssignee(
  tx: Prisma.TransactionClient,
  locked: LockedConversation,
) {
  return locked.assignedUserId
    ? findAssigneeRef(tx, locked.assignedUserId)
    : Promise.resolve(null);
}

/**
 * Propriedade da conversa (K1): leituras e comandos com gravação condicional
 * (resolver, reabrir, atribuir). Todo comando passa por `command`.
 */
@Injectable()
export class ConversationOwnershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: ChatEventsService,
    private readonly repo: ChatRepository,
  ) {}

  /** DK13: 200 linhas mais recentes; conversa inexistente → 404. */
  async history(conversationId: string): Promise<ConversationHistoryResponse> {
    if (!(await this.repo.conversationExists(conversationId))) {
      throw new NotFoundError('Conversation', conversationId);
    }
    return listConversationHistory(this.prisma, conversationId);
  }

  /** DK13: destinos possíveis (ADMIN e OPERATOR ativos e com acesso). */
  async assignees(): Promise<ChatAssigneesResponse> {
    return { items: await listEligibleAssignees(this.prisma) };
  }

  /**
   * DK5 (K1-3): o atendente que a tela mostrava ou um ADMIN resolve, se a linha
   * travada ainda é a que a tela mostrava; o atendente sai da conversa.
   * Não toca `botPausedAt` (K1-7).
   */
  resolve(
    id: string,
    actor: ChatActor,
    input: ResolveConversationInput,
  ): Promise<ConversationSummary> {
    return this.command(id, async (tx, locked) => {
      if (!canResolve(actor, input.expectedAssigneeId)) throw notAssignee();
      if (resolveStateChanged(locked, input)) {
        throw conversationChanged(await currentAssignee(tx, locked));
      }
      return {
        conversation: locked,
        actorId: actor.id,
        assignedUserId: null,
        resolved: true,
        actions: ['RESOLVED'],
        note: input.note || null,
        pauseBot: false,
        now: new Date(),
      };
    });
  }

  /** DK8 (K1-4): reabre uma resolvida (volta a Pendente); aberta → 409. Não toca atendente nem robô. */
  reopen(
    id: string,
    actor: ChatActor,
    input: ReopenConversationInput,
  ): Promise<ConversationSummary> {
    return this.command(id, async (tx, locked) => {
      if (locked.resolvedAt === null) {
        throw conversationChanged(await currentAssignee(tx, locked));
      }
      return {
        conversation: locked,
        actorId: actor.id,
        assignedUserId: locked.assignedUserId,
        resolved: false,
        actions: ['REOPENED'],
        note: input.note || null,
        pauseBot: false,
        now: new Date(),
      };
    });
  }

  /**
   * DK6 (K1-7): assumir (para si), transferir (a outra pessoa) ou remover o
   * atendente. Ordem: destino elegível (404 `user.not_found`, antes de travar)
   * → trava/404 da conversa → 403 → 409 → sem efeito (200, nada gravado) →
   * grava. Assumir e transferir pausam o robô e reabrem a resolvida.
   */
  async assign(
    id: string,
    actor: ChatActor,
    input: AssignConversationInput,
  ): Promise<ConversationSummary> {
    const { userId, expectedAssigneeId } = input;
    if (userId !== null && !(await findEligibleAssignee(this.prisma, userId))) {
      throw new NotFoundError('User', userId);
    }
    const kind = assignKind(actor.id, userId);
    return this.command(id, async (tx, locked) => {
      if (!canAssign(actor, kind, expectedAssigneeId)) throw notAssignee();
      if (locked.assignedUserId !== expectedAssigneeId) {
        throw conversationChanged(await currentAssignee(tx, locked));
      }
      if (assignHasNoEffect(locked, kind, userId)) return null;
      return assignChange(locked, kind, {
        actorId: actor.id,
        userId,
        note: input.note || null,
        now: new Date(),
      });
    });
  }

  /**
   * K1-5/DK10: a reivindicação da resposta (texto e mídia); a regra fica em
   * `claimForReply` (conversation-claim.ts), aqui só a injeção das dependências.
   */
  claimForReply(
    conversationId: string,
    actorId: string,
  ): Promise<{ changed: boolean }> {
    return claimForReply(
      { prisma: this.prisma, audit: this.audit, events: this.events },
      conversationId,
      actorId,
    );
  }

  /**
   * DK4: trava a linha (404 se ausente), deixa `plan` conferir o estado e
   * decidir a mudança, grava tudo no mesmo `tx` e só depois do commit publica
   * `conversation.updated` (K1-10). Devolve o resumo lido no mesmo `tx`.
   */
  private async command(
    id: string,
    plan: ChangePlan,
  ): Promise<ConversationSummary> {
    const { instanceId, summary, changed } = await runOwnershipTransaction(
      this.prisma,
      async (tx) => {
        const locked = await lockConversation(tx, id);
        const change = await plan(tx, locked);
        if (change) await applyOwnershipChange(tx, this.audit, change);
        const row = await tx.conversation.findUniqueOrThrow({
          where: { id },
          include: conversationSummaryInclude,
        });
        return {
          instanceId: locked.instanceId,
          summary: toConversationSummary(row),
          changed: change !== null,
        };
      },
    );
    if (changed) {
      await this.events.publish({
        type: 'conversation.updated',
        conversationId: id,
        instanceId,
      });
    }
    return summary;
  }
}
