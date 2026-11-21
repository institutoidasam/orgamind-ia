import type {
  ConversationStatus,
  ConversationSummary,
  ListConversationsQuery,
} from '../../schemas/contracts/chat.schema';

/** Campos da linha de Conversation que definem a situação (K1-1). */
type SituationRow = {
  resolvedAt: Date | null;
  lastInboundAt: Date | null;
  assignedUserId: string | null;
  assignedUser: { isActive: boolean; hasAccess: boolean } | null;
};

/** K1-1: calculada, nunca gravada. resolvedAt → RESOLVED; senão atendente → IN_PROGRESS; senão PENDING. */
export function conversationStatus(
  row: Pick<SituationRow, 'resolvedAt' | 'assignedUserId'>,
): ConversationStatus {
  if (row.resolvedAt) return 'RESOLVED';
  return row.assignedUserId ? 'IN_PROGRESS' : 'PENDING';
}

/**
 * Os quatro campos que a K1 acrescenta ao resumo da conversa. `assignedUserActive`
 * (K1-8) é `isActive && hasAccess` do atendente; null quando não há atendente.
 */
export function conversationSituationFields(
  row: SituationRow,
): Pick<
  ConversationSummary,
  'status' | 'resolvedAt' | 'lastInboundAt' | 'assignedUserActive'
> {
  const assignee = row.assignedUser;
  return {
    status: conversationStatus(row),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    assignedUserActive: assignee
      ? assignee.isActive && assignee.hasAccess
      : null,
  };
}

/**
 * K1-10: `open` (Pendente + Em atendimento) pede `resolvedAt` nulo; `resolved`
 * pede `resolvedAt` preenchido. O filtro de arquivadas fica no repositório.
 */
export function resolvedAtFilter(
  status: ListConversationsQuery['status'],
): null | { not: null } {
  return status === 'resolved' ? { not: null } : null;
}
