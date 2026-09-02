import type { Prisma } from '@prisma/client';
import type { ConversationSummary } from '../../schemas/contracts/chat.schema';
import { sessionWindowExpiresAt } from './session-window';

/**
 * The Prisma `include` shared by every query that maps to a ConversationSummary
 * (ChatService.getConversation and ChatRepository.listConversations). Typing the
 * include here lets toConversationSummary() take a precisely-typed row instead of
 * `any`, so the relation accesses (contact/instance/assignedUser) are checked.
 */
export const conversationSummaryInclude = {
  contact: { select: { name: true } },
  // `provider` is a plain scalar select on the already-joined instance row —
  // no extra query (see toConversationSummary's `provider` mapping below).
  instance: { select: { name: true, botId: true, provider: true, bot: { select: { id: true, name: true } } } },
  assignedUser: { select: { name: true } },
} as const satisfies Prisma.ConversationInclude;

/** A Conversation row joined with exactly the relations declared above. */
export type ConversationSummaryRow = Prisma.ConversationGetPayload<{
  include: typeof conversationSummaryInclude;
}>;

/**
 * Maps a joined Conversation row to the API ConversationSummary shape. Single
 * source of truth for the display-name fallback chain, ISO date coercion and
 * null-coalesced relation fields — shared by getConversation and
 * listConversations so the two can never drift.
 */
export function toConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    instanceId: row.instanceId,
    instanceName: row.instance?.name ?? '',
    // Channel.provider defaults to EVOLUTION in Prisma; mirror that fallback
    // here for the (theoretical) case of a missing/unjoined instance.
    provider: row.instance?.provider ?? 'EVOLUTION',
    remoteJid: row.remoteJid,
    phoneE164: row.phoneE164,
    contactId: row.contactId,
    displayName: row.contact?.name ?? row.waName ?? row.phoneE164 ?? 'Número desconhecido',
    waName: row.waName,
    profilePicUrl: row.profilePicUrl,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageDirection: row.lastMessageDirection,
    unreadCount: row.unreadCount,
    assignedUserId: row.assignedUserId ?? null,
    assignedUserName: row.assignedUser?.name ?? null,
    botId: row.instance?.botId ?? null,
    botName: row.instance?.bot?.name ?? null,
    botPaused: row.botPausedAt !== null,
    // Janela de atendimento de 24h: canais com janela de sessão da Meta
    // (TWILIO **e** ZERNIO — ver session-window.ts) com inbound registrado.
    // lastInboundAt + 24h em ISO; pode estar no passado (janela fechada).
    // O NOME do campo continua `twilioWindowExpiresAt` por compatibilidade de
    // contrato com a UI e os specs — a SEMÂNTICA é "janela de sessão", não
    // "janela da Twilio". Renomear é um PR à parte.
    twilioWindowExpiresAt:
      sessionWindowExpiresAt(
        row.instance?.provider,
        row.lastInboundAt,
      )?.toISOString() ?? null,
  };
}
