import type { Prisma } from '@prisma/client';
import type {
  ChatAssignee,
  ConversationHistoryAction,
  ConversationHistoryItem,
} from '../../schemas/contracts/chat.schema';
import type { AuditChange } from '../../shared/audit/audit-change';
import type { AuditService } from '../../shared/audit/audit.service';
import { NotFoundError } from '../../shared/errors/domain.error';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import type { AssigneeRef } from './conversation-ownership.errors';

/**
 * DK22: o Prisma dá `timeout` 5 s e `maxWait` 2 s às transações interativas, e
 * isso estoura sob espera de trava. Toda `$transaction` do núcleo, da trava de
 * resposta e da ingestão passa estes prazos (use `runOwnershipTransaction`).
 */
export const OWNERSHIP_TX_OPTIONS = {
  timeout: 10_000,
  maxWait: 5_000,
} as const;

/** Ator da ação: id e papel de `req.user` (`sub`, `role`); o controller monta (DK12). */
export type ChatActor = { id: string; role: string };

/** Linha da conversa lida sob `FOR NO KEY UPDATE`: base da conferência do estado esperado. */
export type LockedConversation = {
  id: string;
  instanceId: string;
  assignedUserId: string | null;
  resolvedAt: Date | null;
  lastInboundAt: Date | null;
};

export type OwnershipChange = {
  conversation: LockedConversation;
  /** null = Sistema (nenhuma trilha `conversation.assign`). */
  actorId: string | null;
  /** Atendente depois da mudança. */
  assignedUserId: string | null;
  /** Conversa resolvida depois da mudança. */
  resolved: boolean;
  /** Linhas do histórico, nesta ordem (de = antes, para = depois). */
  actions: ConversationHistoryAction[];
  note: string | null;
  pauseBot: boolean;
  now: Date;
};

type UserDb = Pick<Prisma.TransactionClient, 'user'>;

const HISTORY_PAGE_SIZE = 200;
const ELIGIBLE_ROLES = ['ADMIN', 'OPERATOR'] as const;

/** `prisma.$transaction(fn, OWNERSHIP_TX_OPTIONS)`: o único ponto que fixa os prazos (DK22). */
export function runOwnershipTransaction<T>(
  db: Pick<PrismaService, '$transaction'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(fn, OWNERSHIP_TX_OPTIONS);
}

