import { useState } from 'react';
import { readApiErrorBody } from '@/lib/api-error';
import { useAuthStore } from '@/stores/auth.store';
import { useAssignConversation, useConversation } from '../api';
import { CHAT_ASSIGNED_TO_OTHER, parseAssigneeDetail } from '../chat-errors';
import type { ConversationSummary } from '../schemas';
import { assigneeLabel, replyLock } from '../situation';

const UNKNOWN_ASSIGNEE = 'Outra pessoa';

/**
 * 409 `chat.assigned_to_other` visto por este compositor. `since` é o
 * `dataUpdatedAt` da conversa quando o envio começou: o 409 local vale até a
 * conversa ser recarregada (aí o estado do servidor decide) ou o "Assumir"
 * dar certo (DK17).
 */
type Conflict = { since: number; id: string | null; name: string | null };
type Lock = { locked: boolean; assigneeId: string | null; name: string };

/** Trava pelo estado que o servidor mandou (DK17): outro atendente, conversa aberta. */
function serverLock(conversation: ConversationSummary | undefined, meId: string | undefined): Lock {
  if (!conversation) return { locked: false, assigneeId: null, name: UNKNOWN_ASSIGNEE };
  const { locked, name } = replyLock(conversation, meId ?? '');
  return { locked, assigneeId: conversation.assignedUserId ?? null, name: name ?? UNKNOWN_ASSIGNEE };
}

function resolveLock(
  conflict: Conflict | null, updatedAt: number, conversation: ConversationSummary | undefined, meId: string | undefined,
): Lock {
  if (conflict && updatedAt <= conflict.since) {
    return { locked: true, assigneeId: conflict.id, name: conflict.name ?? UNKNOWN_ASSIGNEE };
  }
  return serverLock(conversation, meId);
}

export type AssigneeLock = Lock & {
  pending: boolean;
  assume: () => void;
  /** Falha de envio: se for o 409 de conversa de outro, trava e devolve true (zera o erro da mutação). */
  trap: (err: unknown, mutation: { reset: () => void }) => Promise<boolean>;
};

/**
 * Trava do compositor (K1-6, DK17): conversa com outro atendente (lida de
 * `useConversation`) ou 409 local. O `detail` do 409 é lido de forma
 * assíncrona por `readApiErrorBody` (DK14/GK10), nunca na renderização.
 */
export function useAssigneeLock(conversationId: string): AssigneeLock {
  const meId = useAuthStore((s) => s.user?.id);
  const { data: conversation, dataUpdatedAt } = useConversation(conversationId);
  const assign = useAssignConversation(conversationId);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const updatedAt = dataUpdatedAt ?? 0;

  const assume = () => {
    if (!meId) return;
    const { assigneeId } = resolveLock(conflict, updatedAt, conversation, meId);
    assign.mutate({ userId: meId, expectedAssigneeId: assigneeId }, { onSuccess: () => setConflict(null) });
  };

  const trap = async (err: unknown, mutation: { reset: () => void }) => {
    const body = await readApiErrorBody(err);
    if (body?.code !== CHAT_ASSIGNED_TO_OTHER) return false;
    const assignee = parseAssigneeDetail(body.detail);
    setConflict({ since: updatedAt, id: assignee?.id ?? null, name: assignee && assigneeLabel(assignee.name, assignee.active) });
    mutation.reset();
    return true;
  };

  return { ...resolveLock(conflict, updatedAt, conversation, meId), pending: assign.isPending, assume, trap };
}
