import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PrismaClient,
  type ChannelProvider,
  type MessageStatus,
} from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { ModuleRef } from '@nestjs/core';
import { deployMigrations } from '../../../test/migrations';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { DisabledChannelsService } from './disabled-channels.service';

const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let service: DisabledChannelsService;
const audit = { log: vi.fn().mockResolvedValue(undefined) };
const maybeCompleteCampaign = vi.fn().mockResolvedValue(undefined);
const moduleRef = {
  get: vi.fn(() => ({ maybeCompleteCampaign })),
};

// Sem TESTCONTAINERS_ENABLED=1 os describes são pulados e o banco não sobe.
beforeAll(async () => {
  if (!TESTCONTAINERS_ENABLED) return;
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('orgamind_test')
    .withUsername('orgamind')
    .withPassword('orgamind')
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  service = new DisabledChannelsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    moduleRef as unknown as ModuleRef,
  );
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

async function makeSector(
  name: string,
  over: { isActive?: boolean; channelId?: string } = {},
) {
  return prisma.sector.create({
    data: { name, code: randomUUID().slice(0, 8), ...over },
  });
}

async function makeChannel(
  provider: ChannelProvider,
  over: { isActive?: boolean; name?: string; isDefault?: boolean } = {},
) {
  return prisma.channel.create({
    data: {
      name: over.name ?? `Número ${randomUUID().slice(0, 6)}`,
      provider,
      isActive: over.isActive ?? true,
      isDefault: over.isDefault ?? false,
      apiKey: '',
      gozapInstanceId: provider === 'GOZAP' ? randomUUID() : undefined,
      evolutionInstanceName:
        provider === 'EVOLUTION' ? randomUUID() : undefined,
    },
  });
}

async function makeMessage(
  instanceId: string,
  status: MessageStatus,
  campaignId?: string,
) {
  return prisma.message.create({
    data: { instanceId, status, campaignId, direction: 'OUTBOUND' },
  });
}

async function makeCampaign(channelId: string) {
  const template = await prisma.template.create({
    data: {
      metaName: `t_${randomUUID().slice(0, 6)}`,
      language: 'pt_BR',
      body: 'Olá',
      variables: [],
      status: 'APPROVED',
      category: 'MARKETING',
    },
  });
  return prisma.campaign.create({
    data: {
      name: 'Aviso',
      templateId: template.id,
      defaultInstanceId: channelId,
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
      totalRecipients: 1,
      status: 'RUNNING',
    },
  });
}

const reload = (id: string) =>
  prisma.channel.findUniqueOrThrow({ where: { id } });
const messageOf = (id: string) =>
  prisma.message.findUniqueOrThrow({ where: { id } });

// Describe que só roda com o banco de testcontainers.
const describeDb = describe.skipIf(!TESTCONTAINERS_ENABLED);

describeDb('DisabledChannelsService (Postgres real) — listagem', () => {
  it('listDisabled: só canais ativos de provedor desligado, áreas ativas por nome', async () => {
    const zeta = await makeChannel('GOZAP', { name: 'Zeta L' });
    const alfa = await makeChannel('TWILIO', { name: 'Alfa L' });
    const evolution = await makeChannel('EVOLUTION', { name: 'Evo L' });
    const inativo = await makeChannel('ZERNIO', {
      name: 'Inativo L',
      isActive: false,
    });
    await makeSector('Logística L', { channelId: zeta.id });
    await makeSector('Compras L', { channelId: zeta.id });
    await makeSector('Extinta L', { channelId: zeta.id, isActive: false });
    await makeSector('RH L', { channelId: evolution.id });
    const mine = new Set([zeta.id, alfa.id, evolution.id, inativo.id]);

    const result = (await service.listDisabled()).filter((c) => mine.has(c.id));

    expect(result).toEqual([
      {
        id: alfa.id,
        name: 'Alfa L',
        provider: 'TWILIO',
        phoneE164: null,
        sectorNames: [],
      },
      {
        id: zeta.id,
        name: 'Zeta L',
        provider: 'GOZAP',
        phoneE164: null,
        sectorNames: ['Compras L', 'Logística L'],
      },
    ]);
  });
});

describeDb('DisabledChannelsService (Postgres real) — remoção do canal', () => {
  it('remove GOZAP: canal inativo, áreas com channelId null, auditoria com ids', async () => {
    const gozap = await makeChannel('GOZAP', { isDefault: true });
    const logistica = await makeSector('Logística R', {
      channelId: gozap.id,
    });
    const extinta = await makeSector('Extinta R', {
      channelId: gozap.id,
      isActive: false,
    });
    const evo = await makeChannel('EVOLUTION');
    const outra = await makeSector('Outra R', { channelId: evo.id });
    audit.log.mockClear();

    const result = await service.remove({
      channelId: gozap.id,
      actorId: 'admin-1',
    });

    expect(result.channelId).toBe(gozap.id);
    expect(result.failedMessages).toBe(0);
    expect([...result.detachedSectorIds].sort()).toEqual(
      [logistica.id, extinta.id].sort(),
    );
    expect(await reload(gozap.id)).toMatchObject({
      isActive: false,
      isDefault: false,
    });
    const sector = (id: string) =>
      prisma.sector.findUniqueOrThrow({ where: { id } });
    expect((await sector(logistica.id)).channelId).toBeNull();
    expect((await sector(extinta.id)).channelId).toBeNull();
    expect((await sector(outra.id)).channelId).toBe(evo.id);
    expect(audit.log).toHaveBeenCalledWith(
      'channel.disabled_remove',
      'Channel',
      gozap.id,
      {
        channelId: gozap.id,
        provider: 'GOZAP',
        detachedSectorIds: result.detachedSectorIds,
        failedMessages: 0,
        actorId: 'admin-1',
      },
    );
  });
});

describeDb(
  'DisabledChannelsService (Postgres real) — mensagens paradas',
  () => {
    it('remove → paradas viram FAILED e a campanha da última parada é reavaliada', async () => {
      const gozap = await makeChannel('GOZAP');
      const other = await makeChannel('GOZAP');
      const campaign = await makeCampaign(gozap.id);
      const waiting = await makeMessage(
        gozap.id,
        'WAITING_INSTANCE',
        campaign.id,
      );
      const queued = await makeMessage(gozap.id, 'QUEUED');
      const sent = await makeMessage(gozap.id, 'SENT', campaign.id);
      const otherWaiting = await makeMessage(other.id, 'WAITING_INSTANCE');
      maybeCompleteCampaign.mockClear();

      const result = await service.remove({
        channelId: gozap.id,
        actorId: 'admin-1',
      });

      expect(result.failedMessages).toBe(2);
      for (const id of [waiting.id, queued.id]) {
        const msg = await messageOf(id);
        expect(msg).toMatchObject({
          status: 'FAILED',
          errorCode: 'channel.provider_disabled',
          errorMessage: 'Este número usa uma integração desligada (GoZap).',
          // Mesmo motivo que o processor grava: o painel agrega por ele.
          failureReason: 'CANAL_FORA',
        });
        expect(msg.failedAt).toBeInstanceOf(Date);
      }
      expect((await messageOf(sent.id)).status).toBe('SENT');
      expect((await messageOf(otherWaiting.id)).status).toBe(
        'WAITING_INSTANCE',
      );
      expect(maybeCompleteCampaign).toHaveBeenCalledTimes(1);
      expect(maybeCompleteCampaign).toHaveBeenCalledWith(campaign.id);
    });
  },
);

describeDb('DisabledChannelsService (Postgres real) — recusas e falhas', () => {
  it('remove: falha ao reavaliar a campanha não desfaz a remoção', async () => {
    const gozap = await makeChannel('GOZAP');
    const campaign = await makeCampaign(gozap.id);
    await makeMessage(gozap.id, 'WAITING_INSTANCE', campaign.id);
    maybeCompleteCampaign.mockRejectedValueOnce(new Error('boom'));

    await expect(
      service.remove({ channelId: gozap.id, actorId: 'admin-1' }),
    ).resolves.toMatchObject({ failedMessages: 1 });
    expect((await reload(gozap.id)).isActive).toBe(false);
  });

  it('remove EVOLUTION → 422 channel.not_disabled e nada muda', async () => {
    const evo = await makeChannel('EVOLUTION', { isDefault: true });
    const sector = await makeSector('Logística E', { channelId: evo.id });
    const waiting = await makeMessage(evo.id, 'WAITING_INSTANCE');
    audit.log.mockClear();

    await expect(
      service.remove({ channelId: evo.id, actorId: 'admin-1' }),
    ).rejects.toMatchObject({ status: 422, code: 'channel.not_disabled' });

    expect(await reload(evo.id)).toMatchObject({
      isActive: true,
      isDefault: true,
    });
    expect(
      (await prisma.sector.findUniqueOrThrow({ where: { id: sector.id } }))
        .channelId,
    ).toBe(evo.id);
    expect((await messageOf(waiting.id)).status).toBe('WAITING_INSTANCE');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('remove canal já inativo ou inexistente → 404', async () => {
    const inativo = await makeChannel('GOZAP', { isActive: false });

    await expect(
      service.remove({ channelId: inativo.id, actorId: 'admin-1' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.remove({ channelId: 'nao-existe', actorId: 'admin-1' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
