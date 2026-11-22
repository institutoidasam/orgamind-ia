import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes da ficha da pessoa e da trilha (20261119090000 em diante).
const BEFORE_PERSON_RECORD = '20261110092000_team_recipient_tracking';

type AuditRow = {
  id: string;
  subjectUserId: string | null;
  category: string | null;
};

// Como o backfill deve deixar cada evento antigo (C1/C2/D18).
const AUDIT_AFTER: AuditRow[] = [
  { id: 'a-campaign', subjectUserId: null, category: null },
  { id: 'a-login', subjectUserId: null, category: null },
  { id: 'a-removed', subjectUserId: 'u-op', category: 'ASSIGNMENT' },
  { id: 'a-sched', subjectUserId: 'u-op', category: 'SCHEDULE' },
  { id: 'a-sector', subjectUserId: null, category: 'STRUCTURE' },
  { id: 'a-user', subjectUserId: 'u-old', category: 'PERSON' },
];

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let deployStartedAt: Date;

// Produção antes da migração: duas pessoas e um histórico de auditoria misto.
async function seedLegacyData(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "email", "password", "role", "updatedAt") VALUES
      ('u-old', 'old@test.local', 'hash', 'ADMIN', now()),
      ('u-op', 'op@test.local', 'hash', 'OPERATOR', now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "AuditEvent" ("id", "action", "entity", "entityId", "metadata") VALUES
      ('a-user', 'user.updated', 'User', 'u-old', NULL),
      ('a-sched', 'staff_schedule.put', 'StaffSchedule', 'u-op', '{"actorId":"u-old","userId":"u-op"}'),
      ('a-removed', 'sector_people.removed', 'Sector', 's-1', '{"userId":"u-op","sectorId":"s-1"}'),
      ('a-sector', 'sector.updated', 'Sector', 's-1', NULL),
      ('a-campaign', 'campaign.create', 'Campaign', 'c-1', NULL),
      ('a-login', 'auth.login_success', 'User', 'u-old', NULL)`,
  );
}

function insertPerson(db: PrismaClient, id: string, key?: string) {
  return db.$executeRaw`
    INSERT INTO "User" ("id", "email", "password", "role", "updatedAt", "registrationKey")
    VALUES (${id}, ${`${id}@test.local`}, 'hash', 'VIEWER', now(), ${key ?? null})`;
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_PERSON_RECORD });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedLegacyData(prisma);
  deployStartedAt = new Date();
  deployMigrations({ databaseUrl });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('migração 20261119091000_person_record_and_trail — autorização', () => {
  it('pessoa existente vira AUTORIZADO / CADASTRO_ANTERIOR, data e autor nulos, registrado em preenchido', async () => {
    const [person] = await prisma.$queryRaw<
      {
        contactAuthorization: string;
        authorizationSource: string | null;
        authorizationDate: Date | null;
        authorizationRecordedById: string | null;
        authorizationRecordedAt: Date | null;
      }[]
    >`SELECT "contactAuthorization", "authorizationSource", "authorizationDate",
        "authorizationRecordedById", "authorizationRecordedAt"
      FROM "User" WHERE "id" = 'u-old'`;

    expect(person).toMatchObject({
      contactAuthorization: 'AUTORIZADO',
      authorizationSource: 'CADASTRO_ANTERIOR',
      authorizationDate: null,
      authorizationRecordedById: null,
    });
    // `NOW()` do banco e relógio do teste são da mesma máquina (margem de 5 s).
    expect(person.authorizationRecordedAt?.getTime()).toBeGreaterThanOrEqual(
      deployStartedAt.getTime() - 5_000,
    );
  });

  it('pessoa inserida depois sem o campo fica NAO_AUTORIZADO', async () => {
    await insertPerson(prisma, 'u-new');

    const [person] = await prisma.$queryRaw<
      { contactAuthorization: string; authorizationSource: string | null }[]
    >`SELECT "contactAuthorization", "authorizationSource" FROM "User" WHERE "id" = 'u-new'`;

    expect(person).toEqual({
      contactAuthorization: 'NAO_AUTORIZADO',
      authorizationSource: null,
    });
  });

  it('registrationKey repetida estoura unique', async () => {
    await insertPerson(prisma, 'u-key-1', 'm-100');

    // 23505 = unique_violation do Postgres.
    await expect(insertPerson(prisma, 'u-key-2', 'm-100')).rejects.toThrow(
      /23505[\s\S]*registrationKey/,
    );
  });
});

describe('migração 20261119091000_person_record_and_trail — trilha', () => {
  it('AuditEvent antigo: User → subjectUserId = entityId e PERSON; staff_schedule.put → subjectUserId = metadata.userId e SCHEDULE; campaign.create → categoria nula', async () => {
    const rows = await prisma.$queryRaw<AuditRow[]>`
      SELECT "id", "subjectUserId", "category" FROM "AuditEvent" ORDER BY "id"`;

    expect(rows).toEqual(AUDIT_AFTER);
  });

  it('AuditEvent antigo auth.login_success (entity User) fica com subjectUserId e categoria nulos', async () => {
    const [login] = await prisma.$queryRaw<AuditRow[]>`
      SELECT "id", "subjectUserId", "category" FROM "AuditEvent" WHERE "id" = 'a-login'`;

    expect(login).toEqual({
      id: 'a-login',
      subjectUserId: null,
      category: null,
    });
  });
});

describe('migração 20261119090000_team_skip_not_authorized', () => {
  it('TeamWhatsappRecipient aceita skipReason NOT_AUTHORIZED', async () => {
    await prisma.$executeRaw`
      INSERT INTO "TeamWhatsappDispatch" ("id", "targetType", "targetId", "targetLabel", "text")
      VALUES ('d-1', 'USER', 'u-old', 'Pessoa', 'Olá')`;
    await prisma.$executeRaw`
      INSERT INTO "TeamWhatsappRecipient" ("id", "dispatchId", "userName", "status", "skipReason", "updatedAt")
      VALUES ('r-1', 'd-1', 'Pessoa', 'SKIPPED', 'NOT_AUTHORIZED', now())`;

    const [recipient] = await prisma.$queryRaw<{ skipReason: string }[]>`
      SELECT "skipReason" FROM "TeamWhatsappRecipient" WHERE "id" = 'r-1'`;

    expect(recipient.skipReason).toBe('NOT_AUTHORIZED');
  });
});
