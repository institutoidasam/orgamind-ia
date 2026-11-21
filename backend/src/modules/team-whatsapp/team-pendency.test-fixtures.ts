import {
  PrismaClient,
  type Prisma,
  type Role,
  type TeamDispatchPurpose,
  type TeamPendencyNoteKind,
} from '@prisma/client';
import {
  T0,
  at,
  startOwnershipDb,
  stopOwnershipDb,
  waitForAnyLockWait,
  withConnectionLimit,
  type ExternalLock,
  type OwnershipDb,
} from '../chat/conversation-ownership.test-fixtures';

/**
 * Fixtures das pendências da equipe (Lote K2, DK23). Banco, relógio e esperas de
 * trava são os do K1 (importados, não copiados); aqui entram a trava na linha do
 * destinatário e as sementes. Datas sempre explícitas a partir de `T0`/`at(min)`
 * e dados fictícios (GK8).
 */
export { T0, at, waitForAnyLockWait, withConnectionLimit };
export type { ExternalLock };
export type PendencyDb = OwnershipDb;
export const startPendencyDb = startOwnershipDb;
export const stopPendencyDb = stopOwnershipDb;

let seq = 0;
const nextSeq = (): number => (seq += 1);

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Sessões esperando trava de linha (`FOR NO KEY UPDATE`), contadas pelo cliente do travador. */
async function countLockWaiters(locker: PrismaClient): Promise<number> {
  const [row] = await locker.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE%'
      AND pid <> pg_backend_pid()`;
  return row.n;
}

/**
 * Trava externa na linha do destinatário (`FOR NO KEY UPDATE`) por um segundo
 * `PrismaClient` dedicado (`connection_limit=2`: uma conexão segura a trava, a
 * outra conta as sessões bloqueadas), como `holdConversationLock` do K1.
 */
export async function holdRecipientLock(
  db: PendencyDb,
  recipientId: string,
): Promise<ExternalLock> {
  const uri = withConnectionLimit(db.postgres.getConnectionUri(), 2);
  const locker = new PrismaClient({ datasourceUrl: uri });
  const taken = deferred();
  const released = deferred();
  const held = locker.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TeamWhatsappRecipient" WHERE "id" = ${recipientId} FOR NO KEY UPDATE`;
      taken.resolve();
      await released.promise;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await Promise.race([taken.promise, held]);
  return {
    blockedSessions: () => countLockWaiters(locker),
    release: released.resolve,
    finish: async () => {
      released.resolve();
      await held;
      await locker.$disconnect();
    },
  };
}

/** Setor ativo (por padrão) com nome e código fictícios; devolve id e nome. */
export async function newSector(
  db: PendencyDb,
  opts: { managerId?: string; isActive?: boolean } = {},
): Promise<{ id: string; name: string }> {
  const n = nextSeq();
  return db.prisma.sector.create({
    data: { name: `Setor ${n}`, code: `s-k2-${n}`, ...opts },
    select: { id: true, name: true },
  });
}

/**
 * Pessoa da equipe. Sem acesso (`hasAccess: false`) fica sem e-mail e senha, como
 * exige o CHECK `User_access_consistent`.
 */
export async function newTeamUser(
  db: PendencyDb,
  opts: {
    role: Role;
    sectorId?: string;
    isActive?: boolean;
    hasAccess?: boolean;
    name?: string;
  },
): Promise<{ id: string; name: string }> {
  const n = nextSeq();
  const { hasAccess = true, name = `Pessoa ${n}`, ...rest } = opts;
  const login = hasAccess
    ? { email: `pessoa-k2-${n}@test.local`, password: 'x' }
    : {};
  const user = await db.prisma.user.create({
    data: { name, hasAccess, ...login, ...rest },
    select: { id: true },
  });
  return { id: user.id, name };
}

/** Envio de alerta urgente (por padrão, ciência em 15 min); devolve o id do envio. */
export async function newAlert(
  db: PendencyDb,
  opts: {
    authorId: string;
    createdAt: Date;
    ackDeadlineMinutes?: number;
    purpose?: TeamDispatchPurpose;
  },
): Promise<string> {
  const { ackDeadlineMinutes = 15, purpose = 'URGENCY', ...rest } = opts;
  const dispatch = await db.prisma.teamWhatsappDispatch.create({
    data: {
      targetType: 'SECTOR',
      targetId: 'setor-k2',
      targetLabel: 'Logística',
      text: 'Alerta de teste',
      ackDeadlineMinutes,
      purpose,
      ...rest,
    },
    select: { id: true },
  });
  return dispatch.id;
}

export type NewPendencyInput = {
  dispatchId: string;
  userId?: string;
  userName?: string;
  sectorId?: string;
  sectorName?: string;
  ackAt?: Date;
  handlerId?: string;
  assignedAt?: Date;
  dueAt?: Date;
  closedAt?: Date;
  closedById?: string;
  closeReason?: string;
  messageId?: string;
  lastReplyMessageId?: string;
};

/**
 * Destinatário do alerta já entregue (`SENT`, `createdAt` = `T0`), com as colunas
 * de pendência dadas; `ackAt` dado grava também a ciência por palavra. Devolve o id.
 */
export async function newPendency(
  db: PendencyDb,
  input: NewPendencyInput,
): Promise<string> {
  const { ackAt, handlerId, assignedAt, dueAt, closedAt } = input;
  const row = await db.prisma.teamWhatsappRecipient.create({
    data: {
      dispatchId: input.dispatchId,
      userId: input.userId,
      userName: input.userName ?? `Pessoa ${nextSeq()}`,
      sectorId: input.sectorId,
      sectorName: input.sectorName,
      status: 'SENT',
      messageId: input.messageId,
      lastReplyMessageId: input.lastReplyMessageId,
      ackAt,
      ackKind: ackAt ? 'KEYWORD' : undefined,
      pendencyHandlerId: handlerId,
      pendencyAssignedAt: assignedAt,
      pendencyDueAt: dueAt,
      pendencyClosedAt: closedAt,
      pendencyClosedById: input.closedById,
      pendencyCloseReason: input.closeReason,
      createdAt: T0,
      updatedAt: T0,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Anotação por escrita direta, só para semear testes de LEITURA (histórico da
 * pendência); as ações reais gravam pelo serviço (GK3). Devolve o id.
 */
export async function newPendencyNote(
  db: PendencyDb,
  note: {
    recipientId: string;
    authorId: string;
    kind: TeamPendencyNoteKind;
    text: string;
    createdAt: Date;
  },
): Promise<string> {
  const row = await db.prisma.teamPendencyNote.create({
    data: note,
    select: { id: true },
  });
  return row.id;
}

/** Liga `key` para o papel pela matriz que `findEffectivePermissions` lê (`RolePermission`). */
export function grantPermission(
  db: PendencyDb,
  role: Role,
  key: string,
): Promise<unknown> {
  return setPermission(db, role, key, true);
}

/**
 * Desliga `key` com linha explícita `granted: false`: apagar a linha devolveria
 * o padrão da matriz, que pode ser ligado (ex.: `equipe.enviar`).
 */
export function revokePermission(
  db: PendencyDb,
  role: Role,
  key: string,
): Promise<unknown> {
  return setPermission(db, role, key, false);
}

function setPermission(
  db: PendencyDb,
  role: Role,
  key: string,
  granted: boolean,
): Promise<unknown> {
  const where: Prisma.RolePermissionWhereUniqueInput = {
    role_key: { role, key },
  };
  return db.prisma.rolePermission.upsert({
    where,
    create: { role, key, granted },
    update: { granted },
  });
}
