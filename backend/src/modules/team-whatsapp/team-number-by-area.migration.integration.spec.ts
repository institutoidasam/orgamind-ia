import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';

// Última migração antes do número por área e do rastreio por destinatário.
const BEFORE_NUMBER_BY_AREA = '20261022110000_team_dispatch_sectors';
const TEMPLATE_DB = 'legacy_base';

let postgres: StartedPostgreSqlContainer;
let admin: PrismaClient;

function urlFor(database: string): string {
  const url = new URL(postgres.getConnectionUri());
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Um banco por cenário, clonado do banco "de produção antes da migração":
 * `seed` grava os dados legados em SQL cru, as migrações novas rodam por cima e
 * `read` lê o resultado.
 */
async function migrateScenario<T>(opts: {
  database: string;
  seed: (db: PrismaClient) => Promise<void>;
  read: (db: PrismaClient) => Promise<T>;
}): Promise<T> {
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${opts.database}" TEMPLATE ${TEMPLATE_DB}`,
  );
  const databaseUrl = urlFor(opts.database);
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await opts.seed(db);
    deployMigrations({ databaseUrl });
    return await opts.read(db);
  } finally {
    await db.$disconnect();
  }
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
    until: BEFORE_NUMBER_BY_AREA,
  });
}, 300_000);

afterAll(async () => {
  await admin?.$disconnect();
  await postgres?.stop();
});

// ---------------------------------------------------------------------------
// Associação área ↔ número (spec §9)
// ---------------------------------------------------------------------------

type ChannelSeed = {
  id: string;
  provider: 'GOZAP' | 'EVOLUTION' | 'TWILIO';
  isDefault?: boolean;
  isActive?: boolean;
  /** Dia de janeiro de 2026 em que o canal foi criado: menor = mais antigo. */
  day: number;
};

type AreaCase = {
  title: string;
  database: string;
  channels: ChannelSeed[];
  /** `SectorNumber` do cadastro antigo: [setor, canal]. */
  numbers?: [string, string][];
  expected: { log: string | null; rh: string | null; off: string | null };
};

const GOZAP_DEFAULT: ChannelSeed = {
  id: 'ch-gozap',
  provider: 'GOZAP',
  isDefault: true,
  day: 5,
};
const EVOLUTION: ChannelSeed = { id: 'ch-evo', provider: 'EVOLUTION', day: 1 };

