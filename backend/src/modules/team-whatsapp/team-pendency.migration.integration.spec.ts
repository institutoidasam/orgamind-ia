import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { findEffectivePermissions } from '../permissions/permissions.query';
import {
  at,
  grantPermission,
  holdRecipientLock,
  newAlert,
  newPendency,
  newPendencyNote,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  waitForAnyLockWait,
  type PendencyDb,
} from './team-pendency.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.migration.integration.spec.ts
 */
const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

// Última migração antes da pendência da equipe (20261121120000).
const BEFORE_PENDENCY = '20261121100000_conversation_situation_history';
const PENDENCY_COLUMNS = [
  'pendencyHandlerId',
  'pendencyAssignedAt',
  'pendencyDueAt',
  'pendencyClosedAt',
  'pendencyClosedById',
  'pendencyCloseReason',
];

type RecipientRow = Record<string, unknown> & { id: string };

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let legacyRows: RecipientRow[];

// Produção antes da migração: um envio, um destinatário com ciência e outro sem.
async function seedLegacyRecipients(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappDispatch" ("id","targetType","targetId","targetLabel","text","state","createdAt")
      VALUES ('d-legacy','SECTOR','s-x','Logística','oi','DISPATCHED','2026-11-02T12:00:00Z')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappRecipient" ("id","dispatchId","userName","status","ackAt","ackKind","createdAt","updatedAt") VALUES
      ('r-acked','d-legacy','Pessoa A','SENT','2026-11-02T12:05:00Z','KEYWORD','2026-11-02T12:00:00Z','2026-11-02T12:05:00Z'),
      ('r-open','d-legacy','Pessoa B','SENT',NULL,NULL,'2026-11-02T12:00:00Z','2026-11-02T12:01:00Z')`,
  );
}

function readRecipients(db: PrismaClient): Promise<RecipientRow[]> {
  return db.$queryRaw<RecipientRow[]>`
    SELECT * FROM "TeamWhatsappRecipient" ORDER BY "id"`;
}

// Sobe o Postgres, aplica as migrações até a anterior, grava os legados, lê o
// estado antes e aplica a nova migração com conexão nova (o `SELECT *` preparado
// antes dela falharia com "cached plan must not change result type").
async function migrateWithLegacyData(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_PENDENCY });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedLegacyRecipients(prisma);
  legacyRows = await readRecipients(prisma);
  await prisma.$disconnect();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

function insertNote(recipientId: string, text: string): Promise<number> {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "TeamPendencyNote" ("id","recipientId","kind","authorId","text","createdAt")
      VALUES ('n-' || md5(random()::text), '${recipientId}', 'CONTACT'::"TeamPendencyNoteKind",
        'user-removido', '${text}', '2026-11-04T12:00:00Z')`,
  );
}

