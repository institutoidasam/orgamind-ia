import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-situation.migration.integration.spec.ts
 */
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

// Última migração antes da situação e do histórico da conversa (20261121100000).
const BEFORE_SITUATION = '20261120150000_team_alert_ack';

type ConversationRow = Record<string, unknown> & { id: string };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let legacyRows: ConversationRow[];

// Produção antes da migração: uma conversa com atendente e outra sem.
async function seedLegacyConversations(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "password", "hasAccess", "role", "isActive", "updatedAt")
      VALUES ('u-agent', 'agent@test.local', 'hash', true, 'OPERATOR', true, '2026-11-01T12:00:00Z')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "WhatsappInstance" ("id", "name", "updatedAt")
      VALUES ('inst-1', 'Canal de teste', '2026-11-01T12:00:00Z')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "Conversation" ("id", "instanceId", "remoteJid", "phoneE164", "unreadCount",
        "assignedUserId", "assignedAt", "lastMessageAt", "createdAt", "updatedAt") VALUES
      ('conv-with-agent', 'inst-1', '5592991110001@s.whatsapp.net', '+5592991110001', 2,
        'u-agent', '2026-11-02T13:00:00Z', '2026-11-02T12:30:00Z', '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z'),
      ('conv-no-agent', 'inst-1', '5592991110002@s.whatsapp.net', '+5592991110002', 0,
        NULL, NULL, '2026-11-03T12:30:00Z', '2026-11-03T12:00:00Z', '2026-11-03T12:30:00Z')`,
  );
}

function readConversations(db: PrismaClient): Promise<ConversationRow[]> {
  return db.$queryRaw<ConversationRow[]>`
    SELECT * FROM "Conversation" ORDER BY "id"`;
}

function insertHistory(note: string, conversationId: string): Promise<number> {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "ConversationHistoryEntry"
        ("id", "conversationId", "action", "actorId", "fromUserId", "toUserId", "note", "createdAt")
      VALUES ('h-' || md5(random()::text), '${conversationId}', 'TRANSFERRED'::"ConversationHistoryAction",
        'user-removido', 'user-removido-de', 'user-removido-para', '${note}', '2026-11-04T12:00:00Z')`,
  );
}

async function countHistory(conversationId: string): Promise<number> {
  const [{ total }] = await prisma.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total FROM "ConversationHistoryEntry"
    WHERE "conversationId" = ${conversationId}`;
  return total;
}

// Sobe o Postgres, aplica as migrações até a anterior, grava as conversas
// legadas, lê o estado antes e aplica a nova migração com conexão nova (o
// `SELECT *` preparado antes dela falharia com "cached plan must not change
// result type").
async function migrateWithLegacyData(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_SITUATION });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedLegacyConversations(prisma);
  legacyRows = await readConversations(prisma);
  await prisma.$disconnect();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

// Uma conversa sem atendente e outra com: depois da migração as colunas antigas
// seguem iguais (inclusive o atendente) e a marca de resolução é nula.
function expectLegacyRowsUnchanged(after: ConversationRow[]): void {
  expect(legacyRows.map((row) => row.assignedUserId)).toEqual([
    null,
    'u-agent',
  ]);
  expect(after).toHaveLength(legacyRows.length);
  after.forEach((row, index) => {
    const { resolvedAt, ...rest } = row;
    expect(resolvedAt).toBeNull();
    expect(rest).toEqual(legacyRows[index]);
  });
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'migração 20261121100000_conversation_situation_history (integração)',
  () => {
    beforeAll(migrateWithLegacyData, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await postgres?.stop();
    });

    it('aceite 1: conversas existentes com e sem atendente ficam iguais depois da migração, com resolvedAt nulo', async () => {
      expectLegacyRowsUnchanged(await readConversations(prisma));
    });

    it('linha de histórico com actorId de usuário inexistente é aceita (sem FK)', async () => {
      await expect(
        insertHistory('passou o turno', 'conv-with-agent'),
      ).resolves.toBe(1);
      expect(await countHistory('conv-with-agent')).toBe(1);
    });

    it('apagar a conversa apaga o histórico (Cascade)', async () => {
      await insertHistory('', 'conv-no-agent');
      expect(await countHistory('conv-no-agent')).toBe(1);

      await prisma.$executeRaw`DELETE FROM "Conversation" WHERE "id" = 'conv-no-agent'`;

      expect(await countHistory('conv-no-agent')).toBe(0);
    });

    it('note com 201 caracteres é recusada pelo banco (200 passa)', async () => {
      await expect(
        insertHistory('x'.repeat(200), 'conv-with-agent'),
      ).resolves.toBe(1);
      await expect(
        insertHistory('x'.repeat(201), 'conv-with-agent'),
      ).rejects.toThrow(/22001|too long/i);
    });
  },
);
