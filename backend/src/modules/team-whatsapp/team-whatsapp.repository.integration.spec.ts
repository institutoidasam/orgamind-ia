import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

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
    channelId: channel.id,
    text: 'oi',
    recipients: [
      {
        userId: author.id,
        userName: 'Autor',
        status: 'QUEUED',
        skipReason: null,
      },
      {
        userId: author.id,
        userName: 'Autor',
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
    await expect(repo.listIssues([])).resolves.toEqual([]);
    const issues = await repo.listIssues([created.id]);
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          dispatchId: created.id,
          userName: 'Autor',
          status: 'FAILED',
          errorCode: 'team_whatsapp.queue_unavailable',
          skipReason: null,
        },
        {
          dispatchId: created.id,
          userName: 'Autor',
          status: 'SKIPPED',
          errorCode: null,
          skipReason: 'NO_PHONE',
        },
      ]),
    );
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
