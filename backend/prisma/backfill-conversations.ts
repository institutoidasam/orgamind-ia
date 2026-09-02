import { PrismaClient, MessageDirection } from '@prisma/client';
import {
  jidFromPhone,
  resolveConversationForOutbound,
} from '../src/modules/chat/resolve-conversation';

const prisma = new PrismaClient();

/** "+5592999999999" -> "5592999999999@s.whatsapp.net" */
export const remoteJidFromPhone = jidFromPhone;

/**
 * One-shot backfill: every existing Message belongs to a campaign and has a
 * contact + instance. Attach each message to that contact's Conversation on the
 * channel as OUTBOUND, with createdAt = queuedAt to preserve timeline order.
 * Idempotent: re-running skips messages already linked.
 *
 * DUAS REGRAS que este script violava — e que produzem EXATAMENTE o sintoma
 * relatado em produção (bolha muda na thread + linha da conversa sem preview e
 * sem horário):
 *
 * 1. RESOLVER a conversa, não FABRICÁ-LA. O remoteJid é do provedor (forma
 *    legada BR de 8 dígitos, @lid do Evolution): montar `${digits}@s.whatsapp.net`
 *    cria uma SEGUNDA conversa para a mesma pessoa. Usa o mesmo resolvedor do
 *    caminho de envio (resolve-conversation.ts).
 * 2. Ligar a mensagem NÃO BASTA: a lista lateral lê o resumo denormalizado da
 *    Conversation (lastMessageAt / lastMessagePreview / lastMessageDirection).
 *    Sem avançá-lo, a conversa fica muda e afundada no fim da lista.
 */
export async function backfillConversations(db: PrismaClient = prisma): Promise<{ conversations: number; messages: number }> {
  const messages = await db.message.findMany({
    where: { conversationId: null, contactId: { not: null } },
    select: {
      id: true, contactId: true, instanceId: true, queuedAt: true,
      contact: { select: { phoneE164: true } },
    },
    orderBy: { queuedAt: 'asc' },
  });

  const convCache = new Map<string, string>(); // `${instanceId}:${contactId}` -> conversationId
  const touched = new Set<string>();
  let conversations = 0;
  let linked = 0;

  for (const m of messages) {
    if (!m.contactId || !m.contact) continue;
    const key = `${m.instanceId}:${m.contactId}`;
    let conversationId = convCache.get(key);
    if (!conversationId) {
      const conv = await resolveConversationForOutbound(db, {
        instanceId: m.instanceId,
        contactId: m.contactId,
        phoneE164: m.contact.phoneE164,
      });
      conversationId = conv.id;
      convCache.set(key, conversationId);
      conversations += 1;
    }
    await db.message.update({
      where: { id: m.id },
      data: { conversationId, direction: MessageDirection.OUTBOUND, createdAt: m.queuedAt },
    });
    touched.add(conversationId);
    linked += 1;
  }

  for (const conversationId of touched) {
    await refreshConversationSummary(db, conversationId);
  }

  return { conversations, messages: linked };
}

/**
 * Recalcula o resumo denormalizado a partir da mensagem mais recente da conversa
 * — é ele, e não a Message, que a lista lateral do Inbox lê. Monotônico: só
 * avança, nunca puxa a conversa para o passado por cima de algo mais novo.
 */
export async function refreshConversationSummary(
  db: PrismaClient,
  conversationId: string,
): Promise<void> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { lastMessageAt: true },
  });
  if (!conv) return;
  const latest = await db.message.findFirst({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, content: true, direction: true },
  });
  if (!latest) return;
  if (conv.lastMessageAt && conv.lastMessageAt > latest.createdAt) return;
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: latest.createdAt,
      lastMessagePreview: latest.content?.slice(0, 120) ?? null,
      lastMessageDirection: latest.direction,
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillConversations()
    .then((r) => console.log(`Backfill ok: ${r.conversations} conversations, ${r.messages} messages linked`))
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
