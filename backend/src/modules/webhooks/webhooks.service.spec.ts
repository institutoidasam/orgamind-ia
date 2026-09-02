import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { createHmac } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { Env } from '../../shared/config/env.schema';
import type Redis from 'ioredis';
import { ChatIngestService } from '../chat/chat-ingest.service';
import { ChatEventsService } from '../chat/chat-events.service';
import { ConsentService, GLOBAL_PURPOSE } from '../consent/consent.service';
import { ConsentAction, ConsentSource } from '@prisma/client';
import { ZernioCloudAdapter } from '../whatsapp-providers/adapters/zernio-cloud.adapter';
import { TemplatesService } from '../templates/templates.service';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let prisma: MockProxy<PrismaService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let config: MockProxy<ConfigService<Env>>;
  let audit: MockProxy<AuditService>;
  let redis: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let repo: MockProxy<WhatsappProvidersRepository>;
  let chatIngest: MockProxy<ChatIngestService>;
  let chatEvents: MockProxy<ChatEventsService>;
  let consent: MockProxy<ConsentService>;
  let templates: MockProxy<TemplatesService>;
  const APP_SECRET = 'super-secret-meta-app-secret-1234567890';

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    wa = mockDeep<WhatsappProvidersService>();
    config = mockDeep<ConfigService<Env>>();
    audit = mockDeep<AuditService>();
    repo = mockDeep<WhatsappProvidersRepository>();
    chatIngest = mockDeep<ChatIngestService>();
    chatEvents = mockDeep<ChatEventsService>();
    consent = mockDeep<ConsentService>();
    // Default: ninguém suprimido. A fonte da verdade do opt-out passou a ser a
    // SuppressionList (via ConsentService), não o boolean Contact.optedOut.
    consent.isSuppressed.mockResolvedValue(false);
    consent.record.mockResolvedValue({ eventId: 'ev1', created: true });
    consent.reinstate.mockResolvedValue([]);
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      del: vi.fn().mockResolvedValue(1),
    };
    config.get.mockImplementation((key: unknown) => {
      if (key === 'META_APP_SECRET') return APP_SECRET;
      if (key === 'META_WEBHOOK_VERIFY_TOKEN') return 'verify-token';
      return undefined;
    });
    // Default: no inbound messages — individual tests override as needed.
    wa.parseInboundMessages.mockReturnValue([]);
    wa.parseInboundMessagesFor.mockReturnValue([]);
    // Idem para os acks de status: sem um default, um process() que não se
    // importa com status (ex.: os testes de template do ZC) receberia `undefined`
    // do automock e estouraria em "events is not iterable".
    wa.parseWebhookFor.mockReturnValue([]);
    // Status updates now go through the atomic rank-guarded updateMany; default
    // to a single matched row so the happy-path side effects fire.
    prisma.message.updateMany.mockResolvedValue({ count: 1 });
    repo.findLastEvent.mockResolvedValue(null);
    repo.createEvent.mockResolvedValue({ id: 'e1' } as never);
    templates = mockDeep<TemplatesService>();
    templates.applyZernioTemplateStatus.mockResolvedValue(true);
    service = new WebhooksService(
      prisma,
      wa,
      config,
      audit,
      redis as never,
      repo,
      { maybeCompleteCampaign: vi.fn().mockResolvedValue(undefined) } as never,
      chatIngest,
      chatEvents,
      {
        get: vi.fn().mockResolvedValue({
          id: 'singleton',
          name: 'CONTINUUM',
          legalName: 'Canal do Matheus Garcia - CONTINUUM',
          privacyPolicyUrl: null,
          supportContact: null,
        }),
      } as never,
      templates,
      { add: vi.fn() } as never,
      consent,
    );
  });

  afterEach(() => {
    // No-op — the service no longer owns the Redis client.
  });

  // ZC — o webhook de aprovação de template. O orgamind JÁ estava inscrito nele no
  // painel do Zernio, mas o parseWebhook o descartava: o sinal chegava e ia para
  // o lixo. É ele que permite manter a reconciliação espaçada (1h) em vez de
  // polling — o balde do Zernio é de 60 req/min e é o MESMO do envio.
  describe('whatsapp.template.status_updated (ZC)', () => {
    function event(status = 'APPROVED') {
      return {
        id: 'evt_1',
        event: 'whatsapp.template.status_updated',
        account: { accountId: 'acc_1' },
        template: {
          templateId: '833669913010819',
          name: 'bem_vindo_mg',
          language: 'pt_BR',
          status,
          reason: 'NONE',
        },
      };
    }

    it('atualiza o status do template no canal do evento', async () => {
      await service.process(event('REJECTED'), 'ch_1', 'ZERNIO');

      expect(templates.applyZernioTemplateStatus).toHaveBeenCalledWith({
        channelId: 'ch_1',
        zernioTemplateId: '833669913010819',
        metaName: 'bem_vindo_mg',
        language: 'pt_BR',
        status: 'REJECTED',
        reason: 'NONE',
      });
    });

    // O evento é do Zernio: um payload parecido chegando por outro provedor não
    // pode mexer no catálogo dele.
    it('ignora o evento em provedor que não é ZERNIO', async () => {
      await service.process(event(), 'ch_1', 'TWILIO');

      expect(templates.applyZernioTemplateStatus).not.toHaveBeenCalled();
    });

    it('ignora eventos que não são de status de template', async () => {
      await service.process(
        { event: 'message.received', account: { accountId: 'acc_1' } },
        'ch_1',
        'ZERNIO',
      );

      expect(templates.applyZernioTemplateStatus).not.toHaveBeenCalled();
    });

    // Best-effort: uma falha no catálogo não pode derrubar o processamento do
    // resto do webhook nem fazer o Zernio retentar 7x um erro nosso.
    it('falha ao aplicar o status não derruba o webhook', async () => {
      templates.applyZernioTemplateStatus.mockRejectedValue(new Error('boom'));

      await expect(
        service.process(event(), 'ch_1', 'ZERNIO'),
      ).resolves.not.toThrow();
    });
  });

  it('verifySignature returns true for a valid HMAC signature', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig =
      'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(service.verifySignature(body, sig)).toBe(true);
  });

  it('verifySignature returns false on tampered body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const tampered = Buffer.from(JSON.stringify({ hello: 'tampered' }));
    const sig =
      'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(service.verifySignature(tampered, sig)).toBe(false);
  });

  it('verifySignature returns false when signature header is missing', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(service.verifySignature(body, undefined)).toBe(false);
  });

  it('verifySignature returns false when signature header lacks sha256= prefix', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const hex = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    // valid HMAC bytes but missing the "sha256=" scheme prefix
    expect(service.verifySignature(body, hex)).toBe(false);
  });

  it('process skips `sent` events older than 5 minutes (suspicious replay)', async () => {
    // `sent` is timestamped at hand-off, so a 10-minute drift is unrealistic
    // and the tight window stays. `delivered`/`read` use a much wider window
    // because they legitimately arrive late when the recipient was offline.
    const stale = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.stale',
        status: 'sent',
        occurredAt: stale,
      },
    ]);
    await service.process({}, undefined, 'EVOLUTION');
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('process accepts `delivered` events arriving hours late (recipient was offline)', async () => {
    const lateButReal = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h ago
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.late-delivery',
        status: 'delivered',
        occurredAt: lateButReal,
      },
    ]);
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-late',
      status: 'SENT',
      contactId: 'c1',
    });
    await service.process({}, undefined, 'EVOLUTION');
    expect(prisma.message.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.message.updateMany).toHaveBeenCalledTimes(1);
  });

  it('process ignores DELIVERED event when message is already READ', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.read',
        status: 'delivered',
        occurredAt: new Date(),
      },
    ]);
    prisma.message.findUnique.mockResolvedValue({
      id: 'm1',
      status: 'READ',
      contactId: 'c1',
    } as any);
    await service.process({}, undefined, 'EVOLUTION');
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('releases the dedup key when the message does not exist yet (ack raced ahead of markSent)', async () => {
    // A `delivered` ack can arrive before the outbound row is persisted by the
    // send pipeline. If we keep the 72h dedup key on that miss, the provider's
    // later redelivery is dropped forever and the message never advances past
    // QUEUED. So on a miss we must release the claim.
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.early-ack',
        status: 'delivered',
        occurredAt: new Date(),
      },
    ]);
    redis.set.mockResolvedValue('OK'); // first time we see this event
    prisma.message.findUnique.mockResolvedValue(null); // row not persisted yet
    await service.process({}, undefined, 'EVOLUTION');
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith('webhook:wamid.early-ack:delivered');
  });

  it('does NOT release the dedup key when the message exists and was updated', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.hit',
        status: 'delivered',
        occurredAt: new Date(),
      },
    ]);
    redis.set.mockResolvedValue('OK');
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-hit',
      status: 'SENT',
      contactId: null,
      conversationId: null,
      instanceId: null,
      campaignId: null,
    });
    await service.process({}, undefined, 'EVOLUTION');
    expect(prisma.message.updateMany).toHaveBeenCalledTimes(1);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('process applies SENT update when message is QUEUED', async () => {
    const now = new Date();
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.queued',
        status: 'sent',
        occurredAt: now,
      },
    ]);
    prisma.message.findUnique.mockResolvedValue({
      id: 'm2',
      status: 'QUEUED',
      contactId: 'c2',
    } as any);
    await service.process({}, undefined, 'EVOLUTION');
    expect(prisma.message.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'm2' }),
        data: expect.objectContaining({ status: 'SENT', sentAt: now }),
      }),
    );
  });

  // ── ZE: inalcançável para MARKETING ───────────────────────────────────────
  // 30% da base (medido) desligou mensagens de marketing no WhatsApp. A falha
  // chega pelo WEBHOOK de status (o POST de envio devolve 200/accepted), então é
  // AQUI que o estado precisa ser gravado — senão toda campanha nova recomeça do
  // zero e queima a mesma cota de tier contra a mesma parede.
  describe('ZE — marca o contato como inalcançável para MARKETING', () => {
    const failedEvent = (errorCode: string) => {
      wa.parseWebhookFor.mockReturnValue([
        {
          providerMessageId: 'wamid.fail',
          status: 'failed',
          occurredAt: new Date(),
          errorCode,
          errorMessage: 'meta said no',
        },
      ]);
      prisma.message.findUnique.mockResolvedValue({
        id: 'm9',
        status: 'SENT',
        contactId: 'c9',
        instanceId: 'i1',
        contact: { id: 'c9', phoneE164: '+5592999999999' },
      });
    };

    it('marca em 130472 (experimento de marketing da Meta)', async () => {
      failedEvent('130472');

      await service.process({}, undefined, 'ZERNIO');

      expect(prisma.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c9' },
          data: expect.objectContaining({
            marketingUndeliverableAt: expect.any(Date),
            marketingUndeliverableCode: '130472',
            marketingUndeliverableReason: expect.stringContaining('UTILITY'),
          }),
        }),
      );
    });

    it('marca em 131026 (destinatário desligou marketing)', async () => {
      failedEvent('131026');

      await service.process({}, undefined, 'ZERNIO');

      expect(prisma.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c9' },
          data: expect.objectContaining({
            marketingUndeliverableCode: '131026',
          }),
        }),
      );
    });

    it('NÃO marca em falha transitória — o contato continua alcançável', async () => {
      // 131048 é anti-spam da Meta, transitório. Marcar aqui excluiria o contato
      // de TODA campanha de marketing para sempre por causa de um soluço.
      failedEvent('131048');

      await service.process({}, undefined, 'ZERNIO');

      // F2 — o contact.update AINDA roda (failureCount incrementa em toda
      // falha), mas SEM os campos marketingUndeliverable* (esta falha não é
      // considerada inalcançável-para-MARKETING).
      expect(prisma.contact.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            marketingUndeliverableCode: expect.anything(),
          }),
        }),
      );
    });

    it('a marcação é best-effort: uma falha nela não derruba o webhook', async () => {
      failedEvent('130472');
      prisma.contact.update.mockRejectedValue(new Error('db down'));

      await expect(
        service.process({}, undefined, 'ZERNIO'),
      ).resolves.not.toThrow();
    });
  });

  // ── CORREÇÃO consent-crítica: 131026/131047 NÃO são opt-out ────────────────
  // Os dois códigos estavam em META_OPT_OUT_CODES e disparavam um REVOKE GLOBAL
  // de consentimento (suprime a pessoa para TUDO, inclusive UTILITY). Doc oficial
  // da Meta (developers.facebook.com/documentation/business-messaging/whatsapp/
  // support/error-codes):
  //   - 131026 "Message Undeliverable": entrega técnica, correlacionada em
  //     massa (medido: 36/37 falhas de um broadcast de 120) com o titular tendo
  //     desligado MARKETING no app — não é uma revogação DIRIGIDA À ORGANIZAÇÃO.
  //     Já é tratado como inalcançável-para-MARKETING (ZE, ver
  //     marketing-reachability.ts) — isto é o suficiente e é escopado (UTILITY
  //     continua entregando).
  //   - 131047 "Re-engagement message": janela de 24h expirada (free-form fora
  //     da janela) — não tem NADA a ver com opt-out.
  // `ConsentEvent` é um registro JURÍDICO do que a pessoa disse À ORGANIZAÇÃO —
  // um toggle de plataforma ou uma janela expirada não são isso.
  describe('CORREÇÃO consent-crítica: 131026/131047 não revogam consentimento', () => {
    const failedEvent = (errorCode: string) => {
      wa.parseWebhookFor.mockReturnValue([
        {
          providerMessageId: 'wamid.fail',
          status: 'failed',
          occurredAt: new Date(),
          errorCode,
          errorMessage: 'meta said no',
        },
      ]);
      prisma.message.findUnique.mockResolvedValue({
        id: 'm9',
        status: 'SENT',
        contactId: 'c9',
        instanceId: 'i1',
        contact: { id: 'c9', phoneE164: '+5592999999999' },
      });
    };

    it('131026: marca inalcançável-para-MARKETING mas NÃO revoga consentimento', async () => {
      failedEvent('131026');

      await service.process({}, undefined, 'ZERNIO');

      // O caminho ZE continua funcionando: bloqueia MARKETING, preserva UTILITY.
      expect(prisma.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'c9' },
          data: expect.objectContaining({
            marketingUndeliverableCode: '131026',
          }),
        }),
      );
      // Mas NENHUM REVOKE de consentimento — nem global, nem de nenhuma outra
      // forma. Um toggle de plataforma não é uma declaração à organização.
      expect(consent.record).not.toHaveBeenCalled();
    });

    it('131047: NÃO revoga consentimento (erro de janela de 24h, não opt-out)', async () => {
      failedEvent('131047');

      await service.process({}, undefined, 'ZERNIO');

      expect(consent.record).not.toHaveBeenCalled();
      // 131047 também não é undeliverable de marketing — é sobre precisar de
      // template, não sobre a preferência do destinatário. F2: o contact.update
      // genérico ainda roda (failureCount), mas sem os campos de marketing.
      expect(prisma.contact.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            marketingUndeliverableCode: expect.anything(),
          }),
        }),
      );
    });

    it('opt-out de verdade (Twilio 21610) continua revogando — regressão', async () => {
      failedEvent('21610');

      await service.process({}, undefined, 'TWILIO');

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c9',
          phoneE164: '+5592999999999',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.PROVIDER_OPTOUT,
          suppressionReason: 'provider_optout_code',
        }),
      );
    });

    it('opt-out de verdade (Meta 131050 — "recipient stopped receiving marketing messages") continua revogando — regressão', async () => {
      failedEvent('131050');

      await service.process({}, undefined, 'ZERNIO');

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c9',
          phoneE164: '+5592999999999',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.PROVIDER_OPTOUT,
          suppressionReason: 'provider_optout_code',
        }),
      );
    });
  });

  // F2 — motivo normalizado (failureReason) gravado na Message + flag durável
  // best-effort no Contact, no MESMO ack de status 'failed' que já grava
  // errorCode/errorMessage.
  describe('F2 — failureReason + flag durável do Contact em status failed', () => {
    const failedEvent = (errorCode: string) => {
      wa.parseWebhookFor.mockReturnValue([
        {
          providerMessageId: 'wamid.fail',
          status: 'failed',
          occurredAt: new Date(),
          errorCode,
          errorMessage: 'meta said no',
        },
      ]);
      prisma.message.findUnique.mockResolvedValue({
        id: 'm9',
        status: 'SENT',
        contactId: 'c9',
        instanceId: 'i1',
        contact: { id: 'c9', phoneE164: '+5592999999999' },
      });
    };

    it('grava failureReason classificado no update da Message', async () => {
      failedEvent('131047'); // FORA_DA_JANELA

      await service.process({}, undefined, 'ZERNIO');

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: '131047',
            failureReason: 'FORA_DA_JANELA',
          }),
        }),
      );
    });

    it('atualiza a flag durável do Contact (failureCount) numa falha não permanente', async () => {
      failedEvent('131047');

      await service.process({}, undefined, 'ZERNIO');

      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'c9' },
        data: { failureCount: { increment: 1 } },
      });
    });

    it('grava lastFailureReason/Code/At numa falha PERMANENTE do destinatário', async () => {
      failedEvent('recipient_opted_out');

      await service.process({}, undefined, 'ZERNIO');

      expect(prisma.contact.update).toHaveBeenCalledWith({
        where: { id: 'c9' },
        data: {
          failureCount: { increment: 1 },
          lastFailureReason: 'OPT_OUT',
          lastFailureCode: 'recipient_opted_out',
          lastFailureAt: expect.any(Date),
        },
      });
    });

    it('best-effort: uma falha no contact.update não derruba o webhook', async () => {
      failedEvent('131047');
      prisma.contact.update.mockRejectedValue(new Error('db down'));

      await expect(
        service.process({}, undefined, 'ZERNIO'),
      ).resolves.not.toThrow();
    });

    it('NÃO atualiza o Contact quando a Message não tem contactId', async () => {
      wa.parseWebhookFor.mockReturnValue([
        {
          providerMessageId: 'wamid.fail2',
          status: 'failed',
          occurredAt: new Date(),
          errorCode: '131047',
          errorMessage: 'meta said no',
        },
      ]);
      prisma.message.findUnique.mockResolvedValue({
        id: 'm10',
        status: 'SENT',
        contactId: null,
        instanceId: 'i1',
        contact: null,
      });

      await service.process({}, undefined, 'ZERNIO');

      expect(prisma.contact.update).not.toHaveBeenCalled();
    });
  });

  it('process marks contact opted out on STOP keyword inbound message', async () => {
    const receivedAt = new Date();
    wa.parseInboundMessages.mockReturnValue([
      {
        fromE164: '+5592987654321',
        text: 'STOP',
        receivedAt,
        providerMessageId: 'wamid.inbound1',
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c-stop', phoneE164: '+5592987654321', optedOut: false },
    ] as any);
    await service.process({});
    // O opt-out passa pelo ConsentService: REVOKE GLOBAL (revoga todas as
    // finalidades) + SuppressionList DURÁVEL. Um `optedOut = true` na linha de
    // Contact evaporaria na próxima reimportação da planilha.
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c-stop',
        phoneE164: '+5592987654321',
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
        source: ConsentSource.WA_KEYWORD,
        evidenceText: 'STOP',
        suppressionReason: 'keyword_parar',
        occurredAt: receivedAt,
      }),
    );
    // Ninguém escreve o cache na mão.
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      'contact.stop_keyword_opt_out',
      'Contact',
      'c-stop',
      expect.objectContaining({
        text: 'STOP',
        providerMessageId: 'wamid.inbound1',
      }),
    );
  });

  it('process ignores inbound message that does not match STOP regex', async () => {
    wa.parseInboundMessages.mockReturnValue([
      {
        fromE164: '+5592987654321',
        text: 'oi tudo bem?',
        receivedAt: new Date(),
        providerMessageId: 'wamid.inbound2',
      },
    ]);
    await service.process({});
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it('process skips already-opted-out contact on STOP keyword', async () => {
    wa.parseInboundMessages.mockReturnValue([
      {
        fromE164: '+5592987654321',
        text: 'sair',
        receivedAt: new Date(),
        providerMessageId: 'wamid.inbound3',
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 'c-already', phoneE164: '+5592987654321', optedOut: true },
    ] as any);
    // Já suprimido — a fonte da verdade é a SuppressionList, não o cache.
    consent.isSuppressed.mockResolvedValue(true);
    await service.process({});
    expect(consent.record).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('forwards the payload to ChatIngestService with the instanceId', async () => {
    wa.parseInboundMessages.mockReturnValue([]);
    const payload = { event: 'messages.upsert', data: {} };
    await service.process(payload, 'inst-1');
    expect(chatIngest.ingestFromWebhook).toHaveBeenCalledWith(
      payload,
      'inst-1',
    );
  });

  // --- T5: provider-routed status parsing (multi-channel webhooks) ---
  it('process(payload, instanceId, provider) routes status-ack parsing through parseWebhookFor for that provider', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.viaFor',
        status: 'sent',
        occurredAt: new Date(),
      },
    ]);
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-via-for',
      status: 'QUEUED',
      contactId: null,
    });
    const payload = { event: 'messages.update' };

    await service.process(payload, 'inst-1', 'EVOLUTION');

    expect(wa.parseWebhookFor).toHaveBeenCalledWith('EVOLUTION', payload);
    expect(prisma.message.updateMany).toHaveBeenCalledTimes(1);
  });

  it('process(payload, instanceId, "TWILIO") routes status-ack parsing through parseWebhookFor("TWILIO", ...)', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'SMtwilio1',
        status: 'delivered',
        occurredAt: new Date(),
      },
    ]);
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-twilio',
      status: 'SENT',
      contactId: null,
      conversationId: null,
      instanceId: null,
      campaignId: null,
    });
    const payload = { MessageStatus: 'delivered', MessageSid: 'SMtwilio1' };

    await service.process(payload, 'chan-1', 'TWILIO');

    expect(wa.parseWebhookFor).toHaveBeenCalledWith('TWILIO', payload);
  });

  // F6: the legacy no-provider fallback (deploy-global `parseWebhook`) was
  // removed — both webhook controllers always resolve a provider before
  // calling `process()`, so this branch was dead in production.
  it('process without a provider does NOT process status-acks (the legacy env-selected fallback was removed)', async () => {
    const payload = { event: 'messages.update' };

    await service.process(payload);

    expect(wa.parseWebhookFor).not.toHaveBeenCalled();
    expect(prisma.message.findUnique).not.toHaveBeenCalled();
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  // --- T5b: STOP opt-out + chat-ingest must route through the provider-aware
  // adapter too, not just status-ack parsing (T5 only wired processStatusUpdates).
  it('process(payload, instanceId, "TWILIO") routes STOP-keyword opt-out through parseInboundMessagesFor, not the legacy parseInboundMessages', async () => {
    wa.parseWebhookFor.mockReturnValue([]);
    wa.parseInboundMessagesFor.mockReturnValue([
      {
        fromE164: '+5592987654321',
        text: 'STOP',
        receivedAt: new Date(),
        providerMessageId: 'SMstop1',
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([{
      id: 'c-stop-tw',
      phoneE164: '+5592987654321',
      optedOut: false,
    }]);
    const payload = {
      Body: 'STOP',
      From: 'whatsapp:+5592987654321',
      MessageSid: 'SMstop1',
    };

    await service.process(payload, 'chan-1', 'TWILIO');

    expect(wa.parseInboundMessagesFor).toHaveBeenCalledWith('TWILIO', payload);
    expect(wa.parseInboundMessages).not.toHaveBeenCalled();
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c-stop-tw',
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
      }),
    );
  });

  it('process(payload, instanceId, "TWILIO") forwards the provider to chatIngest.ingestFromWebhook', async () => {
    wa.parseWebhookFor.mockReturnValue([]);
    const payload = {
      Body: 'oi',
      From: 'whatsapp:+5592987654321',
      MessageSid: 'SMchat1',
    };

    await service.process(payload, 'chan-1', 'TWILIO');

    expect(chatIngest.ingestFromWebhook).toHaveBeenCalledWith(
      payload,
      'chan-1',
      'TWILIO',
    );
  });

  it('process(payload, undefined, "TWILIO") still processes status-acks (matched by providerMessageId) and forwards instanceId=undefined to chatIngest (a no-op there)', async () => {
    // Simulates the TwilioWebhooksController's unresolved-channel path: `To`
    // didn't match any channel row, but the status callback (e.g. `failed`,
    // which drives opt-out) must still be processed by providerMessageId.
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'SMnoinst',
        status: 'delivered',
        occurredAt: new Date(),
      },
    ]);
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-noinst',
      status: 'SENT',
      contactId: null,
      conversationId: null,
      instanceId: null,
      campaignId: null,
    });
    const payload = { MessageStatus: 'delivered', MessageSid: 'SMnoinst' };

    await service.process(payload, undefined, 'TWILIO');

    expect(wa.parseWebhookFor).toHaveBeenCalledWith('TWILIO', payload);
    expect(prisma.message.updateMany).toHaveBeenCalledTimes(1);
    expect(chatIngest.ingestFromWebhook).toHaveBeenCalledWith(
      payload,
      undefined,
      'TWILIO',
    );
  });

  it('does not overwrite a terminal FAILED status with a lower-rank status (delivered)', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.failed',
        status: 'delivered',
        occurredAt: new Date(),
      },
    ]);
    // Redis NX set succeeds (first time we see this event)
    redis.set.mockResolvedValue('OK');
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-failed',
      status: 'FAILED',
      contactId: null,
      conversationId: null,
      instanceId: null,
      campaignId: null,
    });
    await service.process({}, undefined, 'EVOLUTION');
    // shouldUpdate(FAILED, DELIVERED) → false because FAILED has rank 99
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('does not update when parseWebhookFor returns an event with an unknown/invalid status', async () => {
    // Simulate a webhook event whose normalised status is not in MessageStatus enum.
    // parseWebhookFor returns an event with a status that passes typing but is not
    // in VALID_MESSAGE_STATUS after .toUpperCase() — e.g. 'unknown_xyz'.
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.bogus',
        status: 'unknown_xyz' as never,
        occurredAt: new Date(),
      },
    ]);
    redis.set.mockResolvedValue('OK');
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-bogus',
      status: 'SENT',
      contactId: null,
      conversationId: null,
      instanceId: null,
      campaignId: null,
    });
    await service.process({}, undefined, 'EVOLUTION');
    // VALID_MESSAGE_STATUS check rejects 'UNKNOWN_XYZ' → no update
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('publishes a chat message.status event when an updated message has a conversation', async () => {
    wa.parseWebhookFor.mockReturnValue([
      { providerMessageId: 'WA1', status: 'delivered', occurredAt: new Date() },
    ]);
    (prisma.message.findUnique as any).mockResolvedValue({
      id: 'm1',
      status: 'SENT',
      campaignId: null,
      contactId: null,
      conversationId: 'c1',
      instanceId: 'i1',
    });
    redis.set.mockResolvedValue('OK');
    await service.process(
      { event: 'messages.update', data: {} },
      'i1',
      'EVOLUTION',
    );
    expect(chatEvents.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.status',
        conversationId: 'c1',
        messageId: 'm1',
        status: 'DELIVERED',
      }),
    );
  });

  // --- STOP-keyword opt-out: whole-message match (bug: prefix match opted out engaged contacts) ---
  it('does NOT opt out a contact whose message merely STARTS with a stop word', async () => {
    wa.parseInboundMessages.mockReturnValue([
      {
        fromE164: '+5592987654321',
        text: 'Não consigo comparecer, pode remarcar minha consulta?',
        receivedAt: new Date(),
        providerMessageId: 'wamid.engaged',
      },
    ]);
    // Even if the contact exists, an engaged reply that only begins with "Não"
    // must not be treated as an unsubscribe.
    prisma.contact.findMany.mockResolvedValue([{
      id: 'c-engaged',
      phoneE164: '+5592987654321',
      optedOut: false,
    }]);
    await service.process({});
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('still opts out on an exact "PARAR" reply (surrounded by whitespace)', async () => {
    wa.parseInboundMessages.mockReturnValue([
      {
        fromE164: '+5592987654321',
        text: '  PARAR  ',
        receivedAt: new Date(),
        providerMessageId: 'wamid.parar',
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([{
      id: 'c-parar',
      phoneE164: '+5592987654321',
      optedOut: false,
    }]);
    await service.process({});
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c-parar',
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
      }),
    );
  });

  // --- STOP-keyword opt-out: Brazilian 9th-digit phone variants ---
  it('opts out a contact stored with the 9th-digit form when the JID arrives in the legacy 8-digit form', async () => {
    wa.parseInboundMessages.mockReturnValue([
      {
        fromE164: '+559295550101', // legacy 8-digit JID echoed by Evolution
        text: 'PARAR',
        receivedAt: new Date(),
        providerMessageId: 'wamid.variant',
      },
    ]);
    // Contact is saved canonically with the extra 9 — an exact findUnique misses it.
    prisma.contact.findMany.mockResolvedValue([{
      id: 'c-variant',
      phoneE164: '+5592995550101',
      optedOut: false,
    }]);
    await service.process({});
    expect(prisma.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          phoneE164: {
            in: expect.arrayContaining(['+559295550101', '+5592995550101']),
          },
        },
      }),
    );
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c-variant',
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
      }),
    );
  });

  /**
   * I13 — O DESEMPATE ENTRE GÊMEOS TEM DE SER O MESMO EM TODO LUGAR.
   *
   * Enquanto as duas grafias do 9º dígito coexistirem como duas linhas, um
   * `findFirst` sem `orderBy` devolve a que o ÍNDICE entregar primeiro — a
   * legada de 12 dígitos. A audiência da campanha, a planilha e a tela de
   * contatos operam na de 13 (`findByAnyBrForm`). Uma REVOGAÇÃO gravada no
   * gêmeo errado é um registro jurídico no lugar errado: o cache
   * `ContactConsent`, que é o que o gate lê, fica pendurado numa linha que o
   * disparo não consulta.
   */
  it('PARAR com os DOIS gêmeos na base revoga no contato de 13 dígitos (o mesmo que a audiência enxerga)', async () => {
    wa.parseInboundMessages.mockReturnValue([
      {
        fromE164: '+559287654321', // o WhatsApp reporta a grafia legada
        text: 'PARAR',
        receivedAt: new Date(),
        providerMessageId: 'wamid.gemeos',
      },
    ]);
    // Ordem de índice do Postgres: a de 12 dígitos vem primeiro.
    const gemeos = [
      { id: 'c-12', phoneE164: '+559287654321', optedOut: false },
      { id: 'c-13', phoneE164: '+5592987654321', optedOut: false },
    ];
    // O `findFirst` velho fica ARMADO com o gêmeo errado de propósito: se o
    // opt-out voltar a passar por ele, este teste fica vermelho de novo.
    prisma.contact.findFirst.mockResolvedValue(gemeos[0]);
    prisma.contact.findMany.mockResolvedValue(gemeos as never);

    await service.process({});

    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c-13',
        phoneE164: '+5592987654321',
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
      }),
    );
  });

  // --- T8: opt-out PT (PARE) + botão optout + confirmação TWILIO + VOLTAR ---
  describe('opt-out T8 (keywords PT + botão + VOLTAR)', () => {
    const twilioChannel = {
      id: 'chan-tw',
      provider: 'TWILIO',
      phoneE164: '+5592111111111',
      twilioMessagingServiceSid: null,
      zernioAccountId: null,
      isActive: true,
    };

    it('opta por sair com a keyword PARE (palavra única, case-insensitive)', async () => {
      wa.parseInboundMessages.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: 'Pare',
          receivedAt: new Date(),
          providerMessageId: 'wamid.pare',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-pare',
        phoneE164: '+5592987654321',
        optedOut: false,
      }]);
      await service.process({});
      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c-pare',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.WA_KEYWORD,
        }),
      );
    });

    it("opta por sair quando o inbound traz buttonPayload 'optout' (mesmo sem keyword no texto)", async () => {
      wa.parseWebhookFor.mockReturnValue([]);
      wa.parseInboundMessagesFor.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: 'Parar de receber',
          receivedAt: new Date(),
          providerMessageId: 'SMbtnopt',
          buttonPayload: 'optout',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-btn',
        phoneE164: '+5592987654321',
        optedOut: false,
      }]);
      prisma.channel.findUnique.mockResolvedValue(twilioChannel);
      await service.process({}, 'chan-tw', 'TWILIO');
      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c-btn',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.WA_BUTTON,
          suppressionReason: 'button_optout',
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'contact.stop_keyword_opt_out',
        'Contact',
        'c-btn',
        expect.objectContaining({ trigger: 'button' }),
      );
    });

    it('canal TWILIO: responde confirmação free-form best-effort após o opt-out (janela 24h aberta)', async () => {
      wa.parseWebhookFor.mockReturnValue([]);
      wa.parseInboundMessagesFor.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: 'PARAR',
          receivedAt: new Date(),
          providerMessageId: 'SMconf',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-conf',
        phoneE164: '+5592987654321',
        optedOut: false,
      }]);
      prisma.channel.findUnique.mockResolvedValue(twilioChannel);
      await service.process({}, 'chan-tw', 'TWILIO');
      // O texto NOMEIA a organização CONFIGURADA: ele vira o evidenceText do GRANT que o VOLTAR
      // grava — é literalmente o que o titular leu antes de decidir voltar.
      expect(wa.sendChatTextVia).toHaveBeenCalledWith(
        twilioChannel,
        expect.objectContaining({
          toE164: '+5592987654321',
          text: expect.stringContaining('CONTINUUM'),
        }),
      );
      expect(wa.sendChatTextVia).toHaveBeenCalledWith(
        twilioChannel,
        expect.objectContaining({ text: expect.stringContaining('VOLTAR') }),
      );
    });

    it('falha no envio da confirmação NÃO derruba o processamento (best-effort)', async () => {
      wa.parseWebhookFor.mockReturnValue([]);
      wa.parseInboundMessagesFor.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: 'PARAR',
          receivedAt: new Date(),
          providerMessageId: 'SMconffail',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-conf-fail',
        phoneE164: '+5592987654321',
        optedOut: false,
      }]);
      prisma.channel.findUnique.mockResolvedValue(twilioChannel);
      wa.sendChatTextVia.mockRejectedValue(new Error('twilio down'));
      await expect(
        service.process({}, 'chan-tw', 'TWILIO'),
      ).resolves.not.toThrow();
      // A revogação já foi persistida ANTES da confirmação — o opt-out não pode
      // depender de a Twilio estar de pé.
      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c-conf-fail',
          action: ConsentAction.REVOKE,
        }),
      );
    });

    it('NÃO envia confirmação para canal não-TWILIO (Evolution segue intacto)', async () => {
      wa.parseWebhookFor.mockReturnValue([]);
      wa.parseInboundMessagesFor.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: 'PARAR',
          receivedAt: new Date(),
          providerMessageId: 'wamid.evo-stop',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-evo',
        phoneE164: '+5592987654321',
        optedOut: false,
      }]);
      prisma.channel.findUnique.mockResolvedValue({
        ...twilioChannel,
        id: 'chan-evo',
        provider: 'EVOLUTION',
      });
      await service.process({}, 'chan-evo', 'EVOLUTION');
      expect(wa.sendChatTextVia).not.toHaveBeenCalled();
    });

    it('keyword VOLTAR restaura os GRANTs anteriores ao PARAR — não um opt-in genérico', async () => {
      wa.parseInboundMessages.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: ' voltar ',
          receivedAt: new Date(),
          providerMessageId: 'wamid.voltar',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-voltar',
        phoneE164: '+5592987654321',
        optedOut: true,
      }]);
      consent.isSuppressed.mockResolvedValue(true);
      consent.reinstate.mockResolvedValue(['convite_atividades']);

      await service.process({});

      // Antes: optInAt = now() + source 'keyword_voltar' — uma autorização
      // genérica, sem finalidade e sem texto, exatamente o que o art. 8º §4º
      // anula. Agora: levanta a supressão e restaura APENAS o que estava ativo.
      expect(consent.reinstate).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c-voltar',
          phoneE164: '+5592987654321',
          source: ConsentSource.WA_KEYWORD,
          // O texto que a pessoa LEU antes de decidir voltar.
          evidenceText: expect.stringContaining('CONTINUUM'),
        }),
      );
      expect(prisma.contact.update).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        'contact.keyword_opt_in',
        'Contact',
        'c-voltar',
        expect.objectContaining({
          providerMessageId: 'wamid.voltar',
          restoredPurposes: ['convite_atividades'],
        }),
      );
    });

    it('VOLTAR de contato que NÃO está em opt-out não mexe em nada (opt-in já é capturado pelo ingest)', async () => {
      wa.parseInboundMessages.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: 'VOLTAR',
          receivedAt: new Date(),
          providerMessageId: 'wamid.voltar-noop',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-voltar-noop',
        phoneE164: '+5592987654321',
        optedOut: false,
      }]);
      consent.isSuppressed.mockResolvedValue(false);
      await service.process({});
      expect(consent.reinstate).not.toHaveBeenCalled();
      expect(consent.record).not.toHaveBeenCalled();
    });
  });

  // --- LGPD bug: PARAR de número DESCONHECIDO não pode ser silenciosamente
  // descartado. Antes deste teste, `processStopKeywords` fazia `if (!contact)
  // continue` ANTES do chat-ingest criar o Contact — um número que o orgamind
  // nunca viu, mandando PARAR como primeira mensagem, tinha o opt-out
  // simplesmente jogado fora: nenhuma supressão gravada. `ConsentService.record`
  // aceita `contactId: null` e grava a SuppressionList por `phoneHash` —
  // durável e independente de existir Contact.
  describe('opt-out de número DESCONHECIDO (sem Contact) — bug LGPD', () => {
    it('opta por sair na keyword PARAR mesmo sem Contact — grava REVOKE global com contactId null', async () => {
      wa.parseInboundMessages.mockReturnValue([
        {
          fromE164: '+5592900009999',
          text: 'PARAR',
          receivedAt: new Date('2026-07-10T12:00:00Z'),
          providerMessageId: 'wamid.unknown-parar',
        },
      ]);
      // Número nunca visto — nenhum Contact casa.
      prisma.contact.findMany.mockResolvedValue([]);

      await expect(service.process({})).resolves.not.toThrow();

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: null,
          phoneE164: '+5592900009999',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.WA_KEYWORD,
          evidenceText: 'PARAR',
          suppressionReason: 'keyword_parar',
          occurredAt: new Date('2026-07-10T12:00:00Z'),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'contact.stop_keyword_opt_out',
        'Contact',
        undefined,
        expect.objectContaining({
          text: 'PARAR',
          providerMessageId: 'wamid.unknown-parar',
          trigger: 'keyword',
        }),
      );
    });

    // ─── ZERNIO: opt-out por botão, ponta a ponta ────────────────────────────
    // Estes dois testes NÃO mockam o parse: passam o payload REAL da Zernio pelo
    // ZernioCloudAdapter de verdade e ligam a saída dele na service. É a única
    // forma de provar a cadeia inteira — o bug era justamente o adapter jogar
    // `metadata` fora, e um teste que mockasse o parse continuaria verde com o
    // bug em produção.
    describe('opt-out por botão vindo de um payload REAL da Zernio', () => {
      const zernioChannel = {
        id: 'chan-zn',
        provider: 'ZERNIO',
        phoneE164: null,
        twilioMessagingServiceSid: null,
        zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
        isActive: true,
      };

      // `metadata` é irmão de `message` no envelope (top-level), e o botão de
      // TEMPLATE chega em `metadata.buttonPayload` com `interactiveType` VAZIO.
      const zernioTap = (metadata: Record<string, unknown>, text?: string) => ({
        id: 'evt-zn',
        event: 'message.received',
        message: {
          id: 'a1b2c3d4e5f6a7b8c9d00002',
          platformMessageId: 'wamid.HBgLMTY0NjU4OTQxNjgV==',
          text,
        },
        conversation: { id: 'conv-zn', participantId: '5592987654321' },
        account: { id: 'a1b2c3d4e5f6a7b8c9d0e1f2', platform: 'whatsapp' },
        metadata,
        timestamp: '2026-07-11T10:00:00Z',
      });

      const zernio = new ZernioCloudAdapter({
        get: () => undefined,
      } as unknown as ConfigService);

      beforeEach(() => {
        wa.parseWebhookFor.mockReturnValue([]);
        prisma.channel.findUnique.mockResolvedValue(zernioChannel);
        prisma.contact.findMany.mockResolvedValue([{
          id: 'c-zn',
          phoneE164: '+5592987654321',
          optedOut: false,
        }]);
      });

      it('SUPRIME quem toca no botão de opt-out do template de MARKETING', async () => {
        const payload = zernioTap(
          { buttonPayload: 'Parar promoções', interactiveType: '' },
          'Parar promoções',
        );
        // O adapter REAL faz o parse — nada de payload inventado à mão.
        wa.parseInboundMessagesFor.mockReturnValue(
          zernio.parseInboundMessages(payload),
        );

        await service.process(payload, 'chan-zn', 'ZERNIO');

        expect(consent.record).toHaveBeenCalledWith(
          expect.objectContaining({
            contactId: 'c-zn',
            purposeKey: GLOBAL_PURPOSE,
            action: ConsentAction.REVOKE,
            source: ConsentSource.WA_BUTTON,
            suppressionReason: 'button_optout',
          }),
        );
      });

      it('NÃO suprime quem toca em outro botão qualquer', async () => {
        const payload = zernioTap(
          { interactiveType: 'button_reply', interactiveId: 'optin_yes' },
          'Quero sim!',
        );
        wa.parseInboundMessagesFor.mockReturnValue(
          zernio.parseInboundMessages(payload),
        );

        await service.process(payload, 'chan-zn', 'ZERNIO');

        expect(consent.record).not.toHaveBeenCalled();
      });
    });

    it("opta por sair no buttonPayload 'optout' mesmo sem Contact (canal TWILIO)", async () => {
      const twilioChannel = {
        id: 'chan-tw-unknown',
        provider: 'TWILIO',
        phoneE164: '+5592111111111',
        twilioMessagingServiceSid: null,
        zernioAccountId: null,
        isActive: true,
      };
      wa.parseWebhookFor.mockReturnValue([]);
      wa.parseInboundMessagesFor.mockReturnValue([
        {
          fromE164: '+5592900009999',
          text: 'Parar de receber',
          receivedAt: new Date(),
          providerMessageId: 'SMbtnopt-unknown',
          buttonPayload: 'optout',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([]);
      prisma.channel.findUnique.mockResolvedValue(twilioChannel);

      await expect(
        service.process({}, 'chan-tw-unknown', 'TWILIO'),
      ).resolves.not.toThrow();

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: null,
          phoneE164: '+5592900009999',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.WA_BUTTON,
          suppressionReason: 'button_optout',
        }),
      );
    });

    it('número desconhecido que JÁ está suprimido não repete o REVOKE (idempotência antes de bater no Contact)', async () => {
      wa.parseInboundMessages.mockReturnValue([
        {
          fromE164: '+5592900009999',
          text: 'PARAR',
          receivedAt: new Date(),
          providerMessageId: 'wamid.unknown-again',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([]);
      // A fonte da verdade é a SuppressionList (por phoneHash), consultável
      // mesmo sem Contact.
      consent.isSuppressed.mockResolvedValue(true);

      await service.process({});

      expect(consent.record).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('opt-out de contato CONHECIDO continua funcionando (regressão)', async () => {
      wa.parseInboundMessages.mockReturnValue([
        {
          fromE164: '+5592987654321',
          text: 'PARAR',
          receivedAt: new Date(),
          providerMessageId: 'wamid.known-parar',
        },
      ]);
      prisma.contact.findMany.mockResolvedValue([{
        id: 'c-known',
        phoneE164: '+5592987654321',
        optedOut: false,
      }]);

      await service.process({});

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'c-known',
          phoneE164: '+5592987654321',
          purposeKey: GLOBAL_PURPOSE,
          action: ConsentAction.REVOKE,
          source: ConsentSource.WA_KEYWORD,
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'contact.stop_keyword_opt_out',
        'Contact',
        'c-known',
        expect.objectContaining({ text: 'PARAR' }),
      );
    });
  });

  // --- Status dedup: release the key when the durable write fails, so the provider can redeliver ---
  it('releases the dedup key and rethrows when the status write throws (transient failure)', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.boom',
        status: 'failed',
        occurredAt: new Date(),
        errorCode: '131026',
      },
    ]);
    redis.set.mockResolvedValue('OK'); // first time we claim this event
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-boom',
      status: 'SENT',
      contactId: 'c-boom',
      conversationId: null,
      instanceId: null,
      campaignId: null,
    });
    prisma.message.updateMany.mockRejectedValue(new Error('pool exhausted'));
    await expect(service.process({}, undefined, 'EVOLUTION')).rejects.toThrow(
      'pool exhausted',
    );
    // Key released so Evolution's redelivery can re-process (LGPD auto-opt-out
    // must not be silently dropped).
    expect(redis.del).toHaveBeenCalledWith('webhook:wamid.boom:failed');
  });

  // --- Auto opt-out also fires for Twilio opt-out codes (not just Meta) ---
  it('auto-opts-out the contact on a Twilio opt-out failure code (63020)', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'SMoptout',
        status: 'failed',
        occurredAt: new Date(),
        errorCode: '63020',
      },
    ]);
    redis.set.mockResolvedValue('OK');
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-optout',
      status: 'SENT',
      contactId: 'c-optout',
      contact: { phoneE164: '+5592987654321' },
      conversationId: null,
      instanceId: 'chan-tw',
      campaignId: null,
    });
    prisma.message.updateMany.mockResolvedValue({ count: 1 });

    await service.process({}, undefined, 'TWILIO');

    // O titular parou DENTRO do WhatsApp e quem nos contou foi a Twilio: é um
    // REVOKE global como qualquer outro, e vira supressão DURÁVEL (não um
    // boolean que a próxima reimportação de planilha apagaria).
    expect(consent.record).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'c-optout',
        phoneE164: '+5592987654321',
        purposeKey: GLOBAL_PURPOSE,
        action: ConsentAction.REVOKE,
        source: ConsentSource.PROVIDER_OPTOUT,
        suppressionReason: 'provider_optout_code',
      }),
    );
  });

  // --- Status update: atomic rank-guarded WHERE so a lower ack can't clobber a higher one ---
  it('scopes the status update with a rank-guarded WHERE (a lower ack cannot overwrite a higher committed status)', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.rank',
        status: 'sent',
        occurredAt: new Date(),
      },
    ]);
    redis.set.mockResolvedValue('OK');
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-rank',
      status: 'QUEUED',
      contactId: null,
      conversationId: null,
      instanceId: null,
      campaignId: null,
    });
    await service.process({}, undefined, 'EVOLUTION');
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'm-rank',
          status: {
            notIn: expect.arrayContaining([
              'SENT',
              'DELIVERED',
              'READ',
              'RECEIVED',
              'FAILED',
              'CANCELLED',
            ]),
          },
        }),
      }),
    );
  });

  it('does not fire side effects when the atomic guard updates 0 rows (lost the race)', async () => {
    wa.parseWebhookFor.mockReturnValue([
      {
        providerMessageId: 'wamid.lost',
        status: 'delivered',
        occurredAt: new Date(),
      },
    ]);
    redis.set.mockResolvedValue('OK');
    prisma.message.findUnique.mockResolvedValue({
      id: 'm-lost',
      status: 'SENT',
      contactId: null,
      conversationId: 'conv1',
      instanceId: 'i1',
      campaignId: 'camp1',
    });
    prisma.message.updateMany.mockResolvedValue({ count: 0 });
    await service.process({}, undefined, 'EVOLUTION');
    expect(chatEvents.publish).not.toHaveBeenCalled();
  });
  describe('ZW — status de broadcast pelo webhook (casamento por telefone)', () => {
    const WAMID =
      'wamid.HBgMNTU5Mjg2MTU0Njc3FQIAERgSQ0FFQTRFQjc1QkJGOTBFRjREAA==';

    /** O evento normalizado que o adapter do Zernio produz para um broadcast. */
    function broadcastEvent(
      status: 'sent' | 'delivered' | 'read' | 'failed',
      overrides: Record<string, unknown> = {},
    ) {
      return {
        providerMessageId: WAMID,
        status,
        occurredAt: new Date(),
        // O telefone vem de `conversation.participantId` (sem '+'), e o adapter
        // o normaliza para E.164.
        recipientPhone: '+5592986550101',
        ...overrides,
      };
    }

    /** Uma Message de broadcast: SENT no disparo, mas SEM wamid. */
    const broadcastMessage = {
      id: 'm-bc',
      status: 'SENT',
      contactId: 'c-bc',
      instanceId: 'ch_zernio',
      campaignId: 'camp-1',
      zernioBroadcastId: 'zb-1',
      providerMessageId: null,
      conversationId: null,
      contact: { phoneE164: '+5592986550101' },
    };

    // (a) O evento que hoje se perde: o wamid é DESCONHECIDO (o /send nunca o
    //     devolveu). Tem de casar por telefone e CARIMBAR o wamid na linha.
    it('(a) message.sent de broadcast sem wamid conhecido: casa por telefone e CARIMBA o providerMessageId', async () => {
      // Ninguém tem este wamid — é a primeira vez que ele aparece no sistema.
      prisma.message.findUnique.mockResolvedValue(null);
      // O candidato: a Message do broadcast, casada pelo telefone.
      prisma.message.findMany.mockResolvedValue([broadcastMessage]);
      wa.parseWebhookFor.mockReturnValue([broadcastEvent('sent')]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      // O CARIMBO: a linha ganha o wamid que o /send nunca deu.
      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'm-bc',
            // Guarda da corrida: só carimba quem ainda não tem wamid.
            providerMessageId: null,
          }),
          data: expect.objectContaining({ providerMessageId: WAMID }),
        }),
      );
    });

    // (b) Carimbado o wamid, o `delivered` seguinte casa pelo caminho que JÁ
    //     existe (findUnique por providerMessageId) — sem tocar no fallback.
    it('(b) delivered seguinte casa pelo WAMID (sem fallback por telefone) e avança SENT → DELIVERED', async () => {
      const now = new Date();
      // Agora a linha JÁ tem o wamid (foi carimbada pelo `sent`).
      prisma.message.findUnique.mockResolvedValue({
        ...broadcastMessage,
        providerMessageId: WAMID,
      });
      wa.parseWebhookFor.mockReturnValue([
        broadcastEvent('delivered', { occurredAt: now }),
      ]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      // O fallback por telefone NÃO foi usado: o wamid bastou.
      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'm-bc' }),
          data: expect.objectContaining({
            status: 'DELIVERED',
            deliveredAt: now,
          }),
        }),
      );
    });

    // (c) MONOTONICIDADE. O broadcast do Zernio é lento e os eventos chegam fora
    //     de ordem; um `sent` atrasado NÃO pode rebaixar quem já está READ.
    it('(c) um `sent` atrasado NÃO rebaixa uma mensagem já READ', async () => {
      prisma.message.findUnique.mockResolvedValue({
        ...broadcastMessage,
        providerMessageId: WAMID,
        status: 'READ',
      });
      wa.parseWebhookFor.mockReturnValue([broadcastEvent('sent')]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      // Nenhuma escrita de status: READ (rank 3) > SENT (rank 1).
      expect(prisma.message.updateMany).not.toHaveBeenCalled();
    });

    // (c2) O `sent` chega para uma linha que o orgamind JÁ marcou SENT no disparo
    //      (é o caso NORMAL do broadcast: o orgamind marca SENT ao despachar). O
    //      status não muda — mas o CARIMBO do wamid tem de acontecer mesmo
    //      assim, senão o `delivered`/`read` seguintes nunca casariam.
    it('(c2) `sent` numa linha já SENT: não mexe no status, mas CARIMBA o wamid', async () => {
      prisma.message.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([broadcastMessage]);
      wa.parseWebhookFor.mockReturnValue([broadcastEvent('sent')]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      const calls = prisma.message.updateMany.mock.calls;
      const stamps = calls.filter(
        (c) =>
          (c[0] as { data?: Record<string, unknown> })?.data
            ?.providerMessageId === WAMID,
      );
      const statusWrites = calls.filter(
        (c) => (c[0] as { data?: Record<string, unknown> })?.data?.status,
      );
      expect(stamps).toHaveLength(1);
      // SENT → SENT não é avanço: nada de escrita de status.
      expect(statusWrites).toHaveLength(0);
    });

    // (d) O CASAMENTO NÃO PODE ROUBAR A MENSAGEM DE OUTRA CAMPANHA/CONTATO.
    //     Esta é a prova ESTRUTURAL: a consulta do candidato é escopada por
    //     canal, por "é de broadcast", por "ainda não tem wamid" e por janela.
    //     K6 acrescentou o 5º escopo, que estes quatro não davam: candidatos de
    //     MAIS DE UMA campanha não carimbam nada (ver
    //     webhooks.chat-drop-and-ack.spec.ts) — por isso a consulta virou
    //     findMany com teto, e não mais um findFirst.
    it('(d) o candidato é escopado: só broadcast, só sem wamid, só do canal do evento, só na janela', async () => {
      prisma.message.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      wa.parseWebhookFor.mockReturnValue([broadcastEvent('delivered')]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // 1. NUNCA toca uma mensagem 1-a-1 (essas casam por wamid, e já têm).
            //    As linhas do gate (SKIPPED_*/CANCELLED) também nascem sem
            //    zernioBroadcastId — este predicado sozinho já as protege.
            zernioBroadcastId: { not: null },
            // 2. NUNCA rouba uma linha que já foi casada com outro wamid.
            providerMessageId: null,
            // 3. Só o canal que recebeu o webhook.
            instanceId: 'ch_zernio',
            // 4. Só o telefone do evento (com as duas formas do 9º dígito).
            contact: {
              phoneE164: { in: ['+5592986550101', '+559286550101'] },
            },
          }),
        }),
      );
      // Sem candidato → nada é escrito, e a chave de dedupe é liberada para a
      // reentrega do Zernio (at-least-once) tentar de novo.
      expect(prisma.message.updateMany).not.toHaveBeenCalled();
    });

    // (d2) O fallback por telefone é EXCLUSIVO do broadcast. Um evento sem
    //      `recipientPhone` (Evolution/Twilio: eles sempre trazem o wamid, e a
    //      Message deles sempre tem `providerMessageId`) não pode acionar
    //      consulta nenhuma por telefone. Regressão do 1-a-1.
    it('(d2) evento SEM recipientPhone (Evolution/Twilio) não aciona o fallback por telefone', async () => {
      prisma.message.findUnique.mockResolvedValue(null);
      wa.parseWebhookFor.mockReturnValue([
        {
          providerMessageId: 'wamid.evolution',
          status: 'delivered',
          occurredAt: new Date(),
        },
      ]);

      await service.process({}, 'inst-1', 'EVOLUTION');

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(prisma.message.updateMany).not.toHaveBeenCalled();
      // Comportamento de hoje, intacto: libera a dedupe na ausência da linha.
      expect(redis.del).toHaveBeenCalledWith(
        'webhook:wamid.evolution:delivered',
      );
    });

    // Os contadores do espelho (o que a TELA mostra) são uma PROJEÇÃO das nossas
    // Messages. Como o reconciliador agora é lento (5–30 min) e desiste depois de
    // ~11h, um `read` que chega na hora 13 atualizaria a Message e o espelho
    // ficaria mentindo para sempre. Quem apura o status é quem tem de recontar.
    it('ao aplicar o status de uma mensagem de BROADCAST, recalcula os contadores do espelho', async () => {
      prisma.message.findUnique.mockResolvedValue({
        ...broadcastMessage,
        providerMessageId: WAMID,
      });
      // As nossas Messages deste disparo, depois do update.
      prisma.message.groupBy.mockResolvedValue([
        { status: 'READ', _count: { _all: 2 } },
        { status: 'DELIVERED', _count: { _all: 3 } },
        { status: 'FAILED', _count: { _all: 1 } },
      ] as never);
      wa.parseWebhookFor.mockReturnValue([broadcastEvent('read')]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.zernioBroadcast.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'zb-1' },
          data: expect.objectContaining({
            sentCount: 5, // READ(2) + DELIVERED(3)
            deliveredCount: 5,
            readCount: 2,
            failedCount: 1,
          }),
        }),
      );
    });

    // Uma mensagem 1-a-1 (sem broadcast) não tem espelho para recontar.
    it('mensagem SEM broadcast não mexe em espelho nenhum', async () => {
      prisma.message.findUnique.mockResolvedValue({
        ...broadcastMessage,
        providerMessageId: WAMID,
        zernioBroadcastId: null,
      });
      wa.parseWebhookFor.mockReturnValue([broadcastEvent('read')]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      expect(prisma.zernioBroadcast.update).not.toHaveBeenCalled();
    });

    // A corrida que o `@unique` do providerMessageId torna real: `sent` e
    // `delivered` do MESMO wamid chegam quase juntos, os dois erram o findUnique
    // e os dois acham o MESMO candidato por telefone. Quem perde o carimbo
    // (count 0) tem de RELER pela chave — não pode explodir nem desistir.
    it('carimbo perdido na corrida: relê pelo wamid e segue (sem estourar o @unique)', async () => {
      prisma.message.findUnique
        .mockResolvedValueOnce(null) // 1ª leitura: o wamid ainda não existe
        .mockResolvedValueOnce({
          // relê depois de perder o carimbo: o concorrente já gravou
          ...broadcastMessage,
          providerMessageId: WAMID,
        });
      prisma.message.findMany.mockResolvedValue([broadcastMessage]);
      // O carimbo não casa nenhuma linha: o concorrente chegou primeiro.
      prisma.message.updateMany.mockResolvedValueOnce({ count: 0 });
      wa.parseWebhookFor.mockReturnValue([broadcastEvent('delivered')]);

      await service.process({}, 'ch_zernio', 'ZERNIO');

      // Mesmo tendo perdido o carimbo, o status foi aplicado na linha certa.
      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'm-bc' }),
          data: expect.objectContaining({ status: 'DELIVERED' }),
        }),
      );
    });
  });
});

