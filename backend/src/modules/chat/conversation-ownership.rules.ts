import type { ResolveConversationInput } from '../../schemas/contracts/chat.schema';
import type {
  ChatActor,
  LockedConversation,
} from './conversation-ownership.repository';

/**
 * K1-3/DK5: resolve o atendente que a tela mostrava ou um ADMIN. O ator vem de
 * `req.user` (papel relido do banco a cada request); `expectedAssigneeId` é o
 * atendente que a tela mostrava. Conversa Pendente (`null`) só o ADMIN resolve.
 */
export function canResolve(
  actor: ChatActor,
  expectedAssigneeId: string | null,
): boolean {
  return actor.role === 'ADMIN' || expectedAssigneeId === actor.id;
}

/**
 * DK5: a linha travada não é mais a que a tela mostrava — já resolvida, outro
 * atendente ou mensagem recebida depois (`lastInboundAt` comparado em ms).
 */
export function resolveStateChanged(
  locked: LockedConversation,
  expected: Pick<
    ResolveConversationInput,
    'expectedAssigneeId' | 'expectedLastInboundAt'
  >,
): boolean {
  const expectedInbound =
    expected.expectedLastInboundAt === null
      ? null
      : new Date(expected.expectedLastInboundAt).getTime();
  return (
    locked.resolvedAt !== null ||
    locked.assignedUserId !== expected.expectedAssigneeId ||
    (locked.lastInboundAt?.getTime() ?? null) !== expectedInbound
  );
}
