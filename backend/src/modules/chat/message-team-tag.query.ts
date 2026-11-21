import type { TeamDispatchPurpose } from '@prisma/client';
import type { ChatMessageTeamTag } from '../../schemas/contracts/chat.schema';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { fromDbPurpose } from '../team-whatsapp/team-whatsapp.purpose-codes';

type TagRow = {
  messageId: string | null;
  lastReplyMessageId: string | null;
  ackMessageId: string | null;
  purpose: TeamDispatchPurpose | null;
  isReminder: boolean;
  isAlert: boolean;
  sentAt: Date;
};

/**
 * Uma consulta por página (K3-6, DT6). Entra pela conversa (`m."conversationId"` +
 * `@@index([messageId])` do destinatário): a mensagem do envio tem de ser desta
 * conversa, e só então se confere se a página casa com `messageId`,
 * `lastReplyMessageId` ou `ackMessageId`. Nunca varre os destinatários por
 * `lastReplyMessageId`/`ackMessageId` (sem índice). Devolve só o que a etiqueta
 * usa: finalidade, se é lembrete/alerta e a data real do envio.
 */
async function queryTagRows(
  db: Pick<PrismaService, '$queryRaw'>,
  conversationId: string,
  ids: string[],
): Promise<TagRow[]> {
  return db.$queryRaw<TagRow[]>`
    SELECT r."messageId", r."lastReplyMessageId", r."ackMessageId",
           d."purpose"::text AS "purpose",
           (d."parentDispatchId" IS NOT NULL) AS "isReminder",
           (d."ackDeadlineMinutes" IS NOT NULL) AS "isAlert",
           COALESCE(d."firedAt", d."createdAt") AS "sentAt"
    FROM "TeamWhatsappRecipient" r
    JOIN "Message" m ON m."id" = r."messageId"
    JOIN "TeamWhatsappDispatch" d ON d."id" = r."dispatchId"
    WHERE m."conversationId" = ${conversationId}
      AND (r."messageId" = ANY(${ids}::text[])
        OR r."lastReplyMessageId" = ANY(${ids}::text[])
        OR r."ackMessageId" = ANY(${ids}::text[]))
    ORDER BY "sentAt" ASC, d."id" ASC, r."id" ASC`;
}

function sentTag(row: TagRow): ChatMessageTeamTag {
  if (row.isReminder) return { kind: 'reminder' };
  return {
    kind: 'dispatch',
    purpose: fromDbPurpose(row.purpose),
    sentAt: row.sentAt.toISOString(),
  };
}

/**
 * Etiqueta de envio da equipe por mensagem da página (K3-6). Mensagem enviada de
 * um envio: `dispatch` (ou `reminder`). Mensagem recebida registrada como resposta
 * ou ciência de um ALERTA: `alert_reply`; se casa com mais de um alerta, vale o
 * mais novo (linhas em ordem crescente de data; a última sobrescreve). Mensagem
 * sem etiqueta não entra no mapa.
 */
export async function findTeamDispatchTags(
  db: Pick<PrismaService, '$queryRaw'>,
  conversationId: string,
  messageIds: readonly string[],
): Promise<Map<string, ChatMessageTeamTag>> {
  if (messageIds.length === 0) return new Map();
  const page = new Set(messageIds);
  const rows = await queryTagRows(db, conversationId, [...page]);
  const sent = new Map<string, ChatMessageTeamTag>();
  const replies = new Map<string, ChatMessageTeamTag>();
  for (const row of rows) {
    if (row.messageId && page.has(row.messageId)) {
      sent.set(row.messageId, sentTag(row));
    }
    if (!row.isAlert) continue;
    const reply: ChatMessageTeamTag = {
      kind: 'alert_reply',
      alertSentAt: row.sentAt.toISOString(),
    };
    for (const id of [row.lastReplyMessageId, row.ackMessageId]) {
      if (id && page.has(id)) replies.set(id, reply);
    }
  }
  return new Map([...replies, ...sent]);
}