describe('WebhooksService — connection.update handling', () => {
  let service: WebhooksService;
  let repo: {
    findLastEvent: ReturnType<typeof vi.fn>;
    createEvent: ReturnType<typeof vi.fn>;
  };
  let historyQueue: { add: ReturnType<typeof vi.fn> };

  const INSTANCE_ID = 'inst-uuid-123';

  function makePrisma() {
    return {
      message: { findUnique: vi.fn(), update: vi.fn() },
      contact: { findUnique: vi.fn(), update: vi.fn() },
    } as unknown as PrismaService;
  }

  function makeWa() {
    return {
      parseInboundMessages: vi.fn().mockReturnValue([]),
    } as unknown as WhatsappProvidersService;
  }

  function makeConfig() {
    return {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as ConfigService<Env>;
  }

  function makeAudit() {
    return { log: vi.fn() } as unknown as AuditService;
  }

  function makeRedis() {
    return { set: vi.fn().mockResolvedValue(null) } as unknown as Redis;
  }

  // Helper: build a connection.update payload (instance name in body is irrelevant
  // now — the controller resolves instanceId from DB before calling process())
  function connPayload(state: string, reasonCode?: number) {
    return {
      event: 'connection.update',
      instance: { instanceName: 'picoa-dev' },
      data: { state, statusReason: reasonCode ?? null },
    };
  }

  beforeEach(() => {
    repo = {
      findLastEvent: vi.fn().mockResolvedValue(null),
      createEvent: vi.fn().mockResolvedValue({ id: 'e1' }),
    };
    historyQueue = { add: vi.fn().mockResolvedValue(undefined) };
    service = new WebhooksService(
      makePrisma(),
      makeWa(),
      makeConfig(),
      makeAudit(),
      makeRedis(),
      repo as unknown as WhatsappProvidersRepository,
      { maybeCompleteCampaign: vi.fn().mockResolvedValue(undefined) } as never,
      mockDeep<ChatIngestService>(),
      mockDeep<ChatEventsService>(),
      {
        get: vi.fn().mockResolvedValue({
          id: 'singleton',
          name: 'CONTINUUM',
          legalName: 'Canal do Matheus Garcia - CONTINUUM',
          privacyPolicyUrl: null,
          supportContact: null,
        }),
      } as never,
      mockDeep<TemplatesService>(),
      historyQueue as never,
    );
  });

  it('inserts an event when no previous event exists for the instance', async () => {
    repo.findLastEvent.mockResolvedValueOnce(null);
    await service.process(connPayload('open'), INSTANCE_ID);
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: INSTANCE_ID,
        state: 'open',
        reasonCode: null,
      }),
    );
  });

  it('inserts an event when the new state differs from the last event', async () => {
    repo.findLastEvent.mockResolvedValueOnce({
      state: 'connecting',
      reasonCode: null,
    });
    await service.process(connPayload('open'), INSTANCE_ID);
    expect(repo.createEvent).toHaveBeenCalledTimes(1);
  });

  it('skips insert when the new state equals a RECENT last event (burst dedup)', async () => {
    repo.findLastEvent.mockResolvedValueOnce({
      state: 'open',
      reasonCode: null,
      occurredAt: new Date(), // recent → within the burst window
    });
    await service.process(connPayload('open'), INSTANCE_ID);
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('includes reasonCode from statusReason when provided', async () => {
    await service.process(connPayload('close', 401), INSTANCE_ID);
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'close', reasonCode: 401 }),
    );
  });

  it('ignores non-connection.update events (no repo calls)', async () => {
    await service.process({ event: 'messages.update', data: {} });
    expect(repo.findLastEvent).not.toHaveBeenCalled();
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  /**
   * GOZAP — evento `connection`, shape capturado em produção (2026-08-07):
   * `{event:'connection', instance_id, data:{status, reason}, timestamp}`.
   * O gate original exigia `event === 'connection.update'` com `data.state`,
   * que é literal do EVOLUTION: todo evento de conexão do GoZap era recebido,
   * autenticado, respondido 200 e descartado — e o canal pareado nunca ficava
   * "online" para o roteador de envio.
   */
  describe('GOZAP — evento "connection" (shape whatsmeow)', () => {
    const gozapConn = (status: string, reason?: string) => ({
      event: 'connection',
      instance_id: 'rffe51e7ef7c8ff',
      timestamp: 1786127362462,
      data: { status, ...(reason ? { reason } : {}) },
    });

    it('status "connected" → persiste "open"', async () => {
      await service.process(gozapConn('connected'), INSTANCE_ID);
      expect(repo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: INSTANCE_ID, state: 'open' }),
      );
    });

    it('status "disconnected" → persiste "close"', async () => {
      await service.process(
        gozapConn('disconnected', 'websocket disconnected'),
        INSTANCE_ID,
      );
      expect(repo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: INSTANCE_ID, state: 'close' }),
      );
    });

    it('status "syncing" NÃO vira evento — é reconexão transitória (~10s)', async () => {
      // Observado 2x em produção: disconnected → syncing → connected em ~11s.
      // Persistir o intermediário parquearia envios a cada oscilação.
      await service.process(gozapConn('syncing'), INSTANCE_ID);
      expect(repo.createEvent).not.toHaveBeenCalled();
    });

    it('status desconhecido é ignorado, não vira "close"', async () => {
      await service.process(gozapConn('coisa_nova'), INSTANCE_ID);
      expect(repo.createEvent).not.toHaveBeenCalled();
    });
  });

  it('skips connection event persistence when instanceId is not provided', async () => {
    await service.process(connPayload('open'));
    expect(repo.findLastEvent).not.toHaveBeenCalled();
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('enqueues a delayed history-sync job on a real transition to open', async () => {
    repo.findLastEvent.mockResolvedValueOnce({
      state: 'connecting',
      reasonCode: null,
    });
    await service.process(connPayload('open'), INSTANCE_ID);
    expect(historyQueue.add).toHaveBeenCalledWith(
      'sync',
      { instanceId: INSTANCE_ID },
      expect.objectContaining({ delay: 15000 }),
    );
    // No static jobId — a retained completed job must not dedup a later re-pair.
    const opts = historyQueue.add.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.jobId).toBeUndefined();
  });

  it('enqueues STAGGERED history syncs (15s/90s/300s) to catch progressive batches', async () => {
    repo.findLastEvent.mockResolvedValueOnce({
      state: 'connecting',
      reasonCode: null,
    });
    await service.process(connPayload('open'), INSTANCE_ID);
    const delays = (historyQueue.add.mock.calls as unknown[][]).map(
      (c) => (c[2] as { delay: number }).delay,
    );
    expect(delays).toEqual([15000, 90000, 300000]);
  });

  it('does NOT enqueue history sync for non-open states', async () => {
    await service.process(connPayload('connecting'), INSTANCE_ID);
    await service.process(connPayload('close', 401), INSTANCE_ID);
    expect(historyQueue.add).not.toHaveBeenCalled();
  });

  it('does NOT enqueue history sync when open is a recent-burst dedup', async () => {
    repo.findLastEvent.mockResolvedValueOnce({
      state: 'open',
      reasonCode: null,
      occurredAt: new Date(),
    });
    await service.process(connPayload('open'), INSTANCE_ID);
    expect(historyQueue.add).not.toHaveBeenCalled();
  });

  // Helper: a full connection.update body including the top-level date_time
  // (Evolution stamps the event's true time there; webhooks can arrive out of order).
  function connPayloadAt(
    state: string,
    dateTimeIso: string,
    reasonCode?: number,
  ) {
    return {
      event: 'connection.update',
      instance: { instanceName: 'picoa-dev' },
      data: { state, statusReason: reasonCode ?? null },
      date_time: dateTimeIso,
    };
  }

  it('persists a fresh open even when the last event is a STALE same-state open (gap > window)', async () => {
    // Previous session ended 'open' with no 'close' recorded; days later a real
    // reconnect 'open' must NOT be swallowed by the stale same-state event.
    repo.findLastEvent.mockResolvedValueOnce({
      state: 'open',
      reasonCode: null,
      occurredAt: new Date('2026-06-08T00:00:00.000Z'),
    });
    await service.process(
      connPayloadAt('open', '2026-06-10T23:37:00.000Z', 200),
      INSTANCE_ID,
    );
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: INSTANCE_ID,
        state: 'open',
        occurredAt: new Date('2026-06-10T23:37:00.000Z'),
      }),
    );
  });

  it('stamps occurredAt from the payload date_time (out-of-order-safe ordering)', async () => {
    repo.findLastEvent.mockResolvedValueOnce(null);
    await service.process(
      connPayloadAt('connecting', '2026-06-10T23:36:58.000Z', 200),
      INSTANCE_ID,
    );
    expect(repo.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'connecting',
        occurredAt: new Date('2026-06-10T23:36:58.000Z'),
      }),
    );
  });

  it('dedups a same-state event within the burst window', async () => {
    repo.findLastEvent.mockResolvedValueOnce({
      state: 'connecting',
      reasonCode: null,
      occurredAt: new Date('2026-06-10T23:36:50.000Z'),
    });
    await service.process(
      connPayloadAt('connecting', '2026-06-10T23:36:58.000Z', 200),
      INSTANCE_ID,
    ); // +8s, within 60s
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  // ── ZW — O WEBHOOK É A FONTE DE VERDADE DO STATUS DO BROADCAST ────────────
  //
  // SONDAGEM AO VIVO (13/07, conta de produção) que inverteu o desenho:
  //
  //   GET /v1/broadcasts/{id}/recipients devolve, DE VERDADE, por destinatário:
  //     { id, contactId, channelId, platformIdentifier, contactName,
  //       status: "pending", errorExplanation: null }
  //   NÃO tem messageId (wamid). NÃO tem sentAt/deliveredAt/readAt. NÃO tem
  //   errorCode. E 30+ minutos depois do disparo TODOS os 50 destinatários
  //   amostrados continuavam "pending" enquanto os webhooks já mostravam
  //   entregas. O status de lá está MORTO.
  //
  //   O WEBHOOK, esse, funciona e é em TEMPO REAL — e traz o wamid em
  //   `message.platformMessageId` e o telefone em `conversation.participantId`.
  //
  // O PROBLEMA DO CASAMENTO: `POST /broadcasts/{id}/send` não devolve wamid
  // nenhum, então as Messages do broadcast nascem SEM `providerMessageId`. O
  // webhook chega com o wamid e não casa com nada. A saída é casar por
  // TELEFONE + broadcast + janela, e então CARIMBAR o wamid na linha — a partir
  // daí os eventos seguintes casam pelo caminho normal, que já funciona.
});
