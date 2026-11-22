import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { ChatRepository } from './chat.repository';
import { ConversationOwnershipService } from './conversation-ownership.service';

/** Banco real (testcontainer) e serviço de propriedade para os specs de integração de K1 (GK11). */
export const T0 = new Date('2026-11-21T12:00:00.000Z');
export const at = (minute: number) => new Date(T0.getTime() + minute * 60_000);

export type OwnershipDb = {
  postgres: StartedPostgreSqlContainer;
  /** Código sob teste: `connection_limit=5`, para nenhum comando esperar conexão (DK22). */
  prisma: PrismaClient;
  audit: AuditService;
  ids: Record<'admin' | 'ana' | 'bia', string>;
  channelId: string;
};

export function withConnectionLimit(uri: string, limit: number): string {
  const url = new URL(uri);
  url.searchParams.set('connection_limit', String(limit));
  return url.toString();
}

const USERS = [
  ['admin', 'Zé Admin', 'ADMIN'],
  ['ana', 'Ana Atendente', 'OPERATOR'],
  ['bia', 'bia atendente', 'OPERATOR'],
] as const;

export async function startOwnershipDb(): Promise<OwnershipDb> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  deployMigrations({ databaseUrl: postgres.getConnectionUri() });
  const prisma = new PrismaClient({
    datasourceUrl: withConnectionLimit(postgres.getConnectionUri(), 5),
  });
  const ids: Record<string, string> = {};
  for (const [key, name, role] of USERS) {
    const user = await prisma.user.create({
      data: { email: `${key}@test.local`, password: 'x', role, name },
      select: { id: true },
    });
    ids[key] = user.id;
  }
  const channel = await prisma.channel.create({
    data: { name: 'Canal de teste' },
    select: { id: true },
  });
  const audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  return {
    postgres,
    prisma,
    audit,
    ids,
    channelId: channel.id,
  };
}

export async function stopOwnershipDb(db?: OwnershipDb): Promise<void> {
  await db?.prisma.$disconnect();
  await db?.postgres.stop();
}

let seq = 0;

/** Conversa aberta com `lastInboundAt = T0`; `createdAt` explícito (GK8). */
export async function newConversation(
  db: OwnershipDb,
  over: object = {},
): Promise<string> {
  seq += 1;
  const id = `conv-k1-${seq}`;
  await db.prisma.conversation.create({
    data: {
      id,
      instanceId: db.channelId,
      remoteJid: `${id}@s.whatsapp.net`,
      createdAt: T0,
      updatedAt: T0,
      lastInboundAt: T0,
      ...over,
    },
  });
  return id;
}

/** Serviço real sobre o banco; só o `ChatEventsService` é um espião. */
export function ownershipService(db: OwnershipDb) {
  const events = { publish: vi.fn().mockResolvedValue(undefined) };
  const service = new ConversationOwnershipService(
    db.prisma as never,
    db.audit,
    events as never,
    new ChatRepository(db.prisma as never),
  );
  return { service, events };
}

export const conversationRow = (db: OwnershipDb, id: string) =>
  db.prisma.conversation.findUniqueOrThrow({ where: { id } });

export const historyRows = (db: OwnershipDb, id: string) =>
  db.prisma.conversationHistoryEntry.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

export const auditRows = (db: OwnershipDb, id: string) =>
  db.prisma.auditEvent.findMany({
    where: { entity: 'Conversation', entityId: id },
  });

export type ExternalLock = {
  /** Sessões do banco esperando a trava de linha (`FOR NO KEY UPDATE`). */
  blockedSessions(): Promise<number>;
  release(): void;
  /** Solta a trava, espera a transação externa e fecha o cliente dedicado. */
  finish(): Promise<void>;
};

/**
 * DK22/GK11: trava externa numa linha de `Conversation` por um segundo
 * `PrismaClient` dedicado (`connection_limit=2`: uma conexão segura a trava,
 * a outra conta as sessões bloqueadas).
 */
export async function holdConversationLock(
  db: OwnershipDb,
  conversationId: string,
): Promise<ExternalLock> {
  const locker = new PrismaClient({
    datasourceUrl: withConnectionLimit(db.postgres.getConnectionUri(), 2),
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => undefined;
  const acquiredLock = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = locker.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${conversationId} FOR NO KEY UPDATE`;
      acquired();
      await released;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await Promise.race([acquiredLock, held]);
  return {
    async blockedSessions() {
      const [row] = await locker.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE%'
          AND pid <> pg_backend_pid()`;
      return row.n;
    },
    release,
    async finish() {
      release();
      await held;
      await locker.$disconnect();
    },
  };
}

const POLL_MS = 50;
const POLL_LIMIT_MS = 5_000;

/** Poll de 50 ms até `count` sessões bloqueadas na trava; falha em 5 000 ms. */
export async function waitForBlocked(
  lock: ExternalLock,
  count: number,
): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while ((await lock.blockedSessions()) < count) {
    if (Date.now() > deadline) {
      throw new Error(`menos de ${count} sessão(ões) bloqueada(s) em 5 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Como `waitForBlocked`, mas conta QUALQUER sessão esperando trava de linha
 * (não só `FOR NO KEY UPDATE`): a ingestão pelo webhook faz `UPDATE` simples na
 * conversa antes da transação travada. Poll de 50 ms até 5 000 ms.
 */
export async function waitForAnyLockWait(
  db: OwnershipDb,
  count: number,
): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  for (;;) {
    const [row] = await db.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()
        AND pid <> pg_backend_pid()`;
    if (row.n >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`menos de ${count} sessão(ões) esperando trava em 5 s`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