// Logística (s-log) e RH (s-rh) ativos; "Inativo" (s-off) desativado.
const AREA_CASES: AreaCase[] = [
  {
    title: '(a) cadastro antigo vale; as demais vão para o padrão',
    database: 'assoc_a',
    channels: [GOZAP_DEFAULT, EVOLUTION],
    numbers: [['s-log', 'ch-evo']],
    expected: { log: 'ch-evo', rh: 'ch-gozap', off: null },
  },
  {
    title:
      '(b) cadastro antigo em TWILIO não conta; Logística vai para o padrão',
    database: 'assoc_b',
    channels: [GOZAP_DEFAULT, { id: 'ch-twilio', provider: 'TWILIO', day: 1 }],
    numbers: [['s-log', 'ch-twilio']],
    expected: { log: 'ch-gozap', rh: 'ch-gozap', off: null },
  },
  {
    title: '(c) padrão TWILIO não conta; o único elegível leva todas',
    database: 'assoc_c',
    channels: [
      { id: 'ch-twilio', provider: 'TWILIO', isDefault: true, day: 1 },
      { id: 'ch-gozap', provider: 'GOZAP', day: 2 },
    ],
    expected: { log: 'ch-gozap', rh: 'ch-gozap', off: null },
  },
  {
    title: '(d) dois GOZAP ativos e nenhum padrão: todas sem número',
    database: 'assoc_d',
    channels: [
      { id: 'ch-g1', provider: 'GOZAP', day: 1 },
      { id: 'ch-g2', provider: 'GOZAP', day: 2 },
    ],
    expected: { log: null, rh: null, off: null },
  },
  {
    title: '(e) setor inativo fica sem número mesmo com cadastro elegível',
    database: 'assoc_e',
    channels: [GOZAP_DEFAULT, EVOLUTION],
    numbers: [['s-off', 'ch-evo']],
    expected: { log: 'ch-gozap', rh: 'ch-gozap', off: null },
  },
  {
    title: '(f) padrão inativo não conta; o único elegível leva todas',
    database: 'assoc_f',
    channels: [{ ...GOZAP_DEFAULT, isActive: false }, EVOLUTION],
    expected: { log: 'ch-evo', rh: 'ch-evo', off: null },
  },
  {
    title: '(g) dois cadastros elegíveis: o padrão ganha do mais antigo',
    database: 'assoc_g',
    channels: [GOZAP_DEFAULT, EVOLUTION],
    numbers: [
      ['s-log', 'ch-evo'],
      ['s-log', 'ch-gozap'],
    ],
    expected: { log: 'ch-gozap', rh: 'ch-gozap', off: null },
  },
  {
    title: '(h) dois cadastros elegíveis sem padrão: o canal mais antigo',
    database: 'assoc_h',
    channels: [{ ...GOZAP_DEFAULT, isDefault: false }, EVOLUTION],
    numbers: [
      ['s-log', 'ch-gozap'],
      ['s-log', 'ch-evo'],
    ],
    expected: { log: 'ch-evo', rh: null, off: null },
  },
];

