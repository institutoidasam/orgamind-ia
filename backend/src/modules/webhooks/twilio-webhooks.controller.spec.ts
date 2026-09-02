import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { TwilioWebhooksController } from './twilio-webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { AuditService } from '../../shared/audit/audit.service';
import { WebhookDropsService } from '../whatsapp-providers/webhook-drops.service';
import { ForbiddenError } from '../../shared/errors/domain.error';
import type { Env } from '../../shared/config/env.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';

function makeReq(opts: { originalUrl?: string; ip?: string } = {}) {
  return {
    originalUrl: opts.originalUrl ?? '/webhooks/twilio',
    ip: opts.ip ?? '127.0.0.1',
    headers: { 'user-agent': 'twilio', 'x-request-id': 'req-1' },
  } as never;
}

describe('TwilioWebhooksController', () => {
  let controller: TwilioWebhooksController;
  let webhooks: MockProxy<WebhooksService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let audit: MockProxy<AuditService>;
  let drops: MockProxy<WebhookDropsService>;
  let config: MockProxy<ConfigService<Env>>;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    webhooks = mockDeep<WebhooksService>();
    wa = mockDeep<WhatsappProvidersService>();
    audit = mockDeep<AuditService>();
    drops = mockDeep<WebhookDropsService>();
    config = mockDeep<ConfigService<Env>>();
    prisma = mockDeep<PrismaService>();
    config.get.mockImplementation((key: unknown) =>
      key === 'WEBHOOK_BASE_URL' ? 'https://picoa.app.br' : undefined,
    );
    controller = new TwilioWebhooksController(
      webhooks,
      wa,
      audit,
      config,
      prisma,
      drops,
    );
  });

  describe('channel resolution by `To`', () => {
    it('resolves the channel whose phoneE164 matches `To`, among several active TWILIO channels', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      // findFirst is the direct-match lookup — return the channel matching
      // the stripped `To` number. findMany (fallback) must NOT even be needed.
      (prisma.channel.findFirst as any).mockResolvedValue({
        id: 'chan-b',
        phoneE164: '+5511888888888',
        provider: 'TWILIO',
      });
      const body = {
        MessageSid: 'SMinbound',
        From: 'whatsapp:+5592987654321',
        To: 'whatsapp:+5511888888888',
        Body: 'oi',
      };

      const res = await controller.receive(makeReq(), 'good-signature', body);

      expect(prisma.channel.findFirst).toHaveBeenCalledWith({
        where: { provider: 'TWILIO', phoneE164: '+5511888888888', isActive: true },
      });
      expect(webhooks.process).toHaveBeenCalledWith(body, 'chan-b', 'TWILIO');
      expect(prisma.channel.findMany).not.toHaveBeenCalled();
      expect(res).toBe('<Response></Response>');
    });

    it('falls back to the single active TWILIO channel when `To` matches no channel', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      (prisma.channel.findFirst as any).mockResolvedValue(null);
      (prisma.channel.findMany as any).mockResolvedValue([
        { id: 'chan-sole', phoneE164: '+5511777777777', provider: 'TWILIO' },
      ]);
      const body = {
        MessageSid: 'SMinbound2',
        From: 'whatsapp:+5592987654321',
        To: 'whatsapp:+5511000000000', // doesn't match any channel row yet
        Body: 'oi',
      };

      const res = await controller.receive(makeReq(), 'good-signature', body);

      expect(prisma.channel.findMany).toHaveBeenCalledWith({
        where: { provider: 'TWILIO', isActive: true },
        take: 2,
      });
      expect(webhooks.process).toHaveBeenCalledWith(body, 'chan-sole', 'TWILIO');
      expect(res).toBe('<Response></Response>');
    });

    // Even when no channel resolves, `process` must still run — status
    // callbacks (delivered/read/failed, including opt-out-triggering `failed`)
    // match by providerMessageId and don't need an instanceId. Dropping them
    // entirely (the old behaviour) silently lost delivery acks and opt-outs.
    it('warns but still processes (instanceId undefined) when no channel resolves (no TWILIO channel at all)', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      (prisma.channel.findFirst as any).mockResolvedValue(null);
      (prisma.channel.findMany as any).mockResolvedValue([]);
      const warnSpy = vi
        .spyOn((controller as any).logger, 'warn')
        .mockImplementation(() => undefined);
      const body = {
        MessageSid: 'SMinbound3',
        From: 'whatsapp:+5592987654321',
        To: 'whatsapp:+5511000000000',
        Body: 'oi',
      };

      const res = await controller.receive(makeReq(), 'good-signature', body);

      expect(webhooks.process).toHaveBeenCalledWith(body, undefined, 'TWILIO');
      expect(warnSpy).toHaveBeenCalled();
      expect(res).toBe('<Response></Response>');
    });

    /**
     * Mesmo padrão do incidente do Zernio: o canal não resolve, o webhook é
     * "aceito" e a ingestão de chat (que precisa de instanceId) vira no-op — em
     * silêncio. Os acks de status ainda passam, mas a perda de inbound tem de
     * ficar VISÍVEL na página Canais em vez de morrer num warn.
     */
    it('nenhum canal resolvido → registra WebhookDrop com o número `To` (perda deixa de ser invisível)', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      (prisma.channel.findFirst as any).mockResolvedValue(null);
      (prisma.channel.findMany as any).mockResolvedValue([]);
      vi.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
      const body = {
        MessageSid: 'SMinbound9',
        From: 'whatsapp:+5592987654321',
        To: 'whatsapp:+5511000000000',
        Body: 'oi',
      };

      await controller.receive(makeReq(), 'good-signature', body);

      expect(drops.record).toHaveBeenCalledWith({
        provider: 'TWILIO',
        // sem o prefixo `whatsapp:` — a mesma chave que casa com Channel.phoneE164
        accountRef: '+5511000000000',
        event: 'inbound',
      });
    });

    /**
     * O `To` de um status callback é o número do CLIENTE, e o ack casa por
     * providerMessageId (não se perde sem canal). Registrar drop aqui encheria a
     * página Canais de alertas falsos — um por destinatário do disparo.
     */
    it('status callback sem canal resolvido → NÃO registra drop (nada se perde, e o `To` é do cliente)', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      (prisma.channel.findFirst as any).mockResolvedValue(null);
      (prisma.channel.findMany as any).mockResolvedValue([]);
      vi.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
      const body = {
        MessageSid: 'SMstatus1',
        MessageStatus: 'delivered',
        To: 'whatsapp:+5592987654321', // o cliente, não o nosso número
        From: 'whatsapp:+5511000000000',
      };

      await controller.receive(makeReq(), 'good-signature', body);

      expect(webhooks.process).toHaveBeenCalledWith(body, undefined, 'TWILIO');
      expect(drops.record).not.toHaveBeenCalled();
    });

    it('canal resolvido → processa normalmente e NÃO registra drop nenhum', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      (prisma.channel.findFirst as any).mockResolvedValue({
        id: 'chan-t',
        provider: 'TWILIO',
        phoneE164: '+5511000000000',
      });
      const body = {
        MessageSid: 'SMinbound10',
        From: 'whatsapp:+5592987654321',
        To: 'whatsapp:+5511000000000',
        Body: 'oi',
      };

      await controller.receive(makeReq(), 'good-signature', body);

      expect(webhooks.process).toHaveBeenCalledWith(body, 'chan-t', 'TWILIO');
      expect(drops.record).not.toHaveBeenCalled();
    });

    it('warns but still processes (instanceId undefined) when `To` matches no channel AND the fallback is ambiguous (multiple active TWILIO channels)', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      (prisma.channel.findFirst as any).mockResolvedValue(null);
      (prisma.channel.findMany as any).mockResolvedValue([
        { id: 'chan-1', phoneE164: '+5511111111111', provider: 'TWILIO' },
        { id: 'chan-2', phoneE164: '+5511222222222', provider: 'TWILIO' },
      ]);
      const body = {
        MessageSid: 'SMinbound4',
        From: 'whatsapp:+5592987654321',
        To: 'whatsapp:+5511000000000',
        Body: 'oi',
      };

      const res = await controller.receive(makeReq(), 'good-signature', body);

      expect(webhooks.process).toHaveBeenCalledWith(body, undefined, 'TWILIO');
      expect(res).toBe('<Response></Response>');
    });

    it('warns but still processes (instanceId undefined) when `To` is missing/malformed and the fallback is ambiguous', async () => {
      wa.verifyTwilioSignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined);
      (prisma.channel.findMany as any).mockResolvedValue([
        { id: 'chan-1', phoneE164: '+5511111111111', provider: 'TWILIO' },
        { id: 'chan-2', phoneE164: '+5511222222222', provider: 'TWILIO' },
      ]);
      const body = { MessageSid: 'SMinbound5', From: 'whatsapp:+5592987654321', Body: 'oi' };

      const res = await controller.receive(makeReq(), 'good-signature', body);

      expect(prisma.channel.findFirst).not.toHaveBeenCalled(); // no `To` to match on
      expect(webhooks.process).toHaveBeenCalledWith(body, undefined, 'TWILIO');
      expect(res).toBe('<Response></Response>');
    });
  });

  it('valid signature → 200 and forwards to the ingest pipeline with the resolved channel', async () => {
    wa.verifyTwilioSignature.mockReturnValue(true);
    webhooks.process.mockResolvedValue(undefined);
    (prisma.channel.findFirst as any).mockResolvedValue({
      id: 'inst-default',
      phoneE164: '+5592900000000',
      provider: 'TWILIO',
    });
    const body = {
      MessageSid: 'SMinbound',
      From: 'whatsapp:+5592987654321',
      To: 'whatsapp:+5592900000000',
      Body: 'oi',
    };

    const res = await controller.receive(makeReq(), 'good-signature', body);

    // The full URL passed to signature validation is WEBHOOK_BASE_URL + originalUrl.
    expect(wa.verifyTwilioSignature).toHaveBeenCalledWith(
      'https://picoa.app.br/webhooks/twilio',
      body,
      'good-signature',
    );
    expect(webhooks.process).toHaveBeenCalledWith(body, 'inst-default', 'TWILIO');
    expect(res).toBe('<Response></Response>');
  });

  it('prefers TWILIO_WEBHOOK_URL (the exact configured URL) for signature validation', async () => {
    // Behind the proxy, WEBHOOK_BASE_URL + originalUrl can't reproduce the
    // public URL Twilio signs (the /api prefix is stripped). When the explicit
    // TWILIO_WEBHOOK_URL is set, it must be used verbatim.
    config.get.mockImplementation((key: unknown) =>
      key === 'TWILIO_WEBHOOK_URL'
        ? 'https://picoa.app.br/api/webhooks/twilio'
        : key === 'WEBHOOK_BASE_URL'
          ? 'https://picoa.app.br'
          : undefined,
    );
    wa.verifyTwilioSignature.mockReturnValue(true);
    webhooks.process.mockResolvedValue(undefined);
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'inst-default' });
    const body = {
      MessageSid: 'SMx',
      From: 'whatsapp:+5592987654321',
      To: 'whatsapp:+5592900000000',
      Body: 'oi',
    };

    await controller.receive(makeReq(), 'good-signature', body);

    expect(wa.verifyTwilioSignature).toHaveBeenCalledWith(
      'https://picoa.app.br/api/webhooks/twilio',
      body,
      'good-signature',
    );
  });

  it('bad signature → ForbiddenError (403), ingest not called, rejection audited', async () => {
    wa.verifyTwilioSignature.mockReturnValue(false);
    const body = { MessageSid: 'SMx', From: 'whatsapp:+55', Body: 'oi' };

    await expect(
      controller.receive(makeReq({ ip: '203.0.113.10' }), 'tampered', body),
    ).rejects.toThrow(ForbiddenError);

    expect(webhooks.process).not.toHaveBeenCalled();
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      'webhook.signature_invalid',
      'WhatsappWebhook',
      undefined,
      expect.objectContaining({ ip: '203.0.113.10' }),
    );
  });

  it('403 carries a ForbiddenError with status 403', async () => {
    wa.verifyTwilioSignature.mockReturnValue(false);
    try {
      await controller.receive(makeReq(), 'nope', {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).status).toBe(403);
    }
  });
});
