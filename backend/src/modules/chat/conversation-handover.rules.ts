import type { HandoverSkipReason } from '../../schemas/contracts/chat.schema';
import type {
  ChatActor,
  LockedConversation,
  OwnershipChange,
} from './conversation-ownership.repository';

/**
 * Regras puras da passagem de turno das conversas (Lote K3, CT3). Nada aqui lê
 * banco: o serviço trava a linha e passa os fatos.
 */

/**
 * K3-1/K3-2: passa as conversas de quem sai o próprio atendente ou o ADMIN
 * (de qualquer pessoa, inclusive inativa). Nega → 403 `chat.not_assignee`.
 */
export function canHandoverFrom(actor: ChatActor, fromId: string): boolean {
  return fromId === actor.id || actor.role === 'ADMIN';
}

/**
 * DT2.2: por que a conversa travada NÃO é passada; `null` = passa. Ordem fixa:
 * resolvida antes de tudo (passar turno nunca reabre), depois "já com o
 * destino" (repetir o pedido é inofensivo), "sem atendente" e "com outro".
 */
export function handoverSkipReason(
  locked: Pick<LockedConversation, 'assignedUserId' | 'resolvedAt'>,
  fromId: string,
  toId: string,
): HandoverSkipReason | null {
  if (locked.resolvedAt !== null) return 'resolved';
  if (locked.assignedUserId === toId) return 'already_with_target';
  if (locked.assignedUserId === null) return 'unassigned';
  if (locked.assignedUserId !== fromId) return 'other_assignee';
  return null;
}

/**
 * DT2.3/K1-7: uma linha `SHIFT_HANDOVER` (autor = quem pede, de = quem sai,
 * para = destino, com a observação), atendente = destino, conversa aberta e
 * robô pausado (passar turno nunca o retoma).
 */
export function handoverChange(
  locked: LockedConversation,
  ctx: { actorId: string; toId: string; note: string; now: Date },
): OwnershipChange {
  return {
    conversation: locked,
    actorId: ctx.actorId,
    assignedUserId: ctx.toId,
    resolved: false,
    actions: ['SHIFT_HANDOVER'],
    note: ctx.note,
    pauseBot: true,
    now: ctx.now,
  };
}
