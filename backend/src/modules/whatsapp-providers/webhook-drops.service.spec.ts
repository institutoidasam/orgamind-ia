import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { WebhookDropsService } from './webhook-drops.service';
import { PrismaService } from '../../shared/prisma/prisma.service';

describe('WebhookDropsService', () => {
  let prisma: MockProxy<PrismaService>;
  let svc: WebhookDropsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    svc = new WebhookDropsService(prisma);
  });

  describe('record', () => {
    it('faz upsert incrementando o contador do par (provider, conta, evento)', async () => {
      await svc.record({
        provider: 'ZERNIO',
        accountRef: 'a1b2c3d4e5f6a7b8c9d0e1f2',
        event: 'message.read',
      });

      expect(prisma.webhookDrop.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            provider_accountRef_event: {
              provider: 'ZERNIO',
              accountRef: 'a1b2c3d4e5f6a7b8c9d0e1f2',
              event: 'message.read',
            },
          },
          update: expect.objectContaining({ count: { increment: 1 } }),
          create: expect.objectContaining({
            provider: 'ZERNIO',
            accountRef: 'a1b2c3d4e5f6a7b8c9d0e1f2',
            event: 'message.read',
          }),
        }),
      );
    });

    /**
     * O registro do drop é DIAGNÓSTICO — nunca pode ser o motivo de um webhook
     * falhar. Se o insert quebrar, engolimos (mesma política do AuditService):
     * uma falha aqui não pode virar um 500 que faz o Zernio retentar 7x.
     */
    it('engole o próprio erro (nunca derruba o webhook)', async () => {
      prisma.webhookDrop.upsert.mockRejectedValue(new Error('db down') as never);

      await expect(
        svc.record({ provider: 'TWILIO', accountRef: '+5592999998888', event: 'status' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('listUnresolved', () => {
    it('agrupa por (provider, conta) somando os eventos, e omite contas que JÁ têm canal ativo', async () => {
      prisma.webhookDrop.findMany.mockResolvedValue([
        {
          id: 'd1',
          provider: 'ZERNIO',
          accountRef: 'conta-orfa',
          event: 'message.read',
          count: 24,
          firstSeenAt: new Date('2026-07-10T10:00:00Z'),
          lastSeenAt: new Date('2026-07-10T12:00:00Z'),
        },
        {
          id: 'd2',
          provider: 'ZERNIO',
          accountRef: 'conta-orfa',
          event: 'message.received',
          count: 5,
          firstSeenAt: new Date('2026-07-10T10:30:00Z'),
          lastSeenAt: new Date('2026-07-10T13:00:00Z'),
        },
        {
          id: 'd3',
          provider: 'ZERNIO',
          accountRef: 'conta-ja-configurada',
          event: 'message.read',
          count: 2,
          firstSeenAt: new Date('2026-07-09T10:00:00Z'),
          lastSeenAt: new Date('2026-07-09T10:00:00Z'),
        },
      ] as never);
      // A conta 'conta-ja-configurada' já tem canal ativo → o problema foi
      // resolvido, o alerta some sozinho (sem ninguém ter de "dar baixa").
      prisma.channel.findMany.mockResolvedValue([
        {
          provider: 'ZERNIO',
          zernioAccountId: 'conta-ja-configurada',
          phoneE164: null,
        },
      ] as never);

      const drops = await svc.listUnresolved();

      expect(drops).toEqual([
        {
          provider: 'ZERNIO',
          accountRef: 'conta-orfa',
          totalCount: 29, // 24 + 5
          events: ['message.read', 'message.received'],
          firstSeenAt: new Date('2026-07-10T10:00:00Z'),
          lastSeenAt: new Date('2026-07-10T13:00:00Z'),
        },
      ]);
    });

    it('um canal TWILIO ativo resolve o drop pelo número (accountRef = To)', async () => {
      prisma.webhookDrop.findMany.mockResolvedValue([
        {
          id: 'd1',
          provider: 'TWILIO',
          accountRef: '+5592999998888',
          event: 'status',
          count: 3,
          firstSeenAt: new Date('2026-07-10T10:00:00Z'),
          lastSeenAt: new Date('2026-07-10T10:00:00Z'),
        },
      ] as never);
      prisma.channel.findMany.mockResolvedValue([
        { provider: 'TWILIO', zernioAccountId: null, phoneE164: '+5592999998888' },
      ] as never);

      await expect(svc.listUnresolved()).resolves.toEqual([]);
    });

    it('sem drops → lista vazia (sem alerta nenhum)', async () => {
      prisma.webhookDrop.findMany.mockResolvedValue([] as never);
      prisma.channel.findMany.mockResolvedValue([] as never);

      await expect(svc.listUnresolved()).resolves.toEqual([]);
    });
  });
});
