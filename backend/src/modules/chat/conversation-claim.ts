import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { ChatEventsService } from './chat-events.service';
import { assignedToOther } from './conversation-ownership.errors';
import {
  applyOwnershipChange,
  findAssigneeRef,
  lockConversation,
  runOwnershipTransaction,
  type LockedConversation,
  type OwnershipChange,
} from './conversation-ownership.repository';

export type ClaimDeps = {
  prisma: PrismaService;
  audit: AuditService;
  events: ChatEventsService;
};

/**
 * K1-5/DK10: quem responde assume a conversa. Sem atendente (aberta ou
 * resolvida) o ator passa a ser o atendente, a conversa reabre se preciso e o
 * robô pausa; a conversa dele segue sem gravar nada.
 */
function claimChange(
  locked: LockedConversation,
  actorId: string,
): OwnershipChange {
  return {
    conversation: locked,
    actorId,
    assignedUserId: actorId,
    resolved: false,
    actions: locked.resolvedAt
      ? ['REOPENED', 'ASSUMED_ON_REPLY']
      : ['ASSUMED_ON_REPLY'],
    note: null,
    pauseBot: true,
    now: new Date(),
  };
}

/**
 * K1-5/DK10: a reivindicação da resposta, para todos (inclusive o ADMIN), no
 * texto e na mídia. Roda depois das conferências de canal e de janela e antes
 * de gravar a mensagem ou o arquivo. A decisão é tomada na linha travada
 * (`FOR NO KEY UPDATE`), numa transação só com a gravação:
 *  - com o ator e aberta: nada a gravar (`changed: false`);
 *  - sem atendente, ou resolvida: grava como o núcleo (conversa, histórico,
 *    trilha) e publica `conversation.updated` só depois do commit;
 *  - com outro: 409 `chat.assigned_to_other` e nada é gravado.
 * A atribuição permanece mesmo que o envio ao provedor falhe. A trava é solta
 * no commit, antes do INSERT da `Message` (janela residual aceita, DK10/M5).
 */
export async function claimForReply(
  deps: ClaimDeps,
  conversationId: string,
  actorId: string,
): Promise<{ changed: boolean }> {
  const { instanceId, changed } = await runOwnershipTransaction(
    deps.prisma,
    async (tx) => {
      const locked = await lockConversation(tx, conversationId);
      const owner = locked.assignedUserId;
      if (owner !== null && owner !== actorId) {
        const ref = await findAssigneeRef(tx, owner);
        throw assignedToOther(ref ?? { id: owner, name: '', active: false });
      }
      if (owner === actorId && locked.resolvedAt === null) {
        return { instanceId: locked.instanceId, changed: false };
      }
      await applyOwnershipChange(tx, deps.audit, claimChange(locked, actorId));
      return { instanceId: locked.instanceId, changed: true };
    },
  );
  if (changed) {
    await deps.events.publish({
      type: 'conversation.updated',
      conversationId,
      instanceId,
    });
  }
  return { changed };
}