async function countNotes(recipientId: string): Promise<number> {
  const [{ total }] = await prisma.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total FROM "TeamPendencyNote"
    WHERE "recipientId" = ${recipientId}`;
  return total;
}

// Todas as colunas antigas (inclusive `ackAt` e `updatedAt`) seguem iguais e as
// seis da pendência ficam nulas.
function expectLegacyRowsUnchanged(after: RecipientRow[]): void {
  expect(legacyRows.map((row) => row.ackAt === null)).toEqual([false, true]);
  expect(after).toHaveLength(legacyRows.length);
  after.forEach((row, index) => {
    const pendency = Object.fromEntries(
      PENDENCY_COLUMNS.map((column) => [column, row[column]]),
    );
    const rest = Object.fromEntries(
      Object.entries(row).filter(
        ([column]) => !PENDENCY_COLUMNS.includes(column),
      ),
    );
    expect(Object.values(pendency).every((value) => value === null)).toBe(true);
    expect(rest).toEqual(legacyRows[index]);
  });
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'migração 20261121120000_team_pendency (integração)',
  () => {
    beforeAll(migrateWithLegacyData, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await postgres?.stop();
    });

    it('destinatários existentes ficam iguais depois da migração, com as colunas de pendência nulas', async () => {
      expectLegacyRowsUnchanged(await readRecipients(prisma));
    });

    it('anotação com texto de 201 caracteres é recusada pelo banco (200 passa)', async () => {
      await expect(insertNote('r-open', 'x'.repeat(200))).resolves.toBe(1);
      await expect(insertNote('r-open', 'x'.repeat(201))).rejects.toThrow(
        /22001|too long/i,
      );
    });

    it('apagar o destinatário apaga as anotações (Cascade)', async () => {
      await insertNote('r-acked', 'ligou');
      expect(await countNotes('r-acked')).toBe(1);

      await prisma.$executeRaw`DELETE FROM "TeamWhatsappRecipient" WHERE "id" = 'r-acked'`;

      expect(await countNotes('r-acked')).toBe(0);
    });

    it('authorId e pendencyHandlerId de usuário inexistente são aceitos (sem FK)', async () => {
      await expect(insertNote('r-open', 'sem usuário')).resolves.toBe(1);
      await expect(
        prisma.$executeRaw`UPDATE "TeamWhatsappRecipient"
          SET "pendencyHandlerId" = 'user-removido', "pendencyClosedById" = 'user-removido'
          WHERE "id" = 'r-open'`,
      ).resolves.toBe(1);
    });
  },
);

let fixturesDb: PendencyDb;

async function holdLockBlocksUpdate(): Promise<void> {
  const db = fixturesDb;
  const sector = await newSector(db);
  const author = await newTeamUser(db, {
    role: 'SUPERVISOR',
    sectorId: sector.id,
  });
  const dispatchId = await newAlert(db, {
    authorId: author.id,
    createdAt: new Date('2026-11-21T12:00:00.000Z'),
  });
  const recipientId = await newPendency(db, { dispatchId });
  const lock = await holdRecipientLock(db, recipientId);

  try {
    // O PrismaPromise é preguiçoso: `.then` dispara o UPDATE já, sem `await`.
    const update = db.prisma.teamWhatsappRecipient
      .update({
        where: { id: recipientId },
        data: { pendencyHandlerId: author.id },
      })
      .then((row) => row);
    await waitForAnyLockWait(db, 1);
    lock.release();
    await update;
  } finally {
    await lock.finish();
  }

  const row = await db.prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id: recipientId },
  });
  expect(row.pendencyHandlerId).toBe(author.id);
}

async function seedsMatchSchema(): Promise<void> {
  const db = fixturesDb;
  const sector = await newSector(db);
  const gone = await newTeamUser(db, { role: 'VIEWER', hasAccess: false });
  const dispatchId = await newAlert(db, {
    authorId: gone.id,
    createdAt: at(0),
    ackDeadlineMinutes: 30,
  });
  const recipientId = await newPendency(db, {
    dispatchId,
    sectorId: sector.id,
    sectorName: sector.name,
    handlerId: gone.id,
    assignedAt: at(5),
    dueAt: at(65),
    closedAt: at(70),
    closedById: gone.id,
    closeReason: 'Resolvido por telefone',
  });
  await newPendencyNote(db, {
    recipientId,
    authorId: gone.id,
    kind: 'CLOSE',
    text: 'Resolvido por telefone',
    createdAt: at(70),
  });
  await revokePermission(db, 'SUPERVISOR', 'equipe.enviar');
  const revoked = await findEffectivePermissions(db.prisma, 'SUPERVISOR');
  await grantPermission(db, 'SUPERVISOR', 'equipe.enviar');
  const granted = await findEffectivePermissions(db.prisma, 'SUPERVISOR');

  const row = await db.prisma.teamWhatsappRecipient.findUniqueOrThrow({
    where: { id: recipientId },
    include: { pendencyNotes: true },
  });
  expect(row).toMatchObject({
    pendencyHandlerId: gone.id,
    pendencyDueAt: at(65),
    pendencyClosedAt: at(70),
    pendencyCloseReason: 'Resolvido por telefone',
    createdAt: at(0),
  });
  expect(row.pendencyNotes.map((note) => note.kind)).toEqual(['CLOSE']);
  expect(revoked).not.toContain('equipe.enviar');
  expect(granted).toContain('equipe.enviar');
}

describe.skipIf(!TESTCONTAINERS_ENABLED)('fixtures da pendência', () => {
  beforeAll(async () => {
    fixturesDb = await startPendencyDb();
  }, 180_000);

  afterAll(async () => {
    await stopPendencyDb(fixturesDb);
  });

  it(
    'fixtures: holdRecipientLock bloqueia um UPDATE da linha até release',
    holdLockBlocksUpdate,
    30_000,
  );

  it(
    'fixtures: sementes gravam pendência e anotação (usuário sem acesso incluso) e a matriz que findEffectivePermissions lê',
    seedsMatchSchema,
    30_000,
  );
});
