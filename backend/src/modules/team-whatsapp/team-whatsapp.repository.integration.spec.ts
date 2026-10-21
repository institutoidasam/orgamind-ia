import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient, type WorkShift } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  TeamWhatsappRepository,
  type NewTeamRecipient,
} from './team-whatsapp.repository';

// Um container + `migrate deploy` para o arquivo inteiro (inclui a migração
// 20261016100000_team_whatsapp: FKs SetNull/Cascade de verdade).
let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let repo: TeamWhatsappRepository;

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const url = postgres.getConnectionUri();
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } },
  );
  prisma = new PrismaClient({ datasources: { db: { url } } });
  repo = new TeamWhatsappRepository(prisma as never);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

describe('TeamWhatsappRepository — ator e alvo (Postgres real)', () => {
  it('findActor ignora setor desativado em managedSectorIds', async () => {
    const boss = await prisma.user.create({
      data: { email: 'gestor@test.local', password: 'x', role: 'OPERATOR' },
    });
    const s1 = await prisma.sector.create({
      data: { name: 'Ativo', code: 'ATV', managerId: boss.id },
    });
    await prisma.sector.create({
      data: {
        name: 'Inativo',
        code: 'INA',
        managerId: boss.id,
        isActive: false,
      },
    });
    await expect(repo.findActor(boss.id)).resolves.toEqual({
      id: boss.id,
      role: 'OPERATOR',
      isActive: true,
      managedSectorIds: [s1.id],
    });
    await expect(repo.findActor('missing')).resolves.toBeNull();
  }, 60_000);

  it('findTargetUser traz sector.isActive', async () => {
    const off = await prisma.sector.create({
      data: { name: 'Desligado', code: 'OFF', isActive: false },
    });
    const user = await prisma.user.create({
      data: {
        email: 'alvo@test.local',
        password: 'x',
        sectorId: off.id,
        phoneE164: '+5592991230000',
      },
    });
    await expect(repo.findTargetUser(user.id)).resolves.toMatchObject({
      id: user.id,
      sectorId: off.id,
      sector: { isActive: false },
      phoneE164: '+5592991230000',
      contact: null,
    });
  }, 60_000);
});

// Autor + canal + envio com dois destinatários (QUEUED e SKIPPED).
async function criarEnvioComDoisDestinatarios() {
  const author = await prisma.user.create({
    data: { email: 'autor@test.local', password: 'x' },
  });
  const channel = await prisma.channel.create({
    data: { name: 'Canal equipe', provider: 'GOZAP' },
  });
  const created = await repo.createDispatch({
    authorId: author.id,
    targetType: 'USER',
    targetId: author.id,
    targetLabel: 'Autor',
    shift: null,
    channelId: channel.id,
    text: 'oi',
    recipients: [
      {
        userId: author.id,
        userName: 'Autor',
        shift: null,
        status: 'QUEUED',
        skipReason: null,
      },
      {
        userId: author.id,
        userName: 'Autor',
        shift: null,
        status: 'SKIPPED',
        skipReason: 'NO_PHONE',
      },
    ],
  });
  return { author, channel, created };
}

describe('TeamWhatsappRepository — envio e histórico (Postgres real)', () => {
  it('grava, marca falha só nos QUEUED, conta por status e sobrevive à remoção do canal', async () => {
    const { author, channel, created } = await criarEnvioComDoisDestinatarios();
    const ids = created.recipients.map((r) => r.id);
    await expect(
      repo.markFailed(ids, 'team_whatsapp.queue_unavailable'),
    ).resolves.toBe(1);
    const counts = await repo.countByStatus([created.id]);
    expect(counts.sort((a, b) => a.status.localeCompare(b.status))).toEqual([
      { dispatchId: created.id, status: 'FAILED', count: 1 },
      { dispatchId: created.id, status: 'SKIPPED', count: 1 },
    ]);
    await prisma.channel.delete({ where: { id: channel.id } });
    const [row] = await repo.listDispatches(author.id);
    expect(row).toMatchObject({
      id: created.id,
      channel: null,
      author: { id: author.id },
    });
    await expect(repo.listDispatches('someone-else')).resolves.toEqual([]);
  }, 60_000);
});

// Setor com João (2º turno) e Zé (sem turno).
async function criarSetorComTurnos() {
  const prod = await prisma.sector.create({
    data: { name: 'Produção', code: 'PRD' },
  });
  const user = (email: string, name: string, shift: WorkShift | null) =>
    prisma.user.create({
      data: { email, password: 'x', name, sectorId: prod.id, shift },
    });
  const joao = await user('joao@test.local', 'João', 'SECOND');
  const ze = await user('ze@test.local', 'Zé', null);
  const channel = await prisma.channel.create({
    data: { name: 'Canal turno', provider: 'GOZAP' },
  });
  return { prod, joao, ze, channel };
}

const snapshotOf = (joaoId: string, zeId: string): NewTeamRecipient[] => [
  {
    userId: joaoId,
    userName: 'João',
    shift: 'SECOND',
    status: 'QUEUED',
    skipReason: null,
  },
  {
    userId: zeId,
    userName: 'Zé',
    shift: null,
    status: 'SKIPPED',
    skipReason: 'NO_PHONE',
  },
];

describe('TeamWhatsappRepository — turno (Postgres real)', () => {
  it('grava e lê o turno do envio e dos destinatários', async () => {
    const { prod, joao, ze, channel } = await criarSetorComTurnos();
    const found = await repo.findSectorWithActiveMembers(prod.id);
    expect(found?.members.map((m) => [m.id, m.shift])).toEqual([
      [joao.id, 'SECOND'],
      [ze.id, null],
    ]);
    const [listed] = await repo.listSectors([prod.id]);
    expect(listed.members.map((m) => m.shift)).toEqual(['SECOND', null]);
    const recipients = snapshotOf(joao.id, ze.id);
    const created = await repo.createDispatch({
      authorId: joao.id,
      targetType: 'SECTOR',
      targetId: prod.id,
      targetLabel: 'Produção · 2º turno',
      shift: 'SECOND',
      channelId: channel.id,
      text: 'oi',
      recipients,
    });
    const [row] = await repo.listDispatches(joao.id);
    expect(row).toMatchObject({ id: created.id, shift: 'SECOND' });
    await expect(repo.listRecipients([])).resolves.toEqual([]);
    const rows = await repo.listRecipients([created.id]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        recipients.map((r) => ({
          ...r,
          dispatchId: created.id,
          errorCode: null,
        })),
      ),
    );
  }, 60_000);
});

describe('TeamWhatsappRepository — canais elegíveis (Postgres real)', () => {
  it('listEligibleChannels traz só o último evento de conexão do canal', async () => {
    const channel = await prisma.channel.create({
      data: {
        name: 'Canal estado',
        provider: 'EVOLUTION',
        connectionEvents: {
          create: [
            { state: 'open', occurredAt: new Date('2026-10-19T10:00:00Z') },
            { state: 'close', occurredAt: new Date('2026-10-19T11:00:00Z') },
          ],
        },
      },
    });
    const found = (await repo.listEligibleChannels()).find(
      (c) => c.id === channel.id,
    );
    expect(found?.connectionEvents).toEqual([{ state: 'close' }]);
  }, 60_000);
});