/** DK4.1: trava a linha (`FOR NO KEY UPDATE`); ausente → 404. */
export async function lockConversation(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<LockedConversation> {
  const rows = await tx.$queryRaw<LockedConversation[]>`
    SELECT "id", "instanceId", "assignedUserId", "resolvedAt", "lastInboundAt"
    FROM "Conversation" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  if (rows.length === 0) throw new NotFoundError('Conversation', id);
  return rows[0];
}

function conversationData(
  change: OwnershipChange,
): Prisma.ConversationUncheckedUpdateInput {
  const { conversation: before, now } = change;
  const data: Prisma.ConversationUncheckedUpdateInput = {
    assignedUserId: change.assignedUserId,
  };
  if (before.assignedUserId !== change.assignedUserId) {
    data.assignedAt = change.assignedUserId ? now : null;
  }
  if (change.resolved && !before.resolvedAt) data.resolvedAt = now;
  if (!change.resolved && before.resolvedAt) data.resolvedAt = null;
  // Só pausa: nenhuma ação do núcleo devolve a conversa ao robô.
  if (change.pauseBot) data.botPausedAt = now;
  return data;
}

function historyData(
  change: OwnershipChange,
): Prisma.ConversationHistoryEntryCreateManyInput[] {
  return change.actions.map((action) => ({
    conversationId: change.conversation.id,
    action,
    actorId: change.actorId,
    fromUserId: change.conversation.assignedUserId,
    toUserId: change.assignedUserId,
    note: change.note,
    createdAt: change.now,
  }));
}

/** DK7: ids e a ação do histórico (`kind`); sem `note`, sem nome. */
function assignTrail(change: OwnershipChange, actorId: string): AuditChange {
  return {
    action: 'conversation.assign',
    entity: 'Conversation',
    entityId: change.conversation.id,
    category: null,
    changes: [
      {
        field: 'assignedUserId',
        before: change.conversation.assignedUserId,
        after: change.assignedUserId,
      },
    ],
    metadata: {
      assignedUserId: change.assignedUserId,
      assignedBy: actorId,
      kind: change.actions.at(-1) ?? null,
    },
    actorId,
  };
}

/**
 * DK4.3: conversa, linhas do histórico e trilha no mesmo `tx` (o chamador já
 * travou a linha e conferiu o estado esperado). Se o atendente mudou e há ator,
 * grava `conversation.assign`; o erro da trilha propaga e desfaz tudo.
 */
export async function applyOwnershipChange(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  change: OwnershipChange,
): Promise<void> {
  await tx.conversation.update({
    where: { id: change.conversation.id },
    data: conversationData(change),
  });
  if (change.actions.length > 0) {
    await tx.conversationHistoryEntry.createMany({ data: historyData(change) });
  }
  const assigneeChanged =
    change.conversation.assignedUserId !== change.assignedUserId;
  if (assigneeChanged && change.actorId !== null) {
    await audit.recordChange(tx, assignTrail(change, change.actorId));
  }
}

/** `active` = `isActive && hasAccess` (K1-8); usuário inexistente → null. */
export async function findAssigneeRef(
  db: UserDb,
  userId: string,
): Promise<AssigneeRef | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, isActive: true, hasAccess: true },
  });
  if (!user) return null;
  return {
    id: user.id,
    name: user.name ?? '',
    active: user.isActive && user.hasAccess,
  };
}

const eligibleUserWhere = {
  isActive: true,
  hasAccess: true,
  role: { in: [...ELIGIBLE_ROLES] },
} satisfies Prisma.UserWhereInput;

/** DK6.1: ADMIN ou OPERATOR, ativo e com acesso; senão null. */
export async function findEligibleAssignee(
  db: UserDb,
  userId: string,
): Promise<ChatAssignee | null> {
  const user = await db.user.findFirst({
    where: { id: userId, ...eligibleUserWhere },
    select: { id: true, name: true },
  });
  return user ? { id: user.id, name: user.name ?? '' } : null;
}

/** DK13: só id e nome, em ordem de nome (em memória: não depende da collation do banco). */
export async function listEligibleAssignees(
  db: UserDb,
): Promise<ChatAssignee[]> {
  const users = await db.user.findMany({
    where: eligibleUserWhere,
    select: { id: true, name: true },
  });
  return users
    .map((user) => ({ id: user.id, name: user.name ?? '' }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id),
    );
}

type HistoryRow = Prisma.ConversationHistoryEntryGetPayload<object>;

async function userNames(
  db: UserDb,
  rows: HistoryRow[],
): Promise<Map<string, string | null>> {
  const userIds = new Set<string>();
  for (const row of rows) {
    for (const id of [row.actorId, row.fromUserId, row.toUserId]) {
      if (id) userIds.add(id);
    }
  }
  if (userIds.size === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

function toHistoryItem(
  row: HistoryRow,
  names: Map<string, string | null>,
): ConversationHistoryItem {
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    id: row.id,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
    actorId: row.actorId,
    actorName: nameOf(row.actorId),
    fromUserId: row.fromUserId,
    fromUserName: nameOf(row.fromUserId),
    toUserId: row.toUserId,
    toUserName: nameOf(row.toUserId),
    note: row.note,
  };
}

/** DK13/M8: lê 201, devolve as 200 mais recentes (mais nova primeiro) e `hasMore`. */
export async function listConversationHistory(
  db: Pick<PrismaService, 'conversationHistoryEntry' | 'user'>,
  conversationId: string,
): Promise<{ items: ConversationHistoryItem[]; hasMore: boolean }> {
  const rows = await db.conversationHistoryEntry.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  const names = await userNames(db, page);
  return {
    items: page.map((row) => toHistoryItem(row, names)),
    hasMore: rows.length > HISTORY_PAGE_SIZE,
  };
}
