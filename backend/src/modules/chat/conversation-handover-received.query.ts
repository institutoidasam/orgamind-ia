import type { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * K3-3/DT3: ids das conversas abertas que `userId` atende e cuja última mudança
 * de atendente foi uma passagem de turno. `assignedAt` só é regravado quando o
 * atendente muda, com o mesmo `now` que vira o `createdAt` das linhas daquela
 * ação; então "a última mudança foi a passagem" é a igualdade
 * `h."createdAt" = c."assignedAt"` (sem depender da ordem de linhas com o mesmo
 * `createdAt`). `ASSUMED_ON_REPLY`, `TRANSFERRED` e `ASSUMED` também regravam
 * `assignedAt`, então a conversa sai da lista quando uma delas vem depois.
 */
export async function findHandoverReceivedIds(
  db: Pick<PrismaService, '$queryRaw'>,
  userId: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c."id"
    FROM "Conversation" c
    JOIN "ConversationHistoryEntry" h ON h."conversationId" = c."id"
    WHERE c."assignedUserId" = ${userId}
      AND c."resolvedAt" IS NULL
      AND c."archivedAt" IS NULL
      AND h."action" = 'SHIFT_HANDOVER'
      AND h."toUserId" = c."assignedUserId"
      AND h."createdAt" = c."assignedAt"`;
  return rows.map((row) => row.id);
}
