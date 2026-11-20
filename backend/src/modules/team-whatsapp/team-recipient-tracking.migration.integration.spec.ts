import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes do rastreio do envio (Lote H, DH1).
const BEFORE_TRACKING = '20261120130000_team_dispatch_schedule_recheck';
const TEMPLATE_DB = 'before_tracking';
const MIGRATED_DB = 'after_tracking';

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
 * em SQL cru; a migração nova roda por cima e `db` passa a apontar para o
 * resultado.
 */
async function migrateLegacyRecipient(): Promise<void> {
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${MIGRATED_DB}" TEMPLATE ${TEMPLATE_DB}`,
  );
  const databaseUrl = urlFor(MIGRATED_DB);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappDispatch" ("id","targetType","targetId","targetLabel","text","state")
      VALUES ('d-legacy','SECTOR','s-x','Logística','oi','DISPATCHED')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappRecipient" ("id","dispatchId","userName","status","updatedAt")
      VALUES ('r-legacy','d-legacy','Pessoa A','SENT',now())`,
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
    until: BEFORE_TRACKING,
  });
  await migrateLegacyRecipient();
}, 300_000);

afterAll(async () => {
  await db?.$disconnect();
  await admin?.$disconnect();
  await postgres?.stop();
});

describe('destinatário legado', () => {
  it('destinatário anterior fica com channelCheckedAt nulo', async () => {
    const recipient = await db.teamWhatsappRecipient.findUniqueOrThrow({
      where: { id: 'r-legacy' },
    });

    expect(recipient).toMatchObject({
      userName: 'Pessoa A',
      status: 'SENT',
      channelCheckedAt: null,
    });
  });
});

describe('coluna channelCheckedAt', () => {
  it('channelCheckedAt não é obrigatório e aceita data', async () => {
    const columns = await db.$queryRaw<
      { is_nullable: string; column_default: string | null }[]
    >`SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'TeamWhatsappRecipient'
        AND column_name = 'channelCheckedAt'`;
    const channelCheckedAt = new Date('2026-12-01T11:55:00.000Z');
    const recipient = await db.teamWhatsappRecipient.create({
      data: {
        dispatchId: 'd-legacy',
        userName: 'Pessoa B',
        status: 'SENT',
        channelCheckedAt,
      },
    });

    expect(columns).toEqual([{ is_nullable: 'YES', column_default: null }]);
    expect(recipient.channelCheckedAt).toEqual(channelCheckedAt);
  });
});

describe('índice do verificador', () => {
  it('índice de status e updatedAt existe', async () => {
    const indexes = await db.$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'TeamWhatsappRecipient'
        AND indexname = 'TeamWhatsappRecipient_status_updatedAt_idx'`;

    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('(status, "updatedAt")');
  });
});
