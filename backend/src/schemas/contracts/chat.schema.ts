import { z } from 'zod';
import { channelProviderEnum, type ChannelProviderContract } from './channel-provider.schema';
import type { TeamPurpose } from './team-whatsapp.schema';

export const listConversationsQuerySchema = z.object({
  filter: z.enum(['all', 'unread', 'awaiting']).default('all'),
  // Situação (K1-10): 'open' = Pendente + Em atendimento (padrão); 'resolved' =
  // só as resolvidas. Combina com os demais filtros; `archivedAt: null` sempre.
  status: z.enum(['open', 'resolved']).default('open'),
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
  // Recebidas na passagem de turno (K3-3): 'true' = só as que a última mudança
  // de atendente foi uma passagem; o servidor força assignee = quem olha (DT3).
  handover: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(), // message id; returns messages OLDER than it
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

// K1-1: calculada no mapper — resolvedAt → RESOLVED; senão atendente → IN_PROGRESS; senão PENDING.
export type ConversationStatus = 'PENDING' | 'IN_PROGRESS' | 'RESOLVED';

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
  // K1-8: isActive && hasAccess do atendente; null quando não há atendente.
  assignedUserActive: boolean | null;
  status: ConversationStatus;
  resolvedAt: string | null;
  // Último INBOUND (ISO); o front o devolve em "Resolver" (K1-3/K1-7).
  lastInboundAt: string | null;
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

/** `sentAt` do envio = COALESCE(firedAt, createdAt); `alertSentAt` = hora real do disparo do alerta (DT6). */
export type ChatMessageTeamTag =
  | { kind: 'dispatch'; purpose: TeamPurpose | null; sentAt: string }
  | { kind: 'reminder' }
  | { kind: 'alert_reply'; alertSentAt: string };

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
  /** K3-6: etiqueta de envio da equipe; `listMessages` sempre preenche, outros caminhos omitem. */
  teamTag?: ChatMessageTeamTag | null;
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

// DK15: observação opcional de até 200 caracteres; só espaços vira vazia (o
// service grava null). Vai só para o histórico, nunca para trilha nem log.
export const conversationNoteSchema = z.string().trim().max(200).optional();

export const assignConversationSchema = z.object({
  // null unassigns the conversation; a userId assigns it to that operator.
  userId: z.string().nullable(),
  // Atendente que a tela mostrava (null = sem atendente). Obrigatório: ausente → 400.
  expectedAssigneeId: z.string().nullable(),
  note: conversationNoteSchema,
});
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;

export const resolveConversationSchema = z.object({
  expectedAssigneeId: z.string().nullable(),
  expectedLastInboundAt: z.iso.datetime().nullable(),
  note: conversationNoteSchema,
});
export type ResolveConversationInput = z.infer<
  typeof resolveConversationSchema
>;

export const reopenConversationSchema = z.object({
  note: conversationNoteSchema,
});
export type ReopenConversationInput = z.infer<typeof reopenConversationSchema>;

// K3-1/DT5: teto = o maior `pageSize` da lista de origem; observação obrigatória,
// aparada, comum a todas; só vai para o histórico, nunca para trilha nem log.
export const HANDOVER_MAX_CONVERSATIONS = 100;
export const shiftHandoverSchema = z.object({
  toUserId: z.string().min(1),
  // Ausente = quem pede (K3-1); outro = só o ADMIN (K3-2).
  fromUserId: z.string().min(1).optional(),
  note: z.string().trim().min(1).max(200),
  conversationIds: z
    .array(z.string().min(1))
    .min(1)
    .max(HANDOVER_MAX_CONVERSATIONS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Há conversas repetidas.',
    }),
});
export type ShiftHandoverInput = z.infer<typeof shiftHandoverSchema>;
export type HandoverSkipReason =
  | 'resolved'
  | 'other_assignee'
  | 'unassigned'
  | 'already_with_target'
  | 'not_found';
export type ShiftHandoverResult = {
  transferred: { id: string }[];
  skipped: { id: string; reason: HandoverSkipReason }[];
};

export type ConversationHistoryAction =
  | 'ASSUMED'
  | 'ASSUMED_ON_REPLY'
  | 'TRANSFERRED'
  | 'UNASSIGNED'
  | 'RESOLVED'
  | 'REOPENED'
  | 'SHIFT_HANDOVER';

export type ConversationHistoryItem = {
  id: string;
  action: ConversationHistoryAction;
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
  fromUserId: string | null;
  fromUserName: string | null;
  toUserId: string | null;
  toUserName: string | null;
  note: string | null;
};

// hasMore: há mais de 200 entradas (M8).
export type ConversationHistoryResponse = {
  items: ConversationHistoryItem[];
  hasMore: boolean;
};

export type ChatAssignee = { id: string; name: string };
export type ChatAssigneesResponse = { items: ChatAssignee[] };
