import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { deployMigrations } from '../../../test/migrations';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamWhatsappRepository } from './team-whatsapp.repository';
import { NO_SHIFT, NO_SNAPSHOT } from './team-whatsapp.test-fixtures';

// Última migração antes dos setores do envio (T7).
const BEFORE_DISPATCH_SECTORS = '20261022100000_user_without_access';

// Foto da escala do envio antigo (C10), sem telefone.
const OLD_ROSTER = {
  working: [
    {
      userId: null,
      name: 'Ana',
      jobTitle: null,
      shiftName: '2º turno',
      reason: null,
    },
  ],
  off: [],
};

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;

// Produção antes da migração: um agendado a Produção (2 destinatários), um envio
// a um setor já apagado e um envio a uma pessoa.
async function seedLegacyDispatches(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "Sector" ("id", "name", "code", "updatedAt")
      VALUES ('s-prod', 'Produção', 'PROD', now())`,
  );
  await db.$executeRaw`
    INSERT INTO "TeamWhatsappDispatch" ("id", "targetType", "targetId", "targetLabel",
      "shiftId", "shiftName", "shiftStartTime", "shiftEndTime", "rosterDate", "includeOff",
      "roster", "text", "state", "scheduledFor") VALUES
      ('d-prod', 'SECTOR', 's-prod', 'Produção · 2º turno · 21/10', 'shift_second', '2º turno',
        '14:00', '22:00', '2026-10-21', false, ${JSON.stringify(OLD_ROSTER)}::jsonb, 'oi',
        'SCHEDULED', '2026-10-21T18:00:00Z'),
      ('d-gone', 'SECTOR', 's-gone', 'Antigo · Noite · 21/10', NULL, NULL, NULL, NULL, NULL,
        false, NULL, 'oi', 'DISPATCHED', NULL),
      ('d-user', 'USER', 'u-x', 'Maria', NULL, NULL, NULL, NULL, NULL, false, NULL, 'oi',
        'DISPATCHED', NULL)`;
  await db.$executeRawUnsafe(
    `INSERT INTO "TeamWhatsappRecipient" ("id", "dispatchId", "userName", "shiftId",
      "shiftName", "status", "skipReason", "updatedAt") VALUES
      ('r-ana', 'd-prod', 'Ana', 'shift_second', '2º turno', 'SCHEDULED', NULL, now()),
      ('r-bia', 'd-prod', 'Bia', NULL, NULL, 'SKIPPED', 'NO_PHONE', now()),
      ('r-old', 'd-gone', 'Caio', NULL, NULL, 'SENT', NULL, now()),
      ('r-maria', 'd-user', 'Maria', NULL, NULL, 'FAILED', NULL, now())`,
  );
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl, until: BEFORE_DISPATCH_SECTORS });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await seedLegacyDispatches(prisma);
  deployMigrations({ databaseUrl });
  repo = new TeamWhatsappRepository(
    prisma as never,
    new StaffScheduleRepository(prisma as never),
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

const sectorRows = (dispatchId: string) =>
  prisma.teamWhatsappDispatchSector.findMany({
    where: { dispatchId },
    select: { sectorId: true, sectorName: true },
  });
const recipientSnapshot = (dispatchId: string) =>
  prisma.teamWhatsappRecipient.findMany({
    where: { dispatchId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      userName: true,
      shiftId: true,
      shiftName: true,
      status: true,
      skipReason: true,
      sectorId: true,
      sectorName: true,
      levelName: true,
    },
  });
const PROD_SNAPSHOT = {
  sectorId: 's-prod',
  sectorName: 'Produção',
  levelName: null,
};

describe('migração 20261022110000_team_dispatch_sectors', () => {
  it('envio a Produção ganha uma linha (Produção) e os destinatários sectorName Produção', async () => {
    await expect(sectorRows('d-prod')).resolves.toEqual([
      { sectorId: 's-prod', sectorName: 'Produção' },
    ]);
    const recipients = await recipientSnapshot('d-prod');
    expect(recipients.map((r) => [r.id, r.sectorId, r.sectorName])).toEqual([
      ['r-ana', 's-prod', 'Produção'],
      ['r-bia', 's-prod', 'Produção'],
    ]);
  });

  it("setor apagado usa 'Antigo' do rótulo", async () => {
    await expect(sectorRows('d-gone')).resolves.toEqual([
      { sectorId: 's-gone', sectorName: 'Antigo' },
    ]);
    const [old] = await recipientSnapshot('d-gone');
    expect(old).toMatchObject({ sectorId: 's-gone', sectorName: 'Antigo' });
  });

  it('alvo pessoa não ganha linha', async () => {
    await expect(sectorRows('d-user')).resolves.toEqual([]);
    const [maria] = await recipientSnapshot('d-user');
    expect(maria).toMatchObject({ sectorId: null, sectorName: null });
  });

  it('agendado antigo de Produção segue com o gestor de Produção (Agendados e cancelar)', async () => {
    const mine = await repo.listScheduled(['s-prod']);
    expect(mine.map((r) => r.id)).toEqual(['d-prod']);
    await expect(repo.findDispatchForCancel('d-prod')).resolves.toEqual({
      id: 'd-prod',
      targetType: 'SECTOR',
      targetId: 's-prod',
      state: 'SCHEDULED',
      sectorIds: ['s-prod'],
    });
  });
});

describe('migração 20261022110000_team_dispatch_sectors', () => {
  describe('migração 20261022110000_team_dispatch_sectors — histórico igual', () => {
    it('rótulo, turno, foto e status ficam iguais', async () => {
      const dispatch = await prisma.teamWhatsappDispatch.findUniqueOrThrow({
        where: { id: 'd-prod' },
      });
      expect(dispatch).toMatchObject({
        targetType: 'SECTOR',
        targetId: 's-prod',
        targetLabel: 'Produção · 2º turno · 21/10',
        shiftId: 'shift_second',
        shiftName: '2º turno',
        shiftStartTime: '14:00',
        shiftEndTime: '22:00',
        rosterDate: new Date('2026-10-21T00:00:00.000Z'),
        roster: OLD_ROSTER,
        state: 'SCHEDULED',
        scheduledFor: new Date('2026-10-21T18:00:00.000Z'),
      });
      await expect(recipientSnapshot('d-prod')).resolves.toEqual([
        {
          id: 'r-ana',
          userName: 'Ana',
          shiftId: 'shift_second',
          shiftName: '2º turno',
          status: 'SCHEDULED',
          skipReason: null,
          ...PROD_SNAPSHOT,
        },
        {
          id: 'r-bia',
          userName: 'Bia',
          ...NO_SHIFT,
          status: 'SKIPPED',
          skipReason: 'NO_PHONE',
          ...PROD_SNAPSHOT,
        },
      ]);
    });
  });
});

const A = { sectorId: 's-a', sectorName: 'Almoxarifado' };
const B = { sectorId: 's-b', sectorName: 'Biblioteca' };
type DispatchSectors = { sectorId: string; sectorName: string }[];

// Envio novo pelo repositório: `targetId` = primeiro setor (sem setores: A),
// uma linha por setor.
async function criarEnvio(opts: {
  authorId: string;
  channelId: string;
  sectors: DispatchSectors;
  scheduled: boolean;
}): Promise<string> {
  const first = opts.sectors[0] ?? A;
  const created = await repo.createDispatch({
    authorId: opts.authorId,
    targetType: 'SECTOR',
    targetId: first.sectorId,
    targetLabel: opts.sectors.map((s) => s.sectorName).join(', '),
    ...NO_SNAPSHOT,
    channelId: opts.channelId,
    text: 'oi',
    sectors: opts.sectors,
    recipients: [
      {
        userId: opts.authorId,
        userName: 'Autor',
        ...NO_SHIFT,
        status: opts.scheduled ? 'SCHEDULED' : 'QUEUED',
        skipReason: null,
        sectorId: first.sectorId,
        sectorName: first.sectorName,
        levelName: null,
      },
    ],
    ...(opts.scheduled
      ? {
          state: 'SCHEDULED' as const,
          scheduledFor: new Date('2026-10-22T02:00:00.000Z'),
        }
      : {}),
  });
  return created.id;
}

const ids: Record<string, string> = {};
let gestor: string;
let outro: string;
beforeAll(async () => {
  await prisma.sector.createMany({
    data: [
      { id: A.sectorId, name: A.sectorName, code: 'ALM' },
      { id: B.sectorId, name: B.sectorName, code: 'BIB' },
    ],
  });
  gestor = (
    await prisma.user.create({
      data: { email: 'gestor-a@test.local', password: 'x', role: 'OPERATOR' },
    })
  ).id;
  outro = (
    await prisma.user.create({
      data: { email: 'outro@test.local', password: 'x', role: 'OPERATOR' },
    })
  ).id;
  const { id: channelId } = await prisma.channel.create({
    data: { name: 'Canal equipe', provider: 'GOZAP' },
  });
  const sectorsOf = { A: [A], 'A+B': [A, B], B: [B], vazio: [] };
  for (const [key, sectors] of Object.entries(sectorsOf)) {
    ids[key] = await criarEnvio({
      authorId: outro,
      channelId,
      sectors,
      scheduled: true,
    });
  }
  ids.recenteAB = await criarEnvio({
    authorId: gestor,
    channelId,
    sectors: [A, B],
    scheduled: false,
  });
}, 60_000);

describe('quem vê — Agendados', () => {
  it.each<[string, string[] | null, string, boolean]>([
    ['gestor de A × envio de A → vê', [A.sectorId], 'A', true],
    ['gestor de A × envio de A+B → não vê', [A.sectorId], 'A+B', false],
    ['gestor de A × envio de B → não vê', [A.sectorId], 'B', false],
    // Guarda `some: {}` de listScheduled: sem linhas, o `every` seria verdade vazia.
    [
      'envio SECTOR com sectors [] não aparece para o gestor',
      [A.sectorId],
      'vazio',
      false,
    ],
    ['ADMIN × envio de A+B → vê', null, 'A+B', true],
  ])('%s', async (_label, onlySectorIds, key, sees) => {
    const rows = await repo.listScheduled(onlySectorIds);
    expect(rows.some((r) => r.id === ids[key])).toBe(sees);
  });

  it('findDispatchForCancel traz todos os setores do envio', async () => {
    const found = await repo.findDispatchForCancel(ids['A+B']);
    expect(found).toMatchObject({ targetId: A.sectorId, state: 'SCHEDULED' });
    expect([...(found?.sectorIds ?? [])].sort()).toEqual([
      A.sectorId,
      B.sectorId,
    ]);
  });
});

describe('quem vê — Recentes', () => {
  it('gestor autor vê o próprio envio A+B, com os setores', async () => {
    const rows = await repo.listDispatches(gestor);
    expect(rows.map((r) => r.id)).toEqual([ids.recenteAB]);
    expect(
      [...rows[0].sectors].sort((x, y) => x.sectorId.localeCompare(y.sectorId)),
    ).toEqual([A, B]);
    const recipients = await repo.listRecipients([ids.recenteAB]);
    expect(recipients).toEqual([
      expect.objectContaining({ sectorName: A.sectorName, levelName: null }),
    ]);
  });

  it('gestor não vê envio de outro autor', async () => {
    const rows = await repo.listDispatches(gestor);
    expect(rows.some((r) => r.id === ids.A)).toBe(false);
  });

  it('ADMIN (null) vê todos', async () => {
    const rows = await repo.listDispatches(null);
    expect(rows.map((r) => r.id)).toEqual(
      expect.arrayContaining([...Object.values(ids), 'd-prod', 'd-gone']),
    );
  });
});
