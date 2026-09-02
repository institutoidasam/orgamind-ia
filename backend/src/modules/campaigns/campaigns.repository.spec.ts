import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import {
  CampaignsRepository,
  UNCONFIRMED_SENT_RELEASED_CODE,
} from './campaigns.repository';
import { reachedOrInFlightInCampaign } from './batch-audience';
import { PrismaService } from '../../shared/prisma/prisma.service';

describe('CampaignsRepository', () => {
  let repo: CampaignsRepository;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new CampaignsRepository(prisma);
  });

  describe('findById', () => {
    it('delegates to prisma.campaign.findUnique with template include', async () => {
      const campaign = { id: 'c1', name: 'Camp', template: { id: 't1' } } as any;
      prisma.campaign.findUnique.mockResolvedValue(campaign);
      const result = await repo.findById('c1');
      expect(result).toBe(campaign);
      expect(prisma.campaign.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
        include: { template: true },
      });
    });
  });

  describe('delete — o espelho órfão muda de semântica', () => {
    beforeEach(() => {
      // O $transaction do delete roda o callback com o próprio mock como tx.
      prisma.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) =>
        fn(prisma)) as never);
    });

    it('converte os contadores do ZernioBroadcast de FUNIL para PARTIÇÃO no mesmo commit', async () => {
      // O caso real de prod: funil 39 ⊇ 38 ⊇ 31 (a lida DENTRO da entregue).
      // Depois do SetNull a linha é lida como painel (partição) — sem a
      // conversão, a leitura re-somaria e mostraria (38+31)/45 = 153%.
      prisma.zernioBroadcast.findMany.mockResolvedValue([
        { id: 'zb1', sentCount: 39, deliveredCount: 38, readCount: 31, failedCount: 6 },
      ] as never);
      prisma.campaign.delete.mockResolvedValue({ id: 'c1' } as never);

      await repo.delete('c1');

      expect(prisma.zernioBroadcast.update).toHaveBeenCalledWith({
        where: { id: 'zb1' },
        data: { sentCount: 1, deliveredCount: 7, readCount: 31, failedCount: 6 },
      });
      expect(prisma.campaign.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    });

    it('campanha sem espelho no Zernio apaga sem tocar em nada', async () => {
      prisma.zernioBroadcast.findMany.mockResolvedValue([] as never);
      prisma.campaign.delete.mockResolvedValue({ id: 'c1' } as never);

      await repo.delete('c1');

      expect(prisma.zernioBroadcast.update).not.toHaveBeenCalled();
      expect(prisma.campaign.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
    });
  });

  /**
   * Cancelar tem de esvaziar a campanha DE VERDADE.
   *
   * `WAITING_INSTANCE` ficava de fora: uma campanha cancelada seguia exibindo
   * "N aguardando conexão" para sempre. Pior, se o canal daquelas mensagens
   * voltasse, o replay as enfileirava — só para o worker as descartar pelo
   * status da campanha. Trabalho e ruído por uma campanha que já acabou.
   */
  describe('cancelQueuedMessages — WAITING_INSTANCE também é fila', () => {
    it('cancela QUEUED e WAITING_INSTANCE numa tacada', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 7 } as never);

      const n = await repo.cancelQueuedMessages('c1');

      expect(n).toBe(7);
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: { campaignId: 'c1', status: { in: ['QUEUED', 'WAITING_INSTANCE'] } },
        data: { status: 'CANCELLED', errorCode: 'campaign_cancelled' },
      });
    });

    it('não toca no que já saiu — SENT/DELIVERED/READ ficam intactos', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as never);

      await repo.cancelQueuedMessages('c1');

      const arg = prisma.message.updateMany.mock.calls[0][0] as {
        where: { status: { in: string[] } };
      };
      for (const s of ['SENT', 'DELIVERED', 'READ', 'FAILED']) {
        expect(arg.where.status.in).not.toContain(s);
      }
    });
  });

  describe('listAll', () => {
    it('returns [] without calling groupBy when no campaigns', async () => {
      prisma.campaign.findMany.mockResolvedValue([] as any);
      const result = await repo.listAll();
      expect(result).toEqual([]);
      expect(prisma.message.groupBy).not.toHaveBeenCalled();
    });

    it('merges grouped status counts onto each campaign', async () => {
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'c1', name: 'A' },
        { id: 'c2', name: 'B' },
      ] as any);
      prisma.message.groupBy.mockResolvedValue([
        { campaignId: 'c1', status: 'SENT', _count: 5 },
        { campaignId: 'c1', status: 'FAILED', _count: 1 },
        { campaignId: 'c2', status: 'QUEUED', _count: 10 },
      ] as any);

      const result = await repo.listAll();

      expect(prisma.message.groupBy).toHaveBeenCalledWith({
        where: { campaignId: { in: ['c1', 'c2'] } },
        by: ['campaignId', 'status'],
        _count: true,
      });
      expect(result).toEqual([
        {
          id: 'c1',
          name: 'A',
          statusCounts: [
            { status: 'SENT', _count: 5 },
            { status: 'FAILED', _count: 1 },
          ],
        },
        {
          id: 'c2',
          name: 'B',
          statusCounts: [{ status: 'QUEUED', _count: 10 }],
        },
      ]);
    });

    it('attaches empty statusCounts when a campaign has no messages', async () => {
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'c1', name: 'A' },
        { id: 'c2', name: 'B' },
      ] as any);
      prisma.message.groupBy.mockResolvedValue([
        { campaignId: 'c1', status: 'SENT', _count: 3 },
      ] as any);
      const result = await repo.listAll();
      expect(result[1]).toEqual({ id: 'c2', name: 'B', statusCounts: [] });
    });
  });

  describe('create', () => {
    it('passes through scheduleConfig when provided', async () => {
      prisma.campaign.create.mockResolvedValue({ id: 'c1' } as any);
      await repo.create({
        name: 'C',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: {} as any,
        variableMap: {} as any,
        totalRecipients: 5,
        scheduleConfig: { type: 'DAILY_AT', time: '10:00' } as any,
      });
      expect(prisma.campaign.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'C',
          templateId: 't1',
          defaultInstanceId: 'inst-1',
          totalRecipients: 5,
          scheduledAt: null,
          scheduleConfig: { type: 'DAILY_AT', time: '10:00' },
        }),
      });
    });

    it('uses Prisma.JsonNull when scheduleConfig is null', async () => {
      prisma.campaign.create.mockResolvedValue({ id: 'c1' } as any);
      await repo.create({
        name: 'C',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: {} as any,
        variableMap: {} as any,
        totalRecipients: 0,
        scheduleConfig: null,
      });
      const arg = prisma.campaign.create.mock.calls[0][0] as any;
      expect(arg.data.scheduleConfig).toBe(Prisma.JsonNull);
    });

    it('uses Prisma.JsonNull when scheduleConfig is omitted', async () => {
      prisma.campaign.create.mockResolvedValue({ id: 'c1' } as any);
      await repo.create({
        name: 'C',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: {} as any,
        variableMap: {} as any,
        totalRecipients: 0,
      });
      const arg = prisma.campaign.create.mock.calls[0][0] as any;
      expect(arg.data.scheduleConfig).toBe(Prisma.JsonNull);
    });

    it('persiste override=true (T8 — reconhecimento de risco do operador)', async () => {
      prisma.campaign.create.mockResolvedValue({ id: 'c1' } as any);
      await repo.create({
        name: 'C',
        templateId: 't1',
        defaultInstanceId: 'inst-1',
        filters: {} as any,
        variableMap: {} as any,
        totalRecipients: 0,
        override: true,
      });
      expect(prisma.campaign.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ override: true }),
      });
    });
  });

  // C1 — linhas de contabilização do gate de consentimento.
  describe('createSkippedMessage', () => {
    it('reason=no_consent → Message terminal SKIPPED_NO_CONSENT (sem variables)', async () => {
      prisma.message.create.mockResolvedValue({ id: 'skip1' } as any);
      await repo.createSkippedMessage({
        campaignId: 'camp1',
        contactId: 'ct1',
        instanceId: 'inst-1',
        reason: 'no_consent',
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          campaignId: 'camp1',
          contactId: 'ct1',
          instanceId: 'inst-1',
          status: 'SKIPPED_NO_CONSENT',
          errorCode: 'no_consent',
        }),
      });
    });

    it('reason=suppressed → SKIPPED_SUPPRESSED (estado DIFERENTE, não colapsado)', async () => {
      // Revogação (absoluta) e ausência de consentimento (resolvível coletando
      // opt-in) são coisas diferentes. Colapsar as duas num status só esconderia
      // justamente a métrica que diz se a coleta está funcionando.
      prisma.message.create.mockResolvedValue({ id: 'skip2' } as any);
      await repo.createSkippedMessage({
        campaignId: 'camp1',
        contactId: 'ct2',
        instanceId: 'inst-1',
        reason: 'suppressed',
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'SKIPPED_SUPPRESSED',
          errorCode: 'suppressed',
        }),
      });
    });

    /*
      "Disparar novamente" reavalia os PULADOS (redispatchCampaign usa
      `unreachedAudienceWhere`, não o `pendingWhere` — quem foi só SKIPPED_* pelo
      gate volta a ser candidato) — e reavaliar é o certo. O que não pode é
      EMPILHAR linhas de pulo: os KPIs contam MENSAGENS e a aba
      "Pulados" conta CONTATOS. Com uma 2ª linha por contato, o operador que
      clicasse "Disparar novamente" numa campanha 100% pulada (a reação óbvia)
      leria "4 de 2 destinatários foram pulados" — o número que existe para
      EXPLICAR o bug viraria ele próprio um absurdo.
    */
    it('redisparo NÃO empilha: reusa a linha de pulo já existente do mesmo contato', async () => {
      prisma.message.findFirst.mockResolvedValue({ id: 'skip-old' } as any);
      prisma.message.update.mockResolvedValue({ id: 'skip-old' } as any);

      await repo.createSkippedMessage({
        campaignId: 'camp1',
        contactId: 'ct1',
        instanceId: 'inst-1',
        reason: 'no_consent',
        campaignBatchId: 'batch-2',
      });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'skip-old' },
        data: expect.objectContaining({
          status: 'SKIPPED_NO_CONSENT',
          errorCode: 'no_consent',
          // O lote mais recente: a linha reflete a ÚLTIMA decisão do gate.
          campaignBatchId: 'batch-2',
        }),
      });
    });

    it('a busca da linha existente é por campanha + contato + status SKIPPED_*', async () => {
      prisma.message.findFirst.mockResolvedValue(null as any);
      prisma.message.create.mockResolvedValue({ id: 'skip3' } as any);

      await repo.createSkippedMessage({
        campaignId: 'camp1',
        contactId: 'ct9',
        instanceId: 'inst-1',
        reason: 'no_consent',
      });

      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            campaignId: 'camp1',
            contactId: 'ct9',
            status: {
              in: [
                'SKIPPED_NO_CONSENT',
                'SKIPPED_SUPPRESSED',
                'SKIPPED_NO_OPTIN',
              ],
            },
          },
        }),
      );
      // Sem linha anterior, cria (o caminho normal do 1º disparo).
      expect(prisma.message.create).toHaveBeenCalled();
    });
  });

  describe('findDueScheduled', () => {
    it('queries enabled non-IMMEDIATE campaigns due before now, capped at 50', async () => {
      const now = new Date('2026-05-07T00:00:00Z');
      prisma.campaign.findMany.mockResolvedValue([] as any);
      await repo.findDueScheduled(now);
      expect(prisma.campaign.findMany).toHaveBeenCalledWith({
        where: {
          scheduleEnabled: true,
          scheduleType: { not: 'IMMEDIATE' },
          nextRunAt: { lte: now, not: null },
        },
        take: 50,
      });
    });
  });

  describe('markRan', () => {
    it('persists timestamps, increments runCount, sets status RUNNING and disables schedule when nextRunAt is null', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 } as any);
      const lastRunAt = new Date('2026-05-07T12:00:00Z');
      await repo.markRan('c1', lastRunAt, null, 7);

      const arg = prisma.campaign.updateMany.mock.calls[0][0] as any;
      expect(arg.data).toEqual(
        expect.objectContaining({
          lastRunAt,
          nextRunAt: null,
          scheduleEnabled: false,
          runCount: { increment: 1 },
          totalRecipients: 7,
          status: 'RUNNING',
        }),
      );
      expect(arg.data.startedAt).toBeInstanceOf(Date);
    });

    it('keeps schedule enabled when nextRunAt is set', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 } as any);
      const lastRunAt = new Date();
      const nextRunAt = new Date(Date.now() + 60_000);
      await repo.markRan('c1', lastRunAt, nextRunAt, 3);
      const arg = prisma.campaign.updateMany.mock.calls[0][0] as any;
      expect(arg.data.scheduleEnabled).toBe(true);
      expect(arg.data.nextRunAt).toBe(nextRunAt);
    });

    // A3 — markRan must not resurrect a campaign that was CANCELLED during the
    // dispatch window. The WHERE guard excludes CANCELLED so a racing cancel()
    // wins: the conditional updateMany matches 0 rows and the campaign stays
    // CANCELLED (schedule stays disabled).
    it('guards on status notIn CANCELLED so it cannot resurrect a cancelled campaign', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 0 } as any);
      const count = await repo.markRan('c1', new Date(), null, 7);
      const arg = prisma.campaign.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'c1', status: { notIn: ['CANCELLED'] } });
      // returns the affected-row count so callers can detect "lost the race"
      expect(count).toBe(0);
    });

    it('returns 1 when the conditional update matched (campaign not cancelled)', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 } as any);
      const count = await repo.markRan('c1', new Date(), null, 7);
      expect(count).toBe(1);
    });
  });

  describe('claimForSend', () => {
    // A2 — atomic send claim. Only a row that is still QUEUED can be claimed.
    // updateMany returns count=1 on a successful claim, count=0 when another
    // attempt already claimed/sent it (the duplicate-send guard).
    it('atomically claims a QUEUED message into SENDING and returns 1', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const count = await repo.claimForSend('m1');
      expect(count).toBe(1);
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'QUEUED' });
      expect(arg.data.status).toBe('SENDING');
      // sendingAt is stamped so the reconciler measures time-in-SENDING.
      expect(arg.data.sendingAt).toBeInstanceOf(Date);
    });

    it('returns 0 when the message is no longer QUEUED (already claimed/sent)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      const count = await repo.claimForSend('m1');
      expect(count).toBe(0);
    });
  });

  describe('findUnconfirmedSent', () => {
    it('queries SENT rows with a providerMessageId older than the cutoff', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      const cutoff = new Date('2026-07-09T00:00:00Z');
      await repo.findUnconfirmedSent(cutoff, 100);
      const arg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({
        status: 'SENT',
        providerMessageId: { not: null },
        sentAt: { lt: cutoff },
      });
      expect(arg.take).toBe(100);
    });

    it('selects the channel provider — the reconciler routes the status poll by it', async () => {
      // Load-bearing select: without it every row reads `undefined` provider
      // and the reconciler silently skips ALL rows (reconciliation disabled).
      prisma.message.findMany.mockResolvedValue([] as any);
      await repo.findUnconfirmedSent(new Date('2026-07-09T00:00:00Z'), 100);
      const arg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(arg.select.instance).toEqual({ select: { provider: true } });
    });
  });

  describe('applyReconciledDelivery', () => {
    it('upgrades a still-SENT row to DELIVERED with deliveredAt (scoped to SENT)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const at = new Date('2026-07-09T01:00:00Z');
      const count = await repo.applyReconciledDelivery({
        messageId: 'm1',
        newStatus: 'DELIVERED',
        occurredAt: at,
      });
      expect(count).toBe(1);
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'SENT' });
      expect(arg.data.status).toBe('DELIVERED');
      expect(arg.data.deliveredAt).toBe(at);
    });

    it('stores errorCode/errorMessage + failedAt + failureReason on a FAILED reconciliation', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const at = new Date('2026-07-09T01:00:00Z');
      await repo.applyReconciledDelivery({
        messageId: 'm1',
        newStatus: 'FAILED',
        occurredAt: at,
        errorCode: '63003',
        errorMessage: 'não é usuário do WhatsApp',
      });
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data.status).toBe('FAILED');
      expect(arg.data.errorCode).toBe('63003');
      expect(arg.data.failedAt).toBe(at);
      // F2 — este é o caminho do reconciliador (fallback do Twilio quando o
      // webhook atrasa): antes desta correção gravava FAILED sem
      // failureReason, deixando essas linhas de fora do painel de motivos.
      expect(arg.data.failureReason).toBe('SEM_WHATSAPP');
    });

    // F2 — flag durável best-effort no Contact quando o contactId é passado
    // pelo chamador (já disponível no select de findUnconfirmedSent).
    it('updates the Contact durable failure flag best-effort when contactId is given', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.contact.update.mockResolvedValue({ id: 'contact-1' } as any);
      const at = new Date('2026-07-09T01:00:00Z');
      await repo.applyReconciledDelivery({
        messageId: 'm1',
        newStatus: 'FAILED',
        occurredAt: at,
        errorCode: '131021',
        errorMessage: 'não é usuário do WhatsApp',
        contactId: 'contact-1',
      });
      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'contact-1' },
        data: expect.objectContaining({
          failureCount: { increment: 1 },
          lastFailureReason: 'SEM_WHATSAPP',
          lastFailureCode: '131021',
          lastFailureAt: expect.any(Date),
        }),
      });
    });

    it('does not touch the Contact when contactId is not provided', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.applyReconciledDelivery({
        messageId: 'm1',
        newStatus: 'FAILED',
        occurredAt: new Date('2026-07-09T01:00:00Z'),
        errorCode: '63003',
      });
      expect(prisma.contact.update).not.toHaveBeenCalled();
    });

    it('does not touch the Contact when the Message update no-ops (row already left SENT)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      const count = await repo.applyReconciledDelivery({
        messageId: 'm1',
        newStatus: 'FAILED',
        occurredAt: new Date('2026-07-09T01:00:00Z'),
        errorCode: '63003',
        contactId: 'contact-1',
      });
      expect(count).toBe(0);
      expect(prisma.contact.update).not.toHaveBeenCalled();
    });

    it('swallows a Contact update failure (best-effort — the reconciled Message write already succeeded)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.contact.update.mockRejectedValue(new Error('db down'));
      const count = await repo.applyReconciledDelivery({
        messageId: 'm1',
        newStatus: 'FAILED',
        occurredAt: new Date('2026-07-09T01:00:00Z'),
        errorCode: '63003',
        contactId: 'contact-1',
      });
      expect(count).toBe(1);
    });

    it('does not touch the Contact on DELIVERED/READ outcomes even when contactId is given', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.applyReconciledDelivery({
        messageId: 'm1',
        newStatus: 'DELIVERED',
        occurredAt: new Date('2026-07-09T01:00:00Z'),
        contactId: 'contact-1',
      });
      expect(prisma.contact.update).not.toHaveBeenCalled();
    });
  });

  describe('releaseClaim', () => {
    // A2 — when wa.send throws a *retryable* error, the row is left in SENDING
    // by the claim. We must put it back to QUEUED so BullMQ's retry can
    // re-claim and re-send. Scoped to status:'SENDING' so it never clobbers a
    // row that already advanced (e.g. to SENT/FAILED) for any other reason.
    it('returns a SENDING row to QUEUED so a BullMQ retry can re-claim it', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const count = await repo.releaseClaim('m1');
      expect(count).toBe(1);
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', status: 'SENDING' },
        data: { status: 'QUEUED' },
      });
    });
  });

  describe('markSent', () => {
    // A2 — markSent transitions the claimed SENDING row to SENT. Targeting
    // status:'SENDING' (via updateMany) makes the whole claim→send→markSent
    // path idempotent: a duplicate attempt that lost the claim never owns a
    // SENDING row to flip.
    it('transitions the SENDING row to SENT with provider metadata', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const sentAt = new Date('2026-06-15T10:00:00Z');
      await repo.markSent({
        messageId: 'm1',
        instanceId: 'inst-1',
        providerMessageId: 'wamid',
        sentAt,
      });
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', status: 'SENDING' },
        data: {
          status: 'SENT',
          instanceId: 'inst-1',
          providerMessageId: 'wamid',
          sentAt,
          // F2 — o sucesso é quem apaga a prova da falha anterior (o retry
          // preserva; markSent limpa).
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          failureReason: null,
        },
      });
    });

    // F2 — failureCount é MONOTÔNICO: nunca zerado, nem no sucesso.
    it('NÃO zera failureCount do Contact (monotônico através do sucesso)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.contact.update.mockResolvedValue({} as any);
      await repo.markSent({
        messageId: 'm1',
        instanceId: 'inst-1',
        contactId: 'k1',
      });
      const arg = prisma.contact.update.mock.calls[0][0] as any;
      expect(arg.data).not.toHaveProperty('failureCount');
    });

    it('limpa lastFailureReason/Code/At do Contact quando contactId é passado', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.contact.update.mockResolvedValue({} as any);
      await repo.markSent({
        messageId: 'm1',
        instanceId: 'inst-1',
        contactId: 'k1',
      });
      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'k1' },
        data: {
          lastFailureReason: null,
          lastFailureCode: null,
          lastFailureAt: null,
        },
      });
    });

    it('NÃO toca o Contact quando contactId não é passado', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.markSent({ messageId: 'm1', instanceId: 'inst-1' });
      expect(prisma.contact.update).not.toHaveBeenCalled();
    });

    it('best-effort: uma falha ao limpar o Contact não derruba o markSent', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.contact.update.mockRejectedValue(new Error('db down') as never);
      await expect(
        repo.markSent({ messageId: 'm1', instanceId: 'inst-1', contactId: 'k1' }),
      ).resolves.toBeUndefined();
    });

    it('defaults sentAt to now when omitted', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.markSent({ messageId: 'm1', instanceId: 'inst-1' });
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data.sentAt).toBeInstanceOf(Date);
    });

    // BOLHA VAZIA — o envio de campanha nunca gravava o texto: o operador via a
    // bolha só com hora e ticks. O corpo renderizado é escrito na MESMA transição
    // SENDING→SENT (sem novo write, sem nova corrida).
    it('persiste o corpo renderizado em content', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.markSent({
        messageId: 'm1',
        instanceId: 'inst-1',
        providerMessageId: 'wamid',
        content: 'Olá Andre, tudo bem?',
      });
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data.content).toBe('Olá Andre, tudo bem?');
    });

    // Sem content (chamador legado / retry best-effort do catch) NÃO se apaga o
    // texto que já foi gravado: `undefined` é omissão no Prisma, `null` seria
    // apagar. A bolha não pode regredir para vazia.
    it('não sobrescreve content com null quando o chamador não passa texto', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.markSent({ messageId: 'm1', instanceId: 'inst-1' });
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data.content).toBeUndefined();
    });

    // Regressão A2: a escrita continua escopada ao claim (status SENDING).
    it('continua escopado a status SENDING (claim A2) ao gravar content', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      await repo.markSent({ messageId: 'm1', instanceId: 'inst-1', content: 'Oi' });
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'SENDING' });
    });
  });

  describe('findStuckSending / recoverStuckSending', () => {
    // A2 reconciler — a worker crash between claim (SENDING) and markSent
    // strands a row in SENDING. The reconciler finds rows older than a
    // threshold and recovers them.
    it('findStuckSending queries SENDING rows whose sendingAt is older than the cutoff', async () => {
      const cutoff = new Date('2026-06-15T10:00:00Z');
      prisma.message.findMany.mockResolvedValue([
        { id: 'm1', campaignId: 'c1' },
      ] as any);
      const rows = await repo.findStuckSending(cutoff, 100);
      expect(rows).toEqual([{ id: 'm1', campaignId: 'c1' }]);
      // Measures time-in-SENDING via sendingAt, NOT queuedAt (creation time),
      // so a message that legitimately waited out a long pacing delay before
      // sending isn't falsely flagged the instant it enters SENDING.
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { status: 'SENDING', sendingAt: { lt: cutoff } },
        select: { id: true, campaignId: true },
        take: 100,
      });
    });

    it('recoverStuckSending marks a still-SENDING row FAILED and returns 1', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const count = await repo.recoverStuckSending('m1');
      expect(count).toBe(1);
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'SENDING' });
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'FAILED',
          errorCode: 'sending_stuck',
          // F2 — 'sending_stuck' → INDETERMINADO.
          failureReason: 'INDETERMINADO',
        }),
      );
      expect(arg.data.failedAt).toBeInstanceOf(Date);
    });

    it('recoverStuckSending returns 0 when the row already left SENDING (markSent won the race)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      const count = await repo.recoverStuckSending('m1');
      expect(count).toBe(0);
    });
  });

  describe('updateStatus', () => {
    it('delegates with status and optional fields', async () => {
      prisma.campaign.update.mockResolvedValue({ id: 'c1' } as any);
      const finishedAt = new Date();
      await repo.updateStatus('c1', 'COMPLETED', { finishedAt });
      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'COMPLETED', finishedAt },
      });
    });

    it('works without fields', async () => {
      prisma.campaign.update.mockResolvedValue({ id: 'c1' } as any);
      await repo.updateStatus('c1', 'RUNNING');
      expect(prisma.campaign.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'RUNNING' },
      });
    });
  });

  describe('transitionToQueued', () => {
    it('returns the count of rows updated', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 } as any);
      const result = await repo.transitionToQueued('c1', 5);
      expect(result).toBe(1);
      const arg = prisma.campaign.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'c1', status: 'DRAFT' });
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'QUEUED',
          totalRecipients: 5,
        }),
      );
      expect(arg.data.startedAt).toBeInstanceOf(Date);
    });

    it('returns 0 when no DRAFT row matched (race lost)', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 0 } as any);
      const result = await repo.transitionToQueued('c1', 5);
      expect(result).toBe(0);
    });

    it('disarms the schedule when disarmSchedule=true (one-shot fired manually)', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.transitionToQueued('c1', 5, { disarmSchedule: true });
      const arg = prisma.campaign.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'c1', status: 'DRAFT' });
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'QUEUED',
          totalRecipients: 5,
          // The fix: a one-shot manual fire must disarm any pending schedule so
          // findDueScheduled (WHERE scheduleEnabled=true) can never re-fire it.
          scheduleEnabled: false,
          nextRunAt: null,
        }),
      );
    });

    it('leaves the schedule armed when disarmSchedule=false (recurring stays on cadence)', async () => {
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.transitionToQueued('c1', 5, { disarmSchedule: false });
      const arg = prisma.campaign.updateMany.mock.calls[0][0] as any;
      // Recurring campaigns must NOT be disarmed by a manual ad-hoc fire.
      expect(arg.data).not.toHaveProperty('scheduleEnabled');
      expect(arg.data).not.toHaveProperty('nextRunAt');
    });
  });

  describe('cancelAndDisableSchedule', () => {
    it('sets status CANCELLED, finishedAt, scheduleEnabled=false, nextRunAt=null', async () => {
      prisma.campaign.update.mockResolvedValue({ id: 'c1' } as any);
      await repo.cancelAndDisableSchedule('c1');
      const arg = prisma.campaign.update.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'c1' });
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'CANCELLED',
          scheduleEnabled: false,
          nextRunAt: null,
        }),
      );
      expect(arg.data.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe('countContactsByWhere', () => {
    it('delegates to prisma.contact.count', async () => {
      prisma.contact.count.mockResolvedValue(42);
      const where = { city: 'Manaus' } as any;
      const result = await repo.countContactsByWhere(where);
      expect(result).toBe(42);
      expect(prisma.contact.count).toHaveBeenCalledWith({ where });
    });
  });

  /**
   * UMA ORDEM SÓ — a do DISPARO.
   *
   * A prévia ordenava por `createdAt: 'desc'` (mais NOVOS primeiro) e o disparo
   * por `id: 'asc'` (mais ANTIGOS primeiro). Ordens OPOSTAS. Enquanto todo mundo
   * recebia, ninguém via: os dois conjuntos eram iguais, só embaralhados. Com
   * "os N primeiros", a prévia mostraria N pessoas e o disparo mandaria para N
   * pessoas DIFERENTES — do outro extremo da lista.
   *
   * Numa campanha eleitoral, mandar para quem não foi escolhido é irreversível.
   * A prévia agora usa a ordem do DISPARO, e não o contrário: assim o
   * comportamento de ENVIO de ninguém muda.
   */
  describe('findContactsByWhere', () => {
    it('ordena por id asc — a MESMA ordem do disparo (findContactsPage)', async () => {
      const contacts = [{ id: 'k1' }, { id: 'k2' }] as any;
      prisma.contact.findMany.mockResolvedValue(contacts);
      const where = { city: 'X' } as any;
      const result = await repo.findContactsByWhere(where, 10);
      expect(result).toBe(contacts);
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where,
        take: 10,
        orderBy: { id: 'asc' },
      });
    });

    it('omits take when not given', async () => {
      prisma.contact.findMany.mockResolvedValue([] as any);
      await repo.findContactsByWhere({} as any);
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where: {},
        take: undefined,
        orderBy: { id: 'asc' },
      });
    });
  });

  /**
   * "Limitar aos primeiros N contatos" — o recorte que o cliente usa para
   * dimensionar o teste de hoje.
   *
   * O recorte NÃO é feito com `take: N` no disparo: o disparo é paginado por
   * cursor e passa pelo gate de consentimento, então um `take` por página não
   * limita a audiência. O recorte é uma FRONTEIRA: acha o id do N-ésimo contato
   * (na ordem de cadastro) e restringe a audiência a `id <= esse id`.
   *
   * Assim o limite vira um predicado comum, que compõe com TUDO — o gate, os
   * lotes (pendingAudienceWhere) e a contagem da prévia — sem que nenhum deles
   * precise saber que existe um limite.
   */
  describe('applyAudienceLimit', () => {
    it('recorta a audiência aos N primeiros por ORDEM DE CADASTRO (id asc)', async () => {
      prisma.contact.findMany.mockResolvedValue([{ id: 'c200' }] as any);
      const where = { city: 'Manaus' } as any;

      const limited = await repo.applyAudienceLimit(where, 200);

      // Busca o N-ésimo contato: pula 199, pega 1 — na ordem do disparo.
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where,
        orderBy: { id: 'asc' },
        skip: 199,
        take: 1,
        select: { id: true },
      });
      expect(limited).toEqual({ AND: [where, { id: { lte: 'c200' } }] });
    });

    it('sem limite → a audiência passa intacta', async () => {
      const where = { city: 'Manaus' } as any;

      await expect(repo.applyAudienceLimit(where, null)).resolves.toBe(where);
      expect(prisma.contact.findMany).not.toHaveBeenCalled();
    });

    /**
     * Limite MAIOR que a audiência: não existe N-ésimo contato. Recortar em
     * `id <= undefined` mandaria para NINGUÉM — falha silenciosa e total.
     */
    it('audiência menor que o limite → todo mundo (não recorta em nada)', async () => {
      prisma.contact.findMany.mockResolvedValue([] as any);
      const where = { city: 'Manaus' } as any;

      await expect(repo.applyAudienceLimit(where, 5000)).resolves.toBe(where);
    });
  });

  describe('findContactsPage (keyset pagination)', () => {
    it('orders by id asc, applies take, and selects the requested columns (first page: no cursor)', async () => {
      const rows = [{ id: 'a' }, { id: 'b' }] as any;
      prisma.contact.findMany.mockResolvedValue(rows);
      const where = { city: 'X' } as any;

      const result = await repo.findContactsPage(where, {
        select: { id: true, name: true },
        take: 2,
      });

      expect(result).toBe(rows);
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where,
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
        take: 2,
      });
    });

    it('uses cursor + skip:1 for subsequent pages (keyset on id)', async () => {
      prisma.contact.findMany.mockResolvedValue([] as any);
      const where = {} as any;

      await repo.findContactsPage(where, {
        select: { id: true },
        take: 500,
        cursorId: 'b',
      });

      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 500,
        cursor: { id: 'b' },
        skip: 1,
      });
    });
  });

  describe('findContactById', () => {
    it('delegates to prisma.contact.findUnique', async () => {
      prisma.contact.findUnique.mockResolvedValue({ id: 'k1' } as any);
      const result = await repo.findContactById('k1');
      expect(result).toEqual({ id: 'k1' });
      expect(prisma.contact.findUnique).toHaveBeenCalledWith({
        where: { id: 'k1' },
      });
    });
  });

  describe('groupMessagesByStatus', () => {
    it('groups by status with count', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { status: 'SENT', _count: 4 },
      ] as any);
      const result = await repo.groupMessagesByStatus('c1');
      expect(prisma.message.groupBy).toHaveBeenCalledWith({
        where: { campaignId: 'c1' },
        by: ['status'],
        _count: true,
      });
      expect(result).toEqual([{ status: 'SENT', _count: 4 }]);
    });
  });

  describe('listMessages', () => {
    beforeEach(() => {
      // $transaction with an array awaits each promise and returns the resolved values.
      prisma.$transaction.mockImplementation((arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        return arg(prisma);
      });
    });

    it('paginates without filters', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm1' }] as any);
      prisma.message.count.mockResolvedValue(1);

      const result = await repo.listMessages({
        campaignId: 'c1',
        page: 2,
        pageSize: 25,
      });

      expect(result).toEqual({
        items: [{ id: 'm1' }],
        total: 1,
        page: 2,
        pageSize: 25,
      });
      const findArg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(findArg.where).toEqual({ campaignId: 'c1' });
      expect(findArg.skip).toBe(25); // (2-1) * 25
      expect(findArg.take).toBe(25);
    });

    it('adds status filter when provided', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      prisma.message.count.mockResolvedValue(0);

      await repo.listMessages({
        campaignId: 'c1',
        page: 1,
        pageSize: 10,
        status: 'FAILED',
      });

      const findArg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(findArg.where).toEqual({ campaignId: 'c1', status: 'FAILED' });
    });

    it('adds search filter on contact name + phone', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      prisma.message.count.mockResolvedValue(0);

      await repo.listMessages({
        campaignId: 'c1',
        page: 1,
        pageSize: 10,
        search: 'Maria',
      });

      const findArg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(findArg.where).toEqual({
        campaignId: 'c1',
        contact: {
          OR: [
            { name: { contains: 'Maria', mode: 'insensitive' } },
            { phoneE164: { contains: 'Maria' } },
          ],
        },
      });
    });

    it('combines status and search filters', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      prisma.message.count.mockResolvedValue(0);

      await repo.listMessages({
        campaignId: 'c1',
        page: 1,
        pageSize: 10,
        status: 'SENT',
        search: '+55',
      });

      const findArg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(findArg.where.campaignId).toBe('c1');
      expect(findArg.where.status).toBe('SENT');
      expect(findArg.where.contact).toBeDefined();
    });
  });

  describe('findMessageById', () => {
    it('delegates with campaign include', async () => {
      prisma.message.findUnique.mockResolvedValue({ id: 'm1' } as any);
      const result = await repo.findMessageById('m1');
      expect(result).toEqual({ id: 'm1' });
      expect(prisma.message.findUnique).toHaveBeenCalledWith({
        where: { id: 'm1' },
        include: { campaign: true },
      });
    });
  });

  describe('findFailedMessageIds', () => {
    it('selects FAILED messages (id + contactId), excluding indeterminate-outcome codes and contacts already reached/in-flight', async () => {
      prisma.message.findMany.mockResolvedValue([
        { id: 'm1', contactId: 'k1' },
      ] as any);
      const result = await repo.findFailedMessageIds('c1');
      expect(result).toEqual([{ id: 'm1', contactId: 'k1' }]);
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: {
          campaignId: 'c1',
          status: 'FAILED',
          errorCode: {
            notIn: [
              'twilio.indeterminate',
              'sending_stuck',
              'zernio.indeterminate',
              'gozap.indeterminate',
              'zernio.timeout',
              'gozap.timeout',
            ],
          },
          contactId: { not: null },
          contact: {
            is: {
              messages: {
                none: {
                  campaignId: 'c1',
                  direction: 'OUTBOUND',
                  status: {
                    in: [
                      'SENT',
                      'DELIVERED',
                      'READ',
                      'QUEUED',
                      'SENDING',
                      'WAITING_INSTANCE',
                    ],
                  },
                },
              },
            },
          },
        },
        select: { id: true, contactId: true },
        orderBy: { createdAt: 'desc' },
        distinct: ['contactId'],
      });
    });

    it('pula (exclui) o contato com uma mensagem-irmã SENT nesta campanha — via contact:{is:...}, não contactId null', async () => {
      // Regressão da revisão: `contact: { messages: {...} }` (sem `is`) casaria
      // também Message com contactId null (não pertence a contato nenhum) —
      // `is` é o que exclui essas linhas corretamente.
      prisma.message.findMany.mockResolvedValue([] as any);
      await repo.findFailedMessageIds('c1');
      const arg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(arg.where.contact).toBeDefined();
      expect(arg.where.contact.is).toBeDefined();
      // Estrutural: NÃO é `{ messages: {...} }` direto no nível de `contact`.
      expect(Object.keys(arg.where.contact)).toEqual(['is']);
      expect(arg.where.contact.is.messages.none.status.in).toContain('SENT');
    });

    /**
     * C10 (auditoria 2026-08-19) — o retry em massa itera sobre LINHAS, não
     * sobre pessoas. Um contato com duas FAILED transitórias na mesma campanha
     * (lote 1 falhou, lote 2 recriou a linha e falhou também) era resetado e
     * enfileirado DUAS vezes, no mesmo Promise.all, sem checagem entre as duas:
     * dois workers, duas linhas distintas, dois envios reais.
     */
    it('devolve NO MÁXIMO UMA linha por contato (distinct), ignorando linha sem contato', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      await repo.findFailedMessageIds('c1');
      const arg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(arg.distinct).toEqual(['contactId']);
      expect(arg.where.contactId).toEqual({ not: null });
      // A mais recente é a que representa o contato — é a que o operador vê.
      expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    });

    /**
     * C2 (auditoria 2026-08-19) — "Reenviar falhas" ignorava a regra do mesmo
     * template: a linha FAILED da campanha B era reenfileirada mesmo depois de
     * a campanha A (mesmo template) ter ENTREGUE o texto àquela pessoa. O
     * único guard existente era escopado à PRÓPRIA campanha.
     */
    it('aplica também o bloqueio de campanhas IRMÃS do mesmo template, quando há', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      const irma = {
        direction: 'OUTBOUND' as const,
        OR: [{ campaignId: { in: ['A'] }, status: { in: ['DELIVERED'] } }],
      };
      await repo.findFailedMessageIds('c1', irma as any);
      const arg = prisma.message.findMany.mock.calls[0][0] as any;
      // `is` continua sendo o invólucro (contactId nulo não pode dar match).
      expect(Object.keys(arg.where.contact)).toEqual(['is']);
      const clausulas = arg.where.contact.is.AND;
      expect(clausulas).toHaveLength(2);
      expect(clausulas[1]).toEqual({ messages: { none: irma } });
    });

    it('sem campanha irmã, NÃO monta um `none` vazio (que não excluiria ninguém)', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      await repo.findFailedMessageIds('c1', null);
      const arg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(arg.where.contact.is.AND).toBeUndefined();
      expect(arg.where.contact.is.messages).toBeDefined();
    });
  });

  /**
   * O contador do botão "Reenviar falhas (N)" existe para dizer o que o clique
   * VAI fazer. Depois de C2 (o reenvio passou a respeitar a regra do mesmo
   * template), um contador que ignorasse as irmãs prometeria N e enviaria menos
   * — a prévia mentindo, que é justamente o que a casa não aceita.
   */
  describe('countUnreachedFailedContacts — o número tem de bater com o reenvio', () => {
    it('aplica o bloqueio das campanhas irmãs do mesmo template quando há', async () => {
      prisma.message.findMany.mockResolvedValue([] as any);
      const irma = {
        direction: 'OUTBOUND' as const,
        OR: [{ campaignId: { in: ['A'] }, status: { in: ['DELIVERED'] } }],
      };
      await repo.countUnreachedFailedContacts('c1', irma as any);
      const arg = prisma.message.findMany.mock.calls[0][0] as any;
      expect(arg.where.contact.is.AND[1]).toEqual({
        messages: { none: irma },
      });
    });
  });

  describe('countUnreachedFailedContacts', () => {
    it('conta CONTATOS distintos com falha retryável ainda não alcançados/em voo nesta campanha', async () => {
      prisma.message.findMany.mockResolvedValue([
        { contactId: 'k1' },
        { contactId: 'k2' },
      ] as any);
      const result = await repo.countUnreachedFailedContacts('c1');
      expect(result).toBe(2);
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: {
          campaignId: 'c1',
          status: 'FAILED',
          errorCode: {
            notIn: [
              'twilio.indeterminate',
              'sending_stuck',
              'zernio.indeterminate',
              'gozap.indeterminate',
              'zernio.timeout',
              'gozap.timeout',
            ],
          },
          contactId: { not: null },
          contact: {
            is: {
              messages: {
                none: {
                  campaignId: 'c1',
                  direction: 'OUTBOUND',
                  status: {
                    in: [
                      'SENT',
                      'DELIVERED',
                      'READ',
                      'QUEUED',
                      'SENDING',
                      'WAITING_INSTANCE',
                    ],
                  },
                },
              },
            },
          },
        },
        select: { contactId: true },
        distinct: ['contactId'],
      });
    });
  });

  describe('hasReachedOrInFlightSibling', () => {
    it('retorna true quando o contato tem mensagem-irmã entregue/em voo nesta campanha', async () => {
      prisma.message.count.mockResolvedValue(1);
      const result = await repo.hasReachedOrInFlightSibling('c1', 'k1');
      expect(result).toBe(true);
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: {
          campaignId: 'c1',
          direction: 'OUTBOUND',
          status: {
            in: [
              'SENT',
              'DELIVERED',
              'READ',
              'QUEUED',
              'SENDING',
              'WAITING_INSTANCE',
            ],
          },
          contactId: 'k1',
        },
      });
    });

    it('retorna false quando não há irmã alcançada/em voo', async () => {
      prisma.message.count.mockResolvedValue(0);
      const result = await repo.hasReachedOrInFlightSibling('c1', 'k1');
      expect(result).toBe(false);
    });

    /**
     * ★ C12 (2ª rodada) — A PRÓPRIA LINHA NÃO É IRMÃ DELA MESMA.
     *
     * `redispatchMessage` passou a fazer esta pergunta ANTES de mexer na linha,
     * e ele redispara linhas que podem estar em SENT/DELIVERED/READ — estados
     * que ELA MESMA casa. Sem excluir o próprio id, "disparar novamente" numa
     * mensagem ENTREGUE se auto-bloquearia: o operador clicaria no botão e
     * receberia "este contato já recebeu", falando da linha que ele clicou.
     */
    it('exclui a PRÓPRIA linha da consulta quando o chamador passa excludeMessageId', async () => {
      prisma.message.count.mockResolvedValue(0);
      await repo.hasReachedOrInFlightSibling('c1', 'k1', 'm-clicada');
      const arg = prisma.message.count.mock.calls[0][0] as any;
      expect(arg.where.id).toEqual({ not: 'm-clicada' });
      expect(arg.where.contactId).toBe('k1');
    });

    it('sem excludeMessageId a consulta não filtra por id (o retry de FALHA continua igual)', async () => {
      prisma.message.count.mockResolvedValue(0);
      await repo.hasReachedOrInFlightSibling('c1', 'k1');
      const arg = prisma.message.count.mock.calls[0][0] as any;
      expect(arg.where).not.toHaveProperty('id');
    });
  });

  describe('resetForRetry', () => {
    // F2 — errorCode/errorMessage/failedAt/failureReason deixaram de ser
    // zerados aqui: a prova da falha ANTERIOR precisa sobreviver enquanto a
    // linha está QUEUED de novo (só markSent, no sucesso, limpa essa prova).
    it('resets a message to QUEUED PRESERVANDO errorCode/errorMessage/failedAt (a prova da falha anterior)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const r = await repo.resetForRetry('m1');
      expect(r).toBe('ok');
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', status: 'FAILED' },
        data: {
          status: 'QUEUED',
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          providerMessageId: null,
        },
      });
    });

    it('NÃO zera errorCode/errorMessage/failedAt/failureReason', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.resetForRetry('m1');
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data).not.toHaveProperty('errorCode');
      expect(arg.data).not.toHaveProperty('errorMessage');
      expect(arg.data).not.toHaveProperty('failedAt');
      expect(arg.data).not.toHaveProperty('failureReason');
    });

    /**
     * ★ I8 (revisão de integração) — A ESCRITA É CONDICIONAL, como a do gêmeo
     * `resetForRedispatch` e a de todos os outros escritores de status. A
     * leitura do serviço é TOCTOU: entre ela e esta escrita outro operador pode
     * ter reenviado a MESMA linha (ela já não é FAILED) ou o worker pode tê-la
     * reivindicado. O `update` por id puro atropelava esse estado em silêncio.
     */
    it('I8 — só pega a linha se ela AINDA está FAILED, e diz por que não pegou', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      const r = await repo.resetForRetry('m1');
      expect(r).toBe('not_retryable');
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'FAILED' });
    });

    /**
     * ★ I8 — O 500 DO BOTÃO "REENVIAR", O ÚNICO CAMINHO QUE FALTAVA FECHAR.
     *
     * `QUEUED` está DENTRO do predicado do índice único parcial
     * `Message_campaign_contact_live_key`: mover esta linha para QUEUED é
     * ILEGAL se o mesmo contato já ganhou outra linha viva na campanha (a
     * retomada por lotes faz exatamente isso). Provado contra Postgres real —
     * `P2002 Unique constraint failed on the fields: (campaignId, contactId)` —
     * e sem este `catch` ele subia cru como "An unexpected error occurred" num
     * botão que o operador usa DURANTE um disparo. O gêmeo
     * `resetForRedispatch` fechou essa porta na 2ª rodada da auditoria; o
     * retry ficou de fora.
     */
    it('I8 — P2002 da trava de banco vira "contact_already_live" — nunca um 500', async () => {
      prisma.message.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }) as never,
      );
      const r = await repo.resetForRetry('m1');
      expect(r).toBe('contact_already_live');
    });

    it('I8 — erro de banco que NÃO é a trava continua subindo (não engolimos falha real)', async () => {
      prisma.message.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('boom', {
          code: 'P1001',
          clientVersion: 'x',
        }) as never,
      );
      await expect(repo.resetForRetry('m1')).rejects.toThrow();
    });
  });

  /**
   * ★ I15 (revisão de integração) — "O CANAL MORREU: ESTAS NUNCA CHEGARAM."
   *
   * Com Prisma mockado o `where` é o único lugar onde a decisão existe (o
   * retorno é fabricado e ignoraria qualquer filtro), então estes testes
   * afirmam sobre o ARGUMENTO. O comportamento contra banco de verdade foi
   * provado num Postgres descartável: das linhas de uma campanha cancelada, só
   * a OUTBOUND SENT virou FAILED — DELIVERED, READ, FAILED e a INBOUND SENT
   * ficaram intocadas, e uma segunda chamada liberou 0.
   */
  describe('countUnconfirmedSent / releaseUnconfirmedSent (I15)', () => {
    it('conta só o que SAIU e nunca teve confirmação — nunca o que chegou', async () => {
      prisma.message.count.mockResolvedValue(3 as never);
      const n = await repo.countUnconfirmedSent('c1');
      expect(n).toBe(3);
      const arg = prisma.message.count.mock.calls[0][0] as any;
      expect(arg.where).toEqual({
        campaignId: 'c1',
        direction: 'OUTBOUND',
        status: 'SENT',
      });
    });

    /**
     * As duas travas que impedem isto de virar um "mandar de novo para todo
     * mundo": `status: 'SENT'` (DELIVERED/READ são prova de chegada e não são
     * tocados nem a pedido) e `direction: 'OUTBOUND'` (uma resposta do eleitor
     * não é uma entrega nossa).
     */
    it('libera SÓ a OUTBOUND SENT, e a marca como falha de CANAL com motivo legível', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 3 } as never);
      const at = new Date('2026-08-19T10:00:00.000Z');
      const n = await repo.releaseUnconfirmedSent('c1', at);
      expect(n).toBe(3);
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({
        campaignId: 'c1',
        direction: 'OUTBOUND',
        status: 'SENT',
      });
      expect(arg.data).toMatchObject({
        status: 'FAILED',
        errorCode: UNCONFIRMED_SENT_RELEASED_CODE,
        failureReason: 'CANAL_FORA',
        failedAt: at,
      });
      // FAILED é o destino porque falha NÃO bloqueia em camada nenhuma — é isso
      // que devolve a pessoa à audiência do mesmo template.
      expect(arg.data.status).toBe('FAILED');
    });

    /**
     * `sentAt` é PRESERVADO: a linha de fato saiu para o provedor, e apagar isso
     * seria reescrever a história. O que a liberação muda é a leitura do
     * DESFECHO, não o registro do que aconteceu.
     */
    it('preserva sentAt — a mensagem saiu mesmo; o que mudou foi o desfecho', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as never);
      await repo.releaseUnconfirmedSent('c1');
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data).not.toHaveProperty('sentAt');
      expect(arg.data).not.toHaveProperty('deliveredAt');
      expect(arg.data).not.toHaveProperty('readAt');
    });
  });

  describe('resetForRedispatch', () => {
    // Mesma regra do resetForRetry: a linha volta para QUEUED com canal e
    // variáveis atualizados, mas a prova da falha anterior sobrevive.
    it('reseta para QUEUED regravando instanceId/variables/queuedAt sem zerar a prova da falha anterior', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const ok = await repo.resetForRedispatch('m1', {
        instanceId: 'inst-2',
        variables: { nome: 'Ana' },
      });
      expect(ok).toBe('ok');
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where.id).toBe('m1');
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'QUEUED',
          instanceId: 'inst-2',
          variables: { nome: 'Ana' },
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          providerMessageId: null,
        }),
      );
      expect(arg.data.queuedAt).toBeInstanceOf(Date);
      expect(arg.data).not.toHaveProperty('errorCode');
      expect(arg.data).not.toHaveProperty('errorMessage');
      expect(arg.data).not.toHaveProperty('failedAt');
      expect(arg.data).not.toHaveProperty('failureReason');
    });

    /**
     * C12 — a escrita é CONDICIONAL, como a de todos os outros escritores de
     * status (`claimForSend`, `markMessageEnqueueFailed`). Um `update` por id
     * puro ressuscitava para QUEUED uma linha que o worker estava enviando
     * NAQUELE instante, e ela saía duas vezes.
     */
    it('NÃO pega uma linha em voo e diz POR QUE (escrita condicional, não update por id)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      const r = await repo.resetForRedispatch('m1', {
        instanceId: 'inst-2',
        variables: {},
      });
      expect(r).toBe('not_redispatchable');
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where.status).toEqual({
        notIn: ['SENDING', 'QUEUED', 'WAITING_INSTANCE'],
      });
    });

    /**
     * ★ C12 (2ª rodada) — O 500 DO BOTÃO "DISPARAR NOVAMENTE".
     *
     * A trava de banco nova (índice único parcial "uma linha viva por
     * campanha+contato") recusa mover esta linha para QUEUED quando o MESMO
     * contato já tem outra linha viva na campanha — o caso normalíssimo da
     * retomada por lotes (lote 1 falhou, lote 2 recriou a linha). O Prisma
     * levanta P2002, que não é DomainError: o filtro genérico devolvia 500
     * "An unexpected error occurred" e o operador só via o Sentry acender.
     *
     * A leitura prévia do serviço é TOCTOU por natureza; esta é a SEGUNDA
     * tranca, e ela precisa dizer ao serviço qual dos dois motivos ocorreu.
     */
    it('P2002 da trava de banco vira "contact_already_live" — nunca um 500', async () => {
      prisma.message.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }) as never,
      );
      const r = await repo.resetForRedispatch('m1', {
        instanceId: 'inst-2',
        variables: {},
      });
      expect(r).toBe('contact_already_live');
    });

    it('erro de banco que NÃO é a trava continua subindo (não engolimos falha real)', async () => {
      prisma.message.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('boom', {
          code: 'P1001',
          clientVersion: 'x',
        }) as never,
      );
      await expect(
        repo.resetForRedispatch('m1', { instanceId: 'i', variables: {} }),
      ).rejects.toThrow();
    });

    /**
     * A linha redisparada continuava apontada para o broadcast ANTIGO do
     * Zernio. `zernio-broadcast-poll.service.ts` seleciona por
     * `zernioBroadcastId` e escreve o status por id: enquanto aquele disparo
     * ainda estiver sendo pollado, ele virava a linha de volta para
     * SENT/DELIVERED — e aí o novo envio nem saía, porque `claimForSend` exige
     * QUEUED e falhava em silêncio.
     */
    it('desliga a linha do broadcast ANTIGO do Zernio (senão o poll antigo a rouba de volta)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.resetForRedispatch('m1', {
        instanceId: 'inst-2',
        variables: {},
      });
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data.zernioBroadcastId).toBeNull();
    });
  });

  /**
   * ★ A TRAVA DE BANCO (auditoria 2026-08-19, item 7 do pacote).
   *
   * O índice único parcial `Message_campaign_contact_live_key` faz a duplicata
   * virar erro de banco. Para isso, quem cria linha de campanha tem de olhar
   * antes: se já existe uma linha VIVA daquele contato nesta campanha, ou não
   * há nada a fazer (está em voo), ou é a linha existente que volta para a fila
   * ("Disparar novamente para TODOS").
   */
  describe('createMessage — uma linha viva por (campanha, contato)', () => {
    it('cria normalmente quando o contato não tem nenhuma linha viva nesta campanha', async () => {
      prisma.message.findFirst.mockResolvedValue(null as any);
      prisma.message.create.mockResolvedValue({ id: 'novo' } as any);

      const m = await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-1',
        variables: {},
      });

      expect(m?.id).toBe('novo');
      // A consulta é pelo par exato, OUTBOUND, restrita aos estados vivos.
      const arg = prisma.message.findFirst.mock.calls[0][0] as any;
      expect(arg.where).toEqual({
        campaignId: 'c1',
        contactId: 'k1',
        direction: 'OUTBOUND',
        status: {
          in: [
            'SENT',
            'DELIVERED',
            'READ',
            'QUEUED',
            'SENDING',
            'WAITING_INSTANCE',
          ],
        },
      });
    });

    it.each(['QUEUED', 'SENDING', 'WAITING_INSTANCE'])(
      'NÃO cria nada quando o contato já tem linha EM VOO (%s) — devolve null',
      async (status) => {
        prisma.message.findFirst.mockResolvedValue({
          id: 'viva',
          status,
        } as any);

        const m = await repo.createMessage({
          campaignId: 'c1',
          contactId: 'k1',
          instanceId: 'inst-1',
          variables: {},
        });

        expect(m).toBeNull();
        expect(prisma.message.create).not.toHaveBeenCalled();
        expect(prisma.message.updateMany).not.toHaveBeenCalled();
      },
    );

    it('NÃO cria uma segunda linha para quem já RECEBEU — devolve null', async () => {
      prisma.message.findFirst.mockResolvedValue({
        id: 'entregue',
        status: 'DELIVERED',
      } as any);

      const m = await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-1',
        variables: {},
      });

      expect(m).toBeNull();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('"disparar novamente para TODOS" RESSUSCITA a linha entregue em vez de criar outra', async () => {
      prisma.message.findFirst.mockResolvedValue({
        id: 'entregue',
        status: 'DELIVERED',
      } as any);
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.message.findUnique.mockResolvedValue({ id: 'entregue' } as any);

      const m = await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-2',
        variables: { nome: 'Ana' },
        resendReached: true,
      });

      expect(m?.id).toBe('entregue');
      expect(prisma.message.create).not.toHaveBeenCalled();
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      // Escrita CONDICIONAL: se o worker já mexeu na linha, não pega.
      expect(arg.where).toEqual({
        id: 'entregue',
        status: { in: ['SENT', 'DELIVERED', 'READ'] },
      });
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'QUEUED',
          instanceId: 'inst-2',
          variables: { nome: 'Ana' },
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          providerMessageId: null,
        }),
      );
    });

    /**
     * A ressurreição deixava a linha apontada para o broadcast ANTIGO do Zernio
     * e APAGAVA o vínculo com o lote que a produziu. O primeiro é um bug de
     * entrega: `zernio-broadcast-poll.service.ts` seleciona por
     * `zernioBroadcastId` e escreve status por id, então o poll do disparo
     * antigo podia virar a linha ressuscitada de volta para SENT/DELIVERED — e
     * o novo envio nem sairia (`claimForSend` exige QUEUED). O segundo é
     * histórico: um lote já fechado perdia uma linha da sua própria contagem.
     */
    it('a ressurreição desliga o broadcast antigo e NÃO apaga o lote de origem quando não há lote novo', async () => {
      prisma.message.findFirst.mockResolvedValue({
        id: 'entregue',
        status: 'DELIVERED',
      } as any);
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.message.findUnique.mockResolvedValue({ id: 'entregue' } as any);

      await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-2',
        variables: {},
        resendReached: true,
      });

      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data.zernioBroadcastId).toBeNull();
      expect(arg.data).not.toHaveProperty('campaignBatchId');
    });

    it('a ressurreição DENTRO de um lote passa a pertencer ao lote novo', async () => {
      prisma.message.findFirst.mockResolvedValue({
        id: 'entregue',
        status: 'READ',
      } as any);
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.message.findUnique.mockResolvedValue({ id: 'entregue' } as any);

      await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-2',
        variables: {},
        campaignBatchId: 'lote-9',
        resendReached: true,
      });

      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data.campaignBatchId).toBe('lote-9');
    });

    it('a corrida perdida (índice único do banco) devolve null em vez de estourar o disparo', async () => {
      prisma.message.findFirst.mockResolvedValue(null as any);
      prisma.message.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }) as any,
      );

      const m = await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-1',
        variables: {},
      });

      expect(m).toBeNull();
    });
  });

  describe('hasRunningCampaignOnInstance', () => {
    it('counts QUEUED/RUNNING campaigns on the instance, excluding the given id', async () => {
      prisma.campaign.count.mockResolvedValue(1 as any);
      const res = await repo.hasRunningCampaignOnInstance('inst-1', 'c-self');
      expect(res).toBe(true);
      const arg = prisma.campaign.count.mock.calls[0][0] as any;
      expect(arg.where).toEqual(
        expect.objectContaining({
          defaultInstanceId: 'inst-1',
          status: { in: ['QUEUED', 'RUNNING'] },
          id: { not: 'c-self' },
        }),
      );
    });

    it('returns false when none running', async () => {
      prisma.campaign.count.mockResolvedValue(0 as any);
      expect(await repo.hasRunningCampaignOnInstance('inst-1')).toBe(false);
    });
  });

  describe('markMessageEnqueueFailed', () => {
    // Scoped to status:'QUEUED' (updateMany) — the BullMQ `add` can fail AFTER
    // the job already entered the queue; stamping FAILED over a row another
    // attempt already claimed would brand a sent (and billed) message as
    // failed, and "Reenviar falhas" would then duplicate it.
    it('marks the row FAILED with the default enqueue_failed code when no code is given', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const count = await repo.markMessageEnqueueFailed('m1', 'Redis down');
      expect(count).toBe(1);
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'QUEUED' });
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'FAILED',
          errorCode: 'enqueue_failed',
          errorMessage: 'Redis down',
          // F2 — 'enqueue_failed' → CANAL_FORA.
          failureReason: 'CANAL_FORA',
        }),
      );
      expect(arg.data.failedAt).toBeInstanceOf(Date);
    });

    // U4 — callers that hold a classified code (e.g. a DomainError.code) can
    // thread it through instead of the generic 'enqueue_failed' bucket.
    it('persists a caller-provided classified errorCode when given', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.markMessageEnqueueFailed(
        'm1',
        'Campaign default instance has been deleted',
        'campaign.default_instance_inactive',
      );
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.data).toEqual(
        expect.objectContaining({
          status: 'FAILED',
          errorCode: 'campaign.default_instance_inactive',
          errorMessage: 'Campaign default instance has been deleted',
        }),
      );
    });

    it('returns 0 when the row is no longer QUEUED (already claimed by another attempt)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      const count = await repo.markMessageEnqueueFailed('m1', 'Redis down');
      expect(count).toBe(0);
    });
  });

  describe('groupFailuresByReason', () => {
    // F2 — alimenta o endpoint GET /campaigns/:id/failure-reasons (T7):
    // agregação [{failureReason, count}] das Messages FAILED de UMA campanha.
    it('agrega Message FAILED da campanha por failureReason', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { failureReason: 'OPT_OUT', _count: 5 },
        { failureReason: 'TELEFONE_INVALIDO', _count: 2 },
        { failureReason: null, _count: 1 },
      ] as any);

      const result = await repo.groupFailuresByReason('c1');

      expect(prisma.message.groupBy).toHaveBeenCalledWith({
        by: ['failureReason'],
        where: { campaignId: 'c1', status: 'FAILED' },
        _count: true,
      });
      expect(result).toEqual([
        { failureReason: 'OPT_OUT', count: 5 },
        { failureReason: 'TELEFONE_INVALIDO', count: 2 },
        { failureReason: null, count: 1 },
      ]);
    });

    it('devolve [] quando a campanha não tem Message FAILED', async () => {
      prisma.message.groupBy.mockResolvedValue([] as any);
      const result = await repo.groupFailuresByReason('c1');
      expect(result).toEqual([]);
    });
  });

  describe('listFailedContactsPaged', () => {
    // F2 T7 — a aba "falhados" da tela de destinatários: quem tem ao menos uma
    // Message FAILED nesta campanha, com o MOTIVO da falha embutido (mesmo
    // molde de listSkippedContactsPaged: a mensagem FAILED mais recente decide
    // o motivo exibido).
    it('filtra contatos com Message FAILED nesta campanha e embute o failureReason', async () => {
      prisma.$transaction.mockResolvedValue([
        [
          {
            id: 'ct1',
            name: 'Ana',
            phoneE164: '+5592991110001',
            marketingUndeliverableAt: null,
            marketingUndeliverableReason: null,
            messages: [{ failureReason: 'TELEFONE_INVALIDO', errorCode: '21211' }],
          },
        ],
        1,
      ] as never);

      const result = await repo.listFailedContactsPaged(
        { optedOut: false },
        'camp1',
        { page: 1, pageSize: 50 },
      );

      const findManyArgs = prisma.contact.findMany.mock.calls[0][0] as any;
      expect(findManyArgs.where).toEqual({
        AND: [
          { optedOut: false },
          { messages: { some: { campaignId: 'camp1', status: 'FAILED' } } },
          {
            messages: { none: reachedOrInFlightInCampaign('camp1') },
          },
        ],
      });
      expect(findManyArgs.select.messages.where).toEqual({
        campaignId: 'camp1',
        status: 'FAILED',
      });

      expect(result).toEqual({
        items: [
          {
            id: 'ct1',
            name: 'Ana',
            phoneE164: '+5592991110001',
            marketingUndeliverableAt: null,
            marketingUndeliverableReason: null,
            failureReason: 'TELEFONE_INVALIDO',
            errorCode: '21211',
          },
        ],
        total: 1,
      });
    });

    it('devolve failureReason/errorCode null quando a Message FAILED não tem motivo classificado', async () => {
      prisma.$transaction.mockResolvedValue([
        [
          {
            id: 'ct2',
            name: null,
            phoneE164: '+5592991110002',
            marketingUndeliverableAt: null,
            marketingUndeliverableReason: null,
            messages: [],
          },
        ],
        1,
      ] as never);

      const result = await repo.listFailedContactsPaged({}, 'camp1', {
        page: 1,
        pageSize: 50,
      });

      expect(result.items[0]).toMatchObject({
        failureReason: null,
        errorCode: null,
      });
    });

    // REGRESSÃO — a aba "Falhas" listava quem RECEBEU a campanha.
    // `createMessage` grava uma linha nova por disparo e FAILED não é um
    // status "tratado", então lote 1 = msg FAILED (Zernio 500) e lote 2 =
    // msg DELIVERED é o caminho NORMAL. O contato aparecia em "Enviados" E em
    // "Falhas", mas o botão "Reenviar falhas (N)" (countUnreachedFailedContacts)
    // não o contava — o operador reenviava à mão e duplicava a entrega.
    // A lista tem que excluir a MESMA condição de "alcançado/em voo"
    // (`reachedOrInFlightInCampaign`) que o contador exclui. Isso NÃO torna os
    // dois predicados iguais no geral — ver o docblock de
    // `listFailedContactsPaged` acima para as divergências conhecidas
    // (filtro de errorCode indeterminado, recorte de audiência).
    it('exclui quem já foi alcançado/está em voo, usando o mesmo predicado reachedOrInFlightInCampaign do contador', async () => {
      prisma.$transaction.mockResolvedValue([[], 0] as never);

      await repo.listFailedContactsPaged({}, 'camp1', {
        page: 1,
        pageSize: 50,
      });

      const findManyArgs = prisma.contact.findMany.mock.calls[0][0] as any;
      const noneClause = (findManyArgs.where.AND as any[]).find(
        (c) => c?.messages?.none,
      );
      expect(noneClause).toBeDefined();
      expect(noneClause.messages.none).toEqual(
        reachedOrInFlightInCampaign('camp1'),
      );

      // O `count` do total roda sobre o MESMO where — a paginação não pode
      // contar uma população diferente da que a página lista.
      const countArgs = prisma.contact.count.mock.calls[0][0] as any;
      expect(countArgs.where).toEqual(findManyArgs.where);
    });
  });

  describe('markWaitingForInstance', () => {
    // Scoped to the state the CALLER declares via `from` — never a fixed
    // ['QUEUED','SENDING'] union. A fixed union would let a pre-claim job
    // steal a row a worker already claimed into SENDING (or vice-versa).
    it('scopes the update to status:from=QUEUED (pre-claim caller) and returns count', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      const count = await repo.markWaitingForInstance({
        messageId: 'm1',
        instanceId: 'inst-1',
        from: 'QUEUED',
      });
      expect(count).toBe(1);
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'QUEUED' });
      expect(arg.data).toEqual({
        status: 'WAITING_INSTANCE',
        instanceId: 'inst-1',
      });
    });

    it('scopes the update to status:from=SENDING (post-claim caller)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 1 } as any);
      await repo.markWaitingForInstance({
        messageId: 'm1',
        instanceId: 'inst-1',
        from: 'SENDING',
      });
      const arg = prisma.message.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'm1', status: 'SENDING' });
    });

    it('returns 0 when the row is no longer in the declared `from` state (already moved on)', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 } as any);
      const count = await repo.markWaitingForInstance({
        messageId: 'm1',
        instanceId: 'inst-1',
        from: 'SENDING',
      });
      expect(count).toBe(0);
    });
  });

  describe('createMessage', () => {
    it('creates a QUEUED message with given variables', async () => {
      prisma.message.create.mockResolvedValue({ id: 'm1' } as any);
      const result = await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-1',
        variables: { name: 'Bob' } as any,
      });
      expect(result).toEqual({ id: 'm1' });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          campaignId: 'c1',
          contactId: 'k1',
          instanceId: 'inst-1',
          variables: { name: 'Bob' },
          status: 'QUEUED',
          // ZE — fora de um lote (Disparar clássico, retry avulso), a mensagem
          // não pertence a lote nenhum.
          campaignBatchId: null,
        },
      });
    });

    it('ZE — vincula a mensagem ao lote quando ela vem de um', async () => {
      prisma.message.create.mockResolvedValue({ id: 'm2' } as any);
      await repo.createMessage({
        campaignId: 'c1',
        contactId: 'k1',
        instanceId: 'inst-1',
        variables: {} as any,
        campaignBatchId: 'batch-7',
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ campaignBatchId: 'batch-7' }),
      });
    });
  });

  // ZE — o histórico de lotes é o que o operador vê ("quando, quantos,
  // resultado"). O `seq` é atribuído sob o lock 'resend' da campanha.
  describe('createBatch', () => {
    it('numera o primeiro lote da campanha como 1', async () => {
      prisma.campaignBatch.findFirst.mockResolvedValue(null as any);
      prisma.campaignBatch.create.mockResolvedValue({ id: 'b1', seq: 1 } as any);

      await repo.createBatch({ campaignId: 'c1', requested: 50 });

      expect(prisma.campaignBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          campaignId: 'c1',
          seq: 1,
          requested: 50,
        }),
      });
    });

    it('continua a numeração a partir do último lote', async () => {
      prisma.campaignBatch.findFirst.mockResolvedValue({ seq: 3 } as any);
      prisma.campaignBatch.create.mockResolvedValue({ id: 'b4', seq: 4 } as any);

      await repo.createBatch({ campaignId: 'c1', requested: 100 });

      expect(prisma.campaignBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ seq: 4 }),
      });
    });
  });

  describe('listBatches', () => {
    it('devolve o resultado de cada lote a partir das mensagens que ele gerou', async () => {
      prisma.campaignBatch.findMany.mockResolvedValue([
        {
          id: 'b1',
          seq: 1,
          requested: 50,
          queued: 50,
          skipped: 2,
          startedAt: new Date('2026-07-12T10:00:00Z'),
          finishedAt: new Date('2026-07-12T10:01:00Z'),
        },
      ] as any);
      prisma.message.groupBy.mockResolvedValue([
        { campaignBatchId: 'b1', status: 'DELIVERED', _count: 47 },
        { campaignBatchId: 'b1', status: 'FAILED', _count: 3 },
      ] as any);

      const batches = await repo.listBatches('c1');

      expect(batches).toHaveLength(1);
      expect(batches[0].seq).toBe(1);
      expect(batches[0].statusCounts).toEqual([
        { status: 'DELIVERED', count: 47 },
        { status: 'FAILED', count: 3 },
      ]);
    });

    it('não consulta mensagens quando a campanha não tem lote', async () => {
      prisma.campaignBatch.findMany.mockResolvedValue([] as any);

      expect(await repo.listBatches('c1')).toEqual([]);
      expect(prisma.message.groupBy).not.toHaveBeenCalled();
    });
  });
});
