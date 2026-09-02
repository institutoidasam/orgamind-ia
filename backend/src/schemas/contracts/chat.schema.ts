import { z } from 'zod';
import { channelProviderEnum, type ChannelProviderContract } from './channel-provider.schema';

export const listConversationsQuerySchema = z.object({
  filter: z.enum(['all', 'unread', 'awaiting']).default('all'),
  search: z.string().optional(),
  instanceId: z.string().optional(),
  // Assignee filter: special values 'me' (resolved to the caller in the service)
  // and 'unassigned' (assignedUserId is null), otherwise a concrete userId.
  assignee: z.string().optional(),
  // Provider filter (multi-provider channels — F4b). Applied server-side
  // (where.instance.provider in the repository) BEFORE the page cut, same as
  // the other filters here — a client-side filter over an already-paginated
  // page would hide matches that exist beyond the first page (e.g. a
  // low-volume provider like a warming-up Twilio number next to a
  // high-volume Evolution one).
  provider: channelProviderEnum.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(), // message id; returns messages OLDER than it
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export type ConversationSummary = {
  id: string;
  instanceId: string;
  instanceName: string;
  // Provider of the channel (instance) this conversation belongs to —
  // multi-provider channels (F4): lets the inbox badge/filter conversations
  // by provider without an extra query (sourced from the same instance join
  // used for instanceName).
  provider: ChannelProviderContract;
  remoteJid: string;
  phoneE164: string | null; // null for an unresolved @lid contact
  contactId: string | null;
  displayName: string; // contact.name ?? waName ?? phoneE164 ?? 'Número desconhecido'
  waName: string | null;
  profilePicUrl: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'INBOUND' | 'OUTBOUND' | null;
  unreadCount: number;
  assignedUserId: string | null;
  assignedUserName: string | null;
  botId: string | null;
  botName: string | null;
  botPaused: boolean;
  // T6 (twilio-platform): fim da janela de 24h (lastInboundAt + 24h, ISO).
  // null para canais não-TWILIO ou sem nenhum inbound registrado. Pode estar
  // no PASSADO (janela fechada) — o inbox usa para countdown/estado
  // "só template" do composer.
  twilioWindowExpiresAt: string | null;
};

export type ConversationsPage = { items: ConversationSummary[]; total: number; page: number; pageSize: number };

export type ChatMessageMedia = {
  id: string; kind: string; status: string; mimeType: string | null; fileName: string | null;
  sizeBytes: number | null; durationSec: number | null; width: number | null; height: number | null;
};

export type ChatMessage = {
  id: string; conversationId: string; direction: 'INBOUND' | 'OUTBOUND'; kind: string;
  content: string | null; status: string; providerMessageId: string | null;
  quotedWaMessageId: string | null; quotedPreview: string | null;
  createdAt: string; sentAt: string | null; deliveredAt: string | null; readAt: string | null; receivedAt: string | null;
  media: ChatMessageMedia | null;
  /** Speech-to-text transcript for voice notes (null when absent). */
  transcript: string | null;
  botId: string | null;
  /**
   * Raw provider error code (`gozap.timeout`, `evolution.not_connected`…) for a
   * FAILED message — the same code the campaign path already persists. `null`
   * for any non-FAILED message, or a FAILED one whose error carried no code.
   * Additive field: existing consumers that don't read it are unaffected.
   */
  errorCode: string | null;
};

export type MessagesPage = { items: ChatMessage[]; nextCursor: string | null };

export const sendReplySchema = z.object({
  text: z.string().min(1).max(4096),
  quotedWaMessageId: z.string().optional(),
  quotedPreview: z.string().optional(),
});
export type SendReplyInput = z.infer<typeof sendReplySchema>;

export const typingSchema = z.object({
  state: z.enum(['composing', 'paused']).default('composing'),
});
export type TypingInput = z.infer<typeof typingSchema>;

export const assignConversationSchema = z.object({
  // null unassigns the conversation; a userId assigns it to that operator.
  userId: z.string().nullable(),
});
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;
