import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  lockConversation,
  runOwnershipTransaction,
} from './conversation-ownership.repository';

/** CK6: a atualização final da ingestão de uma mensagem (resumo, janela, não lidas). */
export type InboundUpdate = {
  conversationId: string;
  data: Prisma.ConversationUpdateInput;
  /** `isInbound && !backfill`: só a mensagem da pessoa, ao vivo, reabre (K1-4). */
  reopenIfResolved: boolean;
};

/**
 * DK9/K1-4: grava `data` na conversa e, se a mensagem é da pessoa e ao vivo e a
 * conversa estava resolvida, reabre-a ("Sistema": `actorId` nulo) no MESMO
 * `UPDATE` que avança `lastInboundAt`.
 *
 * Sem `reopenIfResolved` é o `conversation.update` simples de sempre
 * (importação de histórico e eco de mensagem enviada nunca reabrem). Com ele, a
 * linha é travada (`FOR NO KEY UPDATE`, a mesma trava do "Resolver"): ou o
 * "Resolver" grava antes e a ingestão encontra a conversa resolvida e a reabre,
 * ou grava depois e vê o `lastInboundAt` novo (409). A mensagem nunca fica numa
 * conversa resolvida. Não toca `botPausedAt` (K1-7) e não grava trilha: a
 * resolvida não tem atendente, então nada de `conversation.assign`.
 *
 * O evento `conversation.updated` é de quem chama, depois do commit.
 */
export async function applyInboundUpdate(
  prisma: PrismaService,
  args: InboundUpdate,
): Promise<{ reopened: boolean }> {
  const { conversationId, data, reopenIfResolved } = args;
  if (!reopenIfResolved) {
    await prisma.conversation.update({ where: { id: conversationId }, data });
    return { reopened: false };
  }
  return runOwnershipTransaction(prisma, async (tx) => {
    const locked = await lockConversation(tx, conversationId);
    const reopened = locked.resolvedAt !== null;
    await tx.conversation.update({
      where: { id: conversationId },
      data: reopened ? { ...data, resolvedAt: null } : data,
    });
    if (reopened) {
      await tx.conversationHistoryEntry.create({
        data: {
          conversationId,
          action: 'REOPENED',
          actorId: null,
          createdAt: new Date(),
        },
      });
    }
    return { reopened };
  });
}