async function seedAreas(db: PrismaClient, c: AreaCase): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "Sector" ("id","name","code","isActive","updatedAt") VALUES
      ('s-log','Logística','LOG',true,now()),
      ('s-rh','RH','RH',true,now()),
      ('s-off','Inativo','OFF',false,now())`,
  );
  for (const ch of c.channels) {
    const createdAt = `2026-01-${String(ch.day).padStart(2, '0')}T00:00:00Z`;
    await db.$executeRaw`INSERT INTO "WhatsappInstance"
      ("id","name","provider","isDefault","isActive","createdAt","updatedAt")
      VALUES (${ch.id}, ${ch.id}, ${ch.provider}::"ChannelProvider",
        ${ch.isDefault ?? false}, ${ch.isActive ?? true}, ${createdAt}::timestamp, now())`;
  }
  for (const [i, [sectorId, channelId]] of (c.numbers ?? []).entries()) {
    await db.$executeRaw`INSERT INTO "SectorNumber"
      ("id","name","phone","provider","sectorId","channelId","updatedAt")
      VALUES (${`sn-${i}`}, ${`n${i}`}, ${`+55920000000${i}`},
        'OTHER'::"SectorNumberProvider", ${sectorId}, ${channelId}, now())`;
  }
}

async function readAreas(db: PrismaClient): Promise<AreaCase['expected']> {
  const rows = await db.sector.findMany({
    select: { id: true, channelId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r.channelId]));
  return {
    log: byId.get('s-log') ?? null,
    rh: byId.get('s-rh') ?? null,
    off: byId.get('s-off') ?? null,
  };
}

describe('associação', () => {
  it.each(AREA_CASES)(
    '$title',
    async (c) => {
      const result = await migrateScenario({
        database: c.database,
        seed: (db) => seedAreas(db, c),
        read: readAreas,
      });

      expect(result).toEqual(c.expected);
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// Destinatários legados (D3, D5, D11)
// ---------------------------------------------------------------------------

const SENT_AT = new Date('2026-11-01T12:00:00.000Z');
const FAILED_CASES = [
  ['team_whatsapp.indeterminate', 'UNCERTAIN'],
  ['gozap.timeout', 'UNCERTAIN'],
  ['evolution.unknown', 'UNCERTAIN'],
  ['sending_stuck', 'UNCERTAIN'],
  ['gozap.not_on_whatsapp', 'FAILED'],
  ['team_whatsapp.channel_disconnected', 'FAILED'],
  [null, 'FAILED'],
] as const;
const UNCHANGED_STATUSES = ['SKIPPED', 'SCHEDULED', 'CANCELLED'] as const;

async function seedLegacyRecipients(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "WhatsappInstance" ("id","name","provider","phoneE164","updatedAt")
      VALUES ('ch-gbr','GBR','GOZAP','+5592999991111',now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "Contact" ("id","phoneE164","updatedAt") VALUES ('ct-k','+5592988887777',now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "Message" ("id","contactId","instanceId","sentAt")
      VALUES ('msg-sent','ct-k','ch-gbr','${SENT_AT.toISOString()}')`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappDispatch" ("id","targetType","targetId","targetLabel","text","channelId") VALUES
      ('d-gbr','SECTOR','s-x','Logística','oi','ch-gbr'),
      ('d-none','SECTOR','s-x','Logística','oi',NULL)`,
  );
  const failed = FAILED_CASES.map(
    ([code], i) =>
      `('r-f-${i}','d-gbr','F${i}','FAILED',${code ? `'${code}'` : 'NULL'},now())`,
  );
  const unchanged = UNCHANGED_STATUSES.map(
    (status) => `('r-${status}','d-gbr','${status}','${status}',NULL,now())`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappRecipient" ("id","dispatchId","userName","status","errorCode","updatedAt") VALUES
      ${[...failed, ...unchanged].join(',\n')}`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappRecipient" ("id","dispatchId","userName","status","messageId","updatedAt") VALUES
      ('r-sent','d-gbr','Ana','SENT','msg-sent',now()),
      ('r-no-channel','d-none','Caio','SENT',NULL,now())`,
  );
}

let legacyDb: PrismaClient;

const recipientById = (id: string) =>
  legacyDb.teamWhatsappRecipient.findUniqueOrThrow({ where: { id } });

/** Migra o banco legado uma vez e abre `legacyDb` para os `it` do describe. */
function useMigratedLegacyRecipients(): void {
  beforeAll(async () => {
    await migrateScenario({
      database: 'legacy_recipients',
      seed: seedLegacyRecipients,
      read: () => Promise.resolve(),
    });
    legacyDb = new PrismaClient({
      datasources: { db: { url: urlFor('legacy_recipients') } },
    });
  }, 180_000);

  afterAll(async () => {
    await legacyDb?.$disconnect();
  });
}

describe('destinatários legados', () => {
  useMigratedLegacyRecipients();

  it('SENT guarda o canal do envio, o contato da mensagem e o aceite em sentAt', async () => {
    await expect(recipientById('r-sent')).resolves.toMatchObject({
      status: 'SENT',
      channelId: 'ch-gbr',
      channelName: 'GBR',
      channelPhoneE164: '+5592999991111',
      contactId: 'ct-k',
      acceptedAt: SENT_AT,
      attempts: 0,
      manualRetries: 0,
    });
  });

  it.each(FAILED_CASES.map(([code, status], i) => ({ i, code, status })))(
    'FAILED $code vira $status e o código fica',
    async ({ i, code, status }) => {
      await expect(recipientById(`r-f-${i}`)).resolves.toMatchObject({
        status,
        errorCode: code,
      });
    },
  );

  it.each(UNCHANGED_STATUSES)('%s não muda de status', async (status) => {
    await expect(recipientById(`r-${status}`)).resolves.toMatchObject({
      status,
      acceptedAt: null,
    });
  });

  it('envio sem canal deixa o destinatário sem canal', async () => {
    await expect(recipientById('r-no-channel')).resolves.toMatchObject({
      status: 'SENT',
      channelId: null,
      channelName: null,
      channelPhoneE164: null,
      contactId: null,
      acceptedAt: null,
    });
  });
});
