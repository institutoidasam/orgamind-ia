import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

// Última migração antes da ciência do alerta urgente (Lote I, DI1).
const BEFORE_ALERT = '20261120140000_team_recipient_tracking';
const TEMPLATE_DB = 'before_alert';
const MIGRATED_DB = 'after_alert';

let postgres: StartedPostgreSqlContainer;
let admin: PrismaClient;
let db: PrismaClient;
let rolePermissionsBefore = 0;

function urlFor(database: string): string {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Banco "de produção antes da migração" com um envio e um destinatário legados
 * em SQL cru; a migração nova roda por cima e `db` passa a apontar para o
 * resultado. Guarda quantas `RolePermission` existiam antes (DI1: nenhuma nova).
 */
async function migrateLegacyDispatch(): Promise<void> {
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
  const [{ total }] = await db.$queryRaw<
    { total: number }[]
  >`SELECT count(*)::int AS total FROM "RolePermission"`;
  rolePermissionsBefore = total;
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
  deployMigrations({ databaseUrl: urlFor(TEMPLATE_DB), until: BEFORE_ALERT });
  await migrateLegacyDispatch();
}, 300_000);

afterAll(async () => {
  await db?.$disconnect();
  await admin?.$disconnect();
  await postgres?.stop();
});

/** Envio mínimo em SQL do Prisma, com os campos obrigatórios. */
function newDispatch(id: string, extra: Record<string, unknown> = {}) {
  return db.teamWhatsappDispatch.create({
    data: {
      id,
      targetType: 'SECTOR',
      targetId: 's-x',
      targetLabel: 'Logística',
      text: 'oi',
      ...extra,
    },
  });
}

describe('envio e destinatário legados', () => {
  it('envio e destinatário anteriores ficam com as colunas novas nulas e reminderCount 0', async () => {
    const dispatch = await db.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id: 'd-legacy' },
    });
    const recipient = await db.teamWhatsappRecipient.findUniqueOrThrow({
      where: { id: 'r-legacy' },
    });

    expect(dispatch).toMatchObject({
      ackDeadlineMinutes: null,
      parentDispatchId: null,
      reminderCount: 0,
      lastReminderAt: null,
    });
    expect(recipient).toMatchObject({
      userName: 'Pessoa A',
      status: 'SENT',
      ackAt: null,
      ackKind: null,
      ackByUserId: null,
      ackNote: null,
      ackMessageId: null,
      ackMessageAt: null,
      lastReplyMessageId: null,
      parentRecipientId: null,
    });
  });

  it('a migração não cria linha em RolePermission', async () => {
    const [{ total }] = await db.$queryRaw<
      { total: number }[]
    >`SELECT count(*)::int AS total FROM "RolePermission"`;

    expect(total).toBe(rolePermissionsBefore);
  });
});

describe('valores novos dos enums', () => {
  it('ACKED e TeamAlertAckKind aceitos', async () => {
    const ackAt = new Date('2026-12-01T12:00:00.000Z');
    const ackNote = 'x'.repeat(200);
    const keyword = await db.teamWhatsappRecipient.create({
      data: {
        dispatchId: 'd-legacy',
        userName: 'Pessoa B',
        status: 'SKIPPED',
        skipReason: 'ACKED',
        ackAt,
        ackKind: 'KEYWORD',
        ackMessageId: 'm-1',
        ackMessageAt: ackAt,
        lastReplyMessageId: 'm-2',
      },
    });
    const manual = await db.teamWhatsappRecipient.create({
      data: {
        dispatchId: 'd-legacy',
        userName: 'Pessoa C',
        status: 'SENT',
        ackAt,
        ackKind: 'MANUAL',
        ackByUserId: 'u-x',
        ackNote,
      },
    });

    expect(keyword).toMatchObject({ skipReason: 'ACKED', ackKind: 'KEYWORD' });
    expect(keyword.ackMessageAt).toEqual(ackAt);
    expect(manual).toMatchObject({ ackKind: 'MANUAL', ackNote });
  });
});

describe('chaves do lembrete', () => {
  it('apagar o alerta deixa parentDispatchId e parentRecipientId nulos no lembrete', async () => {
    await newDispatch('d-alert', { ackDeadlineMinutes: 15 });
    await db.teamWhatsappRecipient.create({
      data: { id: 'r-alert', dispatchId: 'd-alert', userName: 'Pessoa D' },
    });
    await newDispatch('d-reminder', { parentDispatchId: 'd-alert' });
    await db.teamWhatsappRecipient.create({
      data: {
        id: 'r-reminder',
        dispatchId: 'd-reminder',
        userName: 'Pessoa D',
        parentRecipientId: 'r-alert',
      },
    });

    await db.teamWhatsappDispatch.delete({ where: { id: 'd-alert' } });

    const reminder = await db.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id: 'd-reminder' },
    });
    const recipient = await db.teamWhatsappRecipient.findUniqueOrThrow({
      where: { id: 'r-reminder' },
    });
    expect(reminder.parentDispatchId).toBeNull();
    expect(recipient.parentRecipientId).toBeNull();
  });

  it('índices de parentDispatchId e parentRecipientId existem', async () => {
    const indexes = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'TeamWhatsappDispatch_parentDispatchId_idx',
        'TeamWhatsappRecipient_parentRecipientId_idx')`;

    expect(indexes.map((index) => index.indexname).sort()).toEqual([
      'TeamWhatsappDispatch_parentDispatchId_idx',
      'TeamWhatsappRecipient_parentRecipientId_idx',
    ]);
  });
});

describe('createDispatch e o prazo do alerta', () => {
  it('createDispatch grava ackDeadlineMinutes; sem o campo, null', async () => {
    const author = await db.user.create({
      data: { email: 'alerta-mig@test.local', password: 'x', name: 'Pessoa E' },
    });
    const repo = new TeamWhatsappRepository(
      db as never,
      new StaffScheduleRepository(db as never),
    );
    const base = {
      authorId: author.id,
      targetType: 'SECTOR' as const,
      targetId: 's-x',
      targetLabel: 'Logística',
      shiftId: null,
      shiftName: null,
      shiftStartTime: null,
      shiftEndTime: null,
      channelId: null,
      text: 'oi',
      sectors: [{ sectorId: 's-x', sectorName: 'Logística' }],
      recipients: [],
    };

    const alert = await repo.createDispatch({
      ...base,
      ackDeadlineMinutes: 15,
    });
    const plain = await repo.createDispatch(base);

    const rows = await db.teamWhatsappDispatch.findMany({
      where: { id: { in: [alert.id, plain.id] } },
      select: { id: true, ackDeadlineMinutes: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.ackDeadlineMinutes]));
    expect(byId.get(alert.id)).toBe(15);
    expect(byId.get(plain.id)).toBeNull();
  });
});
