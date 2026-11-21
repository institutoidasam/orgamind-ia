import type {
  ChatActor,
  LockedConversation,
  OwnershipChange,
} from './conversation-ownership.repository';

/** Ação do histórico que o pedido de atribuição representa (DK6). */
export type AssignKind = 'ASSUMED' | 'TRANSFERRED' | 'UNASSIGNED';

/** DK6: `userId` nulo remove; o próprio ator assume; outra pessoa recebe a transferência. */
export function assignKind(actorId: string, userId: string | null): AssignKind {
  if (userId === null) return 'UNASSIGNED';
  return userId === actorId ? 'ASSUMED' : 'TRANSFERRED';
}

/**
 * DK6.3/K1-3: 403 `chat.not_assignee`. Remover: ADMIN ou o atendente que a
 * tela mostrava. Transferir: ADMIN, o atendente ou qualquer um se a tela
 * mostrava a conversa sem atendente. Assumir: qualquer um com acesso (K1-8).
 * `expectedAssigneeId` é o do pedido; o 409 cobre a linha ter mudado.
 */
export function canAssign(
  actor: ChatActor,
  kind: AssignKind,
  expectedAssigneeId: string | null,
): boolean {
  if (kind === 'ASSUMED' || actor.role === 'ADMIN') return true;
  if (kind === 'TRANSFERRED' && expectedAssigneeId === null) return true;
  return expectedAssigneeId === actor.id;
}

/**
 * DK6.5: o pedido já é o estado da linha travada (assumir ou transferir para
 * quem já atende a conversa aberta; remover sem atendente): 200, nada gravado.
 */
export function assignHasNoEffect(
  locked: Pick<LockedConversation, 'assignedUserId' | 'resolvedAt'>,
  kind: AssignKind,
  userId: string | null,
): boolean {
  if (kind === 'UNASSIGNED') return locked.assignedUserId === null;
  return locked.assignedUserId === userId && locked.resolvedAt === null;
}

/**
 * DK6.6: assumir e transferir pausam o robô e reabrem a resolvida (linha
 * `REOPENED` antes da `ASSUMED`/`TRANSFERRED`); remover não toca o robô.
 */
export function assignChange(
  locked: LockedConversation,
  kind: AssignKind,
  ctx: {
    actorId: string;
    userId: string | null;
    note: string | null;
    now: Date;
  },
): OwnershipChange {
  const removing = kind === 'UNASSIGNED';
  return {
    conversation: locked,
    actorId: ctx.actorId,
    assignedUserId: ctx.userId,
    resolved: removing && locked.resolvedAt !== null,
    actions: locked.resolvedAt && !removing ? ['REOPENED', kind] : [kind],
    note: ctx.note,
    pauseBot: !removing,
    now: ctx.now,
  };
}
