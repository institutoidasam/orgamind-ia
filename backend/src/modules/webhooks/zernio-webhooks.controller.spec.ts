import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type Redis from 'ioredis';
import { ZernioWebhooksController } from './zernio-webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { AuditService } from '../../shared/audit/audit.service';
import { WebhookDropsService } from '../whatsapp-providers/webhook-drops.service';
import { UnauthorizedError } from '../../shared/errors/domain.error';
import { PrismaService } from '../../shared/prisma/prisma.service';

function makeReq(opts: { rawBody?: Buffer; ip?: string; hasRawBody?: boolean } = {}) {
  const hasRawBody = opts.hasRawBody ?? true;
  return {
    rawBody: hasRawBody ? (opts.rawBody ?? Buffer.from('{}')) : undefined,
    ip: opts.ip ?? '127.0.0.1',
    headers: { 'user-agent': 'zernio', 'x-request-id': 'req-1' },
  } as never;
}

/** A message.received envelope with the account context object. */
function inboundEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_123',
    event: 'message.received',
    timestamp: '2026-07-10T12:00:00Z',
    message: { id: 'msg_1', message: 'oi', direction: 'incoming', accountId: 'acc_1' },
    conversation: { participantId: '+5592987654321' },
    account: { id: 'acc_1', platform: 'whatsapp' },
    ...overrides,
  };
}

