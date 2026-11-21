import { z } from 'zod';
import { CHANNEL_PROVIDERS } from '@/features/whatsapp/api';
import { teamPurposeSchema } from '@/features/team-whatsapp/schemas';

export const conversationStatusSchema = z.enum(['PENDING', 'IN_PROGRESS', 'RESOLVED']);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationSummarySchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  instanceName: z.string(),
  remoteJid: z.string(),
  phoneE164: z.string().nullable(),
  contactId: z.string().nullable(),
  displayName: z.string(),
  waName: z.string().nullable(),
  profilePicUrl: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  lastMessageDirection: z.enum(['INBOUND', 'OUTBOUND']).nullable(),
  unreadCount: z.number(),
  assignedUserId: z.string().nullable().optional(),
  assignedUserName: z.string().nullable().optional(),
  botId: z.string().nullable().optional(),
  botName: z.string().nullable().optional(),
  botPaused: z.boolean().optional(),
  // Provider of the channel (instance) this conversation belongs to
  // (multi-provider channels — F4). Optional so older cached pages / a
  // mid-deploy backend still parse cleanly; the inbox badge/filter simply
  // treat a missing provider as "unknown" (excluded from the distinct-count
  // that gates the badge, and unmatched by any specific filter tab).
  provider: z.enum(CHANNEL_PROVIDERS).optional(),
  // T7 (twilio-platform): fim da janela de 24h (lastInboundAt + 24h, ISO).
  // null para canais não-TWILIO ou sem nenhum inbound registrado; pode estar
  // no passado (janela fechada). Optional para um backend mid-deploy — o
  // composer trata ausente igual a null (janela fechada) em canais TWILIO.
  twilioWindowExpiresAt: z.string().nullable().optional(),
  // K1 (situação da conversa): tolerantes para um backend mid-deploy. Sem
  // `status`, a situação sai dos campos (situation.ts); `lastInboundAt` é o
  // que o "Resolver" devolve ao servidor; `assignedUserActive` é null sem
  // atendente e false quando ele foi inativado ou perdeu o acesso.
  status: conversationStatusSchema.nullish(),
  resolvedAt: z.string().nullish(),
  lastInboundAt: z.string().nullish(),
  assignedUserActive: z.boolean().nullish(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationsPageSchema = z.object({
  items: z.array(conversationSummarySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ConversationsPage = z.infer<typeof conversationsPageSchema>;

/**
 * Etiqueta de envio à equipe de uma mensagem (K3-6, CT1). `sentAt`/`alertSentAt`
 * são a hora real do disparo; a tela as mostra na hora de Manaus.
 */
export const chatMessageTeamTagSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dispatch'), purpose: teamPurposeSchema.nullable(), sentAt: z.string() }),
  z.object({ kind: z.literal('reminder') }),
  z.object({ kind: z.literal('alert_reply'), alertSentAt: z.string() }),
]);
export type ChatMessageTeamTag = z.infer<typeof chatMessageTeamTagSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  kind: z.string(),
  content: z.string().nullable(),
  status: z.string(),
  providerMessageId: z.string().nullable(),
  quotedWaMessageId: z.string().nullable(),
  quotedPreview: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  media: z.object({
    id: z.string(), kind: z.string(), status: z.string(), mimeType: z.string().nullable(), fileName: z.string().nullable(),
    sizeBytes: z.number().nullable(), durationSec: z.number().nullable(), width: z.number().nullable(), height: z.number().nullable(),
  }).nullable(),
  /** Speech-to-text transcript for voice notes (null when absent). */
  transcript: z.string().nullable().optional(),
  botId: z.string().nullable().optional(),
  /** K3-6: etiqueta de envio à equipe; ausente em resposta antiga ou fora de `listMessages`. */
  teamTag: chatMessageTeamTagSchema.nullish(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const messagesPageSchema = z.object({
  items: z.array(chatMessageSchema),
  nextCursor: z.string().nullable(),
});
export type MessagesPage = z.infer<typeof messagesPageSchema>;

export const historyActionSchema = z.enum([
  'ASSUMED', 'ASSUMED_ON_REPLY', 'TRANSFERRED', 'UNASSIGNED', 'RESOLVED', 'REOPENED', 'SHIFT_HANDOVER',
]);
export const conversationHistorySchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    action: historyActionSchema,
    createdAt: z.string(),
    actorId: z.string().nullable(),
    actorName: z.string().nullable(),
    fromUserId: z.string().nullable(),
    fromUserName: z.string().nullable(),
    toUserId: z.string().nullable(),
    toUserName: z.string().nullable(),
    note: z.string().nullable(),
  })),
  // true quando há mais do que as 200 linhas devolvidas.
  hasMore: z.boolean().nullish(),
});
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;
export type ConversationHistoryItem = ConversationHistory['items'][number];

export const chatAssigneesSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) });
export type ChatAssignees = z.infer<typeof chatAssigneesSchema>;

/**
 * Boundary validation for chat API responses. We `safeParse` so schema drift is
 * surfaced (a console.warn) without crashing the inbox: the global ErrorBoundary
 * would otherwise turn a single drifted field into a full-page crash. On a parse
 * failure we fall back to the raw (cast) value so the UI degrades gracefully
 * rather than going blank.
 */
export function boundaryParse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  console.warn(`[chat] response did not match ${label} schema (drift?):`, result.error.issues);
  return data as T;
}

export const parseConversationsPage = (d: unknown): ConversationsPage =>
  boundaryParse(conversationsPageSchema, d, 'ConversationsPage');
export const parseConversationSummary = (d: unknown): ConversationSummary =>
  boundaryParse(conversationSummarySchema, d, 'ConversationSummary');
export const parseMessagesPage = (d: unknown): MessagesPage =>
  boundaryParse(messagesPageSchema, d, 'MessagesPage');
export const parseChatMessage = (d: unknown): ChatMessage =>
  boundaryParse(chatMessageSchema, d, 'ChatMessage');
export const parseConversationHistory = (d: unknown): ConversationHistory =>
  boundaryParse(conversationHistorySchema, d, 'ConversationHistory');
export const parseChatAssignees = (d: unknown): ChatAssignees =>
  boundaryParse(chatAssigneesSchema, d, 'ChatAssignees');

export type ChatEvent =
  | { type: 'message.created'; conversationId: string; instanceId: string; messageId?: string }
  | { type: 'message.status'; conversationId: string; instanceId: string; messageId: string; status: string }
  | { type: 'conversation.updated'; conversationId: string; instanceId: string }
  | { type: 'media.ready'; conversationId: string; instanceId: string; messageId: string };
