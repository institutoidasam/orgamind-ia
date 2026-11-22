import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes da finalidade e do público do envio (Lote F, CF8).
const BEFORE_PURPOSE = '20261119130100_people_import_tables';
const TEMPLATE_DB = 'before_purpose';
const MIGRATED_DB = 'after_purpose';

const NEW_COLUMNS = [
  'purpose',
  'audienceBase',
  'activityDate',
  'activityTime',
  'activityPlace',
  'urgencyReason',
  'audienceRule',
  'audienceExcluded',
  'schedulePolicy',
] as const;

const PURPOSES = [
  'SHIFT_NOTICE',
  'MEETING',
  'ALIGNMENT',
  'LECTURE',
  'OVERTIME',
  'URGENCY',
] as const;
const BASES = ['ON_DUTY', 'ASSIGNED'] as const;
const POLICIES = ['IMMEDIATE', 'FROZEN_RECHECK'] as const;

let postgres: StartedPostgreSqlContainer;
let admin: PrismaClient;
let db: PrismaClient;

function urlFor(database: string): string {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Banco "de produção antes da migração" com um envio legado em SQL cru; as
 * migrações novas rodam por cima e `db` passa a apontar para o resultado.
 */
async function migrateLegacyDispatch(): Promise<void> {
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${MIGRATED_DB}" TEMPLATE ${TEMPLATE_DB}`,
  );
  const databaseUrl = urlFor(MIGRATED_DB);
  db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappDispatch" ("id","targetType","targetId","targetLabel","text")
      VALUES ('d-legacy','SECTOR','s-x','Logística','oi')`,
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
    until: BEFORE_PURPOSE,
  });
  await migrateLegacyDispatch();
}, 300_000);

afterAll(async () => {
  await db?.$disconnect();
  await admin?.$disconnect();
  await postgres?.stop();
});

describe('envio legado', () => {
  it('envio criado antes da migração fica com purpose, audienceBase, schedulePolicy e o resto nulos', async () => {
    const legacy = await db.teamWhatsappDispatch.findUniqueOrThrow({
      where: { id: 'd-legacy' },
    });

    expect(legacy).toMatchObject({
      targetLabel: 'Logística',
      text: 'oi',
      state: 'DISPATCHED',
      purpose: null,
      audienceBase: null,
      activityDate: null,
      activityTime: null,
      activityPlace: null,
      urgencyReason: null,
      audienceRule: null,
      audienceExcluded: null,
      schedulePolicy: null,
    });
  });
});

describe('valores novos', () => {
  it('aceita as seis finalidades, as duas bases e as duas políticas', async () => {
    const detail = {
      activityDate: new Date('2026-12-01T00:00:00.000Z'),
      activityTime: '14:30',
      activityPlace: 'Sala 2',
      urgencyReason: 'Falta de energia',
      audienceRule: { sectors: ['s-x'], shifts: [] },
      audienceExcluded: [{ userId: 'u-1', reason: 'Em férias' }],
    };
    const created = await Promise.all(
      PURPOSES.map((purpose, i) =>
        db.teamWhatsappDispatch.create({
          data: {
            targetType: 'SECTOR',
            targetId: 's-x',
            targetLabel: 'Logística',
            text: 'oi',
            purpose,
            audienceBase: BASES[i % BASES.length],
            schedulePolicy: POLICIES[i % POLICIES.length],
            ...detail,
          },
        }),
      ),
    );

    expect(created.map((d) => d.purpose)).toEqual([...PURPOSES]);
    expect(new Set(created.map((d) => d.audienceBase))).toEqual(new Set(BASES));
    expect(new Set(created.map((d) => d.schedulePolicy))).toEqual(
      new Set(POLICIES),
    );
    expect(created[0]).toMatchObject(detail);
  });
});

describe('colunas novas', () => {
  it('nenhuma coluna nova é obrigatória', async () => {
    const columns = await db.$queryRaw<
      {
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'TeamWhatsappDispatch'
        AND column_name = ANY(${[...NEW_COLUMNS]})`;

    expect(columns.map((c) => c.column_name).sort()).toEqual(
      [...NEW_COLUMNS].sort(),
    );
    expect(columns.every((c) => c.is_nullable === 'YES')).toBe(true);
    expect(columns.every((c) => c.column_default === null)).toBe(true);
  });
});
