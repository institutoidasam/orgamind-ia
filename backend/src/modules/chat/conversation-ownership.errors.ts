import { DomainError } from '../../shared/errors/domain.error';

/** Atendente citado num 409 (DK14): só id, nome e se pode atender; nada de contato. */
export type AssigneeRef = { id: string; name: string; active: boolean };

/** `detail` dos 409 de conversa: `JSON.stringify({ assignee })` (DK14, C3). */
export function assigneeDetail(ref: AssigneeRef | null): string {
  return JSON.stringify({ assignee: ref });
}

export function notAssignee(): DomainError {
  return new DomainError({
    code: 'chat.not_assignee',
    message: 'Só o atendente ou um administrador pode fazer isso.',
    status: 403,
  });
}

export function conversationChanged(current: AssigneeRef | null): DomainError {
  return new DomainError({
    code: 'chat.conversation_changed',
    message: 'A conversa mudou.',
    status: 409,
    detail: assigneeDetail(current),
  });
}

export function assignedToOther(current: AssigneeRef): DomainError {
  return new DomainError({
    code: 'chat.assigned_to_other',
    message: 'Outra pessoa está atendendo esta conversa.',
    status: 409,
    detail: assigneeDetail(current),
  });
}
