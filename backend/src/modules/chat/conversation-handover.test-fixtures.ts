import { vi } from 'vitest';
import type { ShiftHandoverInput } from '../../schemas/contracts/chat.schema';
import { ConversationHandoverService } from './conversation-handover.service';
import {
  newConversation,
  T0,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';

/** Fixtures da passagem de turno das conversas (K3, T-B2); somam-se às do K1. */
export type HandoverUsers = Record<
  'supervisor' | 'inactive' | 'noAccess',
  string
>;

/** Usuários extras: SUPERVISOR, OPERATOR inativo e OPERATOR sem acesso (K1-8). */
export async function addHandoverUsers(
  db: OwnershipDb,
): Promise<HandoverUsers> {
  const create = async (
    key: string,
    data: {
      role: 'OPERATOR' | 'SUPERVISOR';
      isActive?: boolean;
      hasAccess?: boolean;
    },
  ) =>
    (
      await db.prisma.user.create({
        data: {
          // Sem acesso (D1): e-mail e senha NULL.
          email: data.hasAccess === false ? null : `${key}@test.local`,
          password: data.hasAccess === false ? null : 'x',
          name: key,
          ...data,
        },
        select: { id: true },
      })
    ).id;
  return {
    supervisor: await create('supervisor', { role: 'SUPERVISOR' }),
    inactive: await create('inativo', { role: 'OPERATOR', isActive: false }),
    noAccess: await create('semacesso', { role: 'OPERATOR', hasAccess: false }),
  };
}

/** Ator do pedido: o ADMIN do fixture é ADMIN; os demais, OPERATOR. */
export const handoverActor = (
  db: OwnershipDb,
  key: 'admin' | 'ana' | 'bia',
) => ({
  id: db.ids[key],
  role: key === 'admin' ? 'ADMIN' : 'OPERATOR',
});

/** Resultado ou erro da promessa, sem derrubar a corrida (Molde B). */
export const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** Serviço real sobre o banco; só o `ChatEventsService` é um espião. */
export function handoverService(db: OwnershipDb) {
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const service = new ConversationHandoverService(
    db.prisma as never,
    db.audit,
    events as never,
  );
  return { service, events };
}

/** Conversa aberta e com atendente `userId` desde T0 (a "Em atendimento" de quem sai). */
export const attendedBy = (
  db: OwnershipDb,
  userId: string | null,
  over: object = {},
) =>
  newConversation(db, {
    assignedUserId: userId,
    assignedAt: userId ? T0 : null,
    ...over,
  });

export const handoverInput = (
  toUserId: string,
  conversationIds: string[],
  over: Partial<ShiftHandoverInput> = {},
): ShiftHandoverInput => ({
  toUserId,
  note: 'Fim do turno',
  conversationIds,
  ...over,
});