describe('ZernioWebhooksController', () => {
  let controller: ZernioWebhooksController;
  let webhooks: MockProxy<WebhooksService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let prisma: MockProxy<PrismaService>;
  let redis: MockProxy<Redis>;
  let audit: MockProxy<AuditService>;
  let drops: MockProxy<WebhookDropsService>;

  beforeEach(() => {
    webhooks = mockDeep<WebhooksService>();
    wa = mockDeep<WhatsappProvidersService>();
    prisma = mockDeep<PrismaService>();
    redis = mockDeep<Redis>();
    audit = mockDeep<AuditService>();
    drops = mockDeep<WebhookDropsService>();
    // Default happy-path stubs: valid signature, fresh event, ingest ok.
    (wa as any).verifyZernioSignature = vi.fn().mockReturnValue(true);
    (redis.set as any).mockResolvedValue('OK'); // SETNX succeeded → new event
    webhooks.process.mockResolvedValue(undefined);
    controller = new ZernioWebhooksController(
      webhooks,
      wa,
      prisma,
      redis,
      audit,
      drops,
    );
  });

  it('valid signature + resolved channel → 200 and delegates process(payload, channelId, ZERNIO)', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({
      id: 'chan-z',
      provider: 'ZERNIO',
      zernioAccountId: 'acc_1',
    });
    const body = inboundEnvelope();

    const res = await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect((wa as any).verifyZernioSignature).toHaveBeenCalledWith(
      expect.any(Buffer),
      'good-sig',
    );
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: { provider: 'ZERNIO', zernioAccountId: 'acc_1', isActive: true },
    });
    expect(webhooks.process).toHaveBeenCalledWith(body, 'chan-z', 'ZERNIO');
    expect(res).toEqual({ ok: true });
  });

  it('invalid signature → UnauthorizedError (401) and does NOT process', async () => {
    (wa as any).verifyZernioSignature = vi.fn().mockReturnValue(false);
    const body = inboundEnvelope();

    await expect(
      controller.receive(makeReq({ ip: '203.0.113.9' }), 'tampered', undefined, body),
    ).rejects.toMatchObject({ status: 401 });

    expect(webhooks.process).not.toHaveBeenCalled();
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    // Signature rejection is audited (matches the Twilio controller).
    expect(audit.log).toHaveBeenCalledWith(
      'webhook.signature_invalid',
      'WhatsappWebhook',
      undefined,
      expect.objectContaining({ ip: '203.0.113.9', provider: 'zernio' }),
    );
  });

  it('missing rawBody → UnauthorizedError (401), signature never even checked, does NOT process', async () => {
    const body = inboundEnvelope();

    await expect(
      controller.receive(makeReq({ hasRawBody: false }), 'good-sig', undefined, body),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect((wa as any).verifyZernioSignature).not.toHaveBeenCalled();
    expect(webhooks.process).not.toHaveBeenCalled();
  });

  it('duplicate event id (SETNX returns null) → 200 and does NOT process', async () => {
    (redis.set as any).mockResolvedValue(null); // key already exists
    const body = inboundEnvelope();

    const res = await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('evt_123'),
      expect.anything(),
      'EX',
      24 * 3600,
      'NX',
    );
    expect(webhooks.process).not.toHaveBeenCalled();
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it('dedupe key derived from X-Zernio-Event-Id header when payload.id is absent', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-z' });
    const body = inboundEnvelope({ id: undefined });

    await controller.receive(makeReq(), 'good-sig', 'evt_from_header', body);

    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('evt_from_header'),
      expect.anything(),
      'EX',
      24 * 3600,
      'NX',
    );
    expect(webhooks.process).toHaveBeenCalledWith(body, 'chan-z', 'ZERNIO');
  });

  it('Redis unavailable during dedupe → fail-open: warns and still processes', async () => {
    (redis.set as any).mockRejectedValue(new Error('redis down'));
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-z' });
    const warnSpy = vi
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const body = inboundEnvelope();

    const res = await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect(warnSpy).toHaveBeenCalled();
    expect(webhooks.process).toHaveBeenCalledWith(body, 'chan-z', 'ZERNIO');
    expect(res).toEqual({ ok: true });
  });

  it('no channel found for account → 200 + warn, does NOT process (avoids Zernio retries)', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue(null);
    const warnSpy = vi
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const body = inboundEnvelope();

    const res = await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect(warnSpy).toHaveBeenCalled();
    expect(webhooks.process).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  /**
   * O CORAÇÃO DO INCIDENTE. O `warn` acima não é detecção — ninguém lê log de
   * produção por hábito, e foi por isso que ~100 mensagens sumiram sem que
   * ninguém percebesse. O descarte agora vira uma linha contada que a página
   * Canais exibe como alerta.
   */
  it('no channel found → registra um WebhookDrop com a conta e o evento (perda deixa de ser invisível)', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue(null);
    vi.spyOn((controller as any).logger, 'warn').mockImplementation(() => undefined);
    const body = inboundEnvelope({ event: 'message.read' });

    await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect(drops.record).toHaveBeenCalledWith({
      provider: 'ZERNIO',
      accountRef: 'acc_1',
      event: 'message.read',
    });
  });

  it('canal resolvido → processa normalmente e NÃO registra drop nenhum', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-z' });

    await controller.receive(makeReq(), 'good-sig', undefined, inboundEnvelope());

    expect(webhooks.process).toHaveBeenCalledWith(
      expect.anything(),
      'chan-z',
      'ZERNIO',
    );
    expect(drops.record).not.toHaveBeenCalled();
  });

  it('missing account id → 200 + warn, no channel lookup, does NOT process', async () => {
    const warnSpy = vi
      .spyOn((controller as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const body = inboundEnvelope({ account: {}, message: { id: 'm', message: 'oi' } });

    const res = await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(webhooks.process).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it('resolves account id when `account` is a plain string', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-z' });
    const body = inboundEnvelope({ account: 'acc_str' });

    await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: { provider: 'ZERNIO', zernioAccountId: 'acc_str', isActive: true },
    });
  });

  it('non-inbound / status event (whatsapp.template.status_updated) is delegated without breaking', async () => {
    (prisma.channel.findFirst as any).mockResolvedValue({ id: 'chan-z' });
    const body = {
      id: 'evt_tpl',
      event: 'whatsapp.template.status_updated',
      timestamp: '2026-07-10T12:00:00Z',
      account: { id: 'acc_1' },
      template: { status: 'APPROVED', reason: 'NONE' },
    };

    const res = await controller.receive(makeReq(), 'good-sig', undefined, body);

    expect(webhooks.process).toHaveBeenCalledWith(body, 'chan-z', 'ZERNIO');
    expect(res).toEqual({ ok: true });
  });
});
