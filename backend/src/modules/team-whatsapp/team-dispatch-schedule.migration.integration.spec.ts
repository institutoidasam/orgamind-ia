import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes do agendamento com reconferência (Lote G, DG1).
const BEFORE_RECHECK = '20261120120000_team_dispatch_purpose';
const TEMPLATE_DB = 'before_recheck';
const MIGRATED_DB = 'after_recheck';

const DISPATCH_COLUMNS = ['recheckedAt', 'audienceLateJoined'] as const;
const RECIPIENT_COLUMNS = ['phoneE164'] as const;

const NEW_SKIP_REASONS = [
  'VACATION',
  'DAY_OFF',
  'LEFT_SECTOR',
  'PHONE_CHANGED',
  'EXPIRED',
] as const;

let postgres: StartedPostgreSqlContainer;
let admin: PrismaClient;
let db: PrismaClient;

function urlFor(database: string): string {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Banco "de produção antes da migração" com um envio e um destinatário legados
 * em SQL cru; as migrações novas rodam por cima e `db` passa a apontar para o
 * resultado.
 */
async function migrateLegacyDispatch(): Promise<void> {
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${MIGRATED_DB}" TEMPLATE ${TEMPLATE_DB}`,
  );
  const databaseUrl = urlFor(MIGRATED_DB);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappDispatch" ("id","targetType","targetId","targetLabel","text","state","scheduledFor")
      VALUES ('d-legacy','SECTOR','s-x','Logística','oi','SCHEDULED','2026-12-01T12:00:00Z')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappRecipient" ("id","dispatchId","userName","status","updatedAt")
      VALUES ('r-legacy','d-legacy','Pessoa A','SCHEDULED',now())`,
  );
  deployMigrations({ databaseUrl });
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  admin = new PrismaClient({
    datasources: { db: { url: postgres.getConnectionUri() } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE ${TEMPLATE_DB}`);
  deployMigrations({
    databaseUrl: urlFor(TEMPLATE_DB),
    until: BEFORE_RECHECK,
  });
  await migrateLegacyDispatch();
}, 300_000);

afterAll(async () => {
  await db?.$disconnect();
  await admin?.$disconnect();
  await postgres?.stop();
});

describe('envio legado', () => {
  it('envio e destinatário anteriores ficam com recheckedAt, audienceLateJoined e phoneE164 nulos', async () => {
    const dispatch = await db.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id: 'd-legacy' },
    });
    const recipient = await db.teamWhatsappRecipient.findUniqueOrThrow({
      where: { id: 'r-legacy' },
    });

    expect(dispatch).toMatchObject({
      targetLabel: 'Logística',
      text: 'oi',
      state: 'SCHEDULED',
      recheckedAt: null,
      audienceLateJoined: null,
    });
    expect(recipient).toMatchObject({
      userName: 'Pessoa A',
      status: 'SCHEDULED',
      skipReason: null,
      phoneE164: null,
    });
  });
});

describe('valores novos', () => {
  it('aceita EXPIRED no envio e os cinco motivos novos no destinatário', async () => {
    const recheckedAt = new Date('2026-12-01T11:55:00.000Z');
    const dispatch = await db.teamWhatsappDispatch.create({
      data: {
        targetType: 'SECTOR',
        targetId: 's-x',
        targetLabel: 'Logística',
        text: 'oi',
        state: 'EXPIRED',
        recheckedAt,
        audienceLateJoined: [{ userId: 'u-9', sectorId: 's-x' }],
        recipients: {
          create: NEW_SKIP_REASONS.map((skipReason, i) => ({
            userName: `Pessoa ${i}`,
            status: 'SKIPPED' as const,
            skipReason,
            phoneE164: `+559299111000${i}`,
          })),
        },
      },
      include: { recipients: { orderBy: { userName: 'asc' } } },
    });

    expect(dispatch).toMatchObject({
      state: 'EXPIRED',
      recheckedAt,
      audienceLateJoined: [{ userId: 'u-9', sectorId: 's-x' }],
    });
    expect(dispatch.recipients.map((r) => r.skipReason)).toEqual([
      ...NEW_SKIP_REASONS,
    ]);
    expect(dispatch.recipients[0].phoneE164).toBe('+5592991110000');
  });
});

describe('colunas e índices novos', () => {
  it('nenhuma coluna nova é obrigatória', async () => {
    const columns = await db.$queryRaw<
      {
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`SELECT table_name, column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE (table_name = 'TeamWhatsappDispatch'
             AND column_name = ANY(${[...DISPATCH_COLUMNS]}))
         OR (table_name = 'TeamWhatsappRecipient'
             AND column_name = ANY(${[...RECIPIENT_COLUMNS]}))`;

    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [...DISPATCH_COLUMNS, ...RECIPIENT_COLUMNS].sort(),
    );
    expect(columns.every((c) => c.is_nullable === 'YES')).toBe(true);
    expect(columns.every((c) => c.column_default === null)).toBe(true);
  });

  it('índices de state e purpose com createdAt existem', async () => {
    const indexes = await db.$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'TeamWhatsappDispatch'`;
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));

    expect(byName.get('TeamWhatsappDispatch_state_createdAt_idx')).toContain(
      '(state, "createdAt")',
    );
    expect(byName.get('TeamWhatsappDispatch_purpose_createdAt_idx')).toContain(
      '(purpose, "createdAt")',
    );
  });
});
