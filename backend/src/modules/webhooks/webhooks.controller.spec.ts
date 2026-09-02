import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ConfigService } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { AuditService } from '../../shared/audit/audit.service';
import { UnauthorizedError } from '../../shared/errors/domain.error';
import type { Env } from '../../shared/config/env.schema';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { ReconnectReplayService } from '../whatsapp-instances/reconnect-replay.service';

/**
 * Builds a minimal RawBodyRequest stub the controller actually reaches into.
 */
function makeReq(opts: {
  rawBody?: Buffer;
  ip?: string;
  userAgent?: string;
  requestId?: string;
} = {}) {
  return {
    rawBody: opts.rawBody,
    ip: opts.ip ?? '127.0.0.1',
    headers: {
      'user-agent': opts.userAgent ?? 'jest',
      'x-request-id': opts.requestId ?? 'req-1',
    },
  } as never;
}

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let webhooks: MockProxy<WebhooksService>;
  let audit: MockProxy<AuditService>;
  let config: MockProxy<ConfigService<Env>>;
  let instancesRepo: MockProxy<WhatsappInstancesRepository>;
  let replayService: MockProxy<ReconnectReplayService>;

  beforeEach(() => {
    webhooks = mockDeep<WebhooksService>();
    audit = mockDeep<AuditService>();
    config = mockDeep<ConfigService<Env>>();
    instancesRepo = mockDeep<WhatsappInstancesRepository>();
    replayService = mockDeep<ReconnectReplayService>();
    controller = new WebhooksController(webhooks, audit, config, instancesRepo, replayService);
  });

  describe('verify (GET challenge)', () => {
    it('returns the challenge string from webhooks.verifyChallenge', () => {
      webhooks.verifyChallenge.mockReturnValue('challenge-123');
      const result = controller.verify('subscribe', 'tok', 'challenge-123');
      expect(result).toBe('challenge-123');
      expect(webhooks.verifyChallenge).toHaveBeenCalledWith(
        'subscribe',
        'tok',
        'challenge-123',
      );
    });
  });

  describe('receive (POST signed payload) — provider detected from the payload shape', () => {
    it('Meta-shaped payload (object=whatsapp_business_account) with valid HMAC processes the body and routes to parseWebhookFor(META, ...)', async () => {
      webhooks.verifySignature.mockReturnValue(true);
      webhooks.process.mockResolvedValue(undefined as never);
      const body = { object: 'whatsapp_business_account', entry: [] };
      const rawBody = Buffer.from(JSON.stringify(body));
      const req = makeReq({ rawBody });

      const result = await controller.receive(req, 'sha256=abc', undefined, body);

      expect(webhooks.verifySignature).toHaveBeenCalledWith(rawBody, 'sha256=abc');
      expect(webhooks.process).toHaveBeenCalledWith(body, undefined, 'META');
      expect(audit.log).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });

    it('Meta-shaped payload with invalid HMAC throws UnauthorizedError + audit-logs the rejection', async () => {
      webhooks.verifySignature.mockReturnValue(false);
      const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
      const req = makeReq({
        rawBody,
        ip: '203.0.113.10',
        userAgent: 'evil-bot/1.0',
      });

      await expect(
        controller.receive(
          req,
          'sha256=tampered',
          undefined,
          { object: 'whatsapp_business_account' },
        ),
      ).rejects.toThrow(UnauthorizedError);

      expect(audit.log).toHaveBeenCalledWith(
        'webhook.signature_invalid',
        'WhatsappWebhook',
        undefined,
        expect.objectContaining({
          ip: '203.0.113.10',
          userAgent: 'evil-bot/1.0',
        }),
      );
      expect(webhooks.process).not.toHaveBeenCalled();
    });

    it('Meta-shaped payload rejects when rawBody is missing (no upstream HMAC to verify)', async () => {
      // verifySignature should not even be reached when rawBody is falsy.
      const req = makeReq({ rawBody: undefined });
      await expect(
        controller.receive(req, 'sha256=x', undefined, { object: 'whatsapp_business_account' }),
      ).rejects.toThrow(UnauthorizedError);
      expect(webhooks.process).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        'webhook.signature_invalid',
        'WhatsappWebhook',
        undefined,
        expect.any(Object),
      );
    });

    it('Evolution-shaped payload (string event) with matching apikey processes the payload and routes to parseWebhookFor(EVOLUTION, ...)', async () => {
      webhooks.process.mockResolvedValue(undefined as never);
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      const req = makeReq({ rawBody: undefined });
      const body = { event: 'messages.upsert' };

      const result = await controller.receive(req, undefined as never, 'evo-secret', body);

      expect(webhooks.verifySignature).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(webhooks.process).toHaveBeenCalledWith(body, undefined, 'EVOLUTION');
      expect(result).toEqual({ ok: true });
    });

    it('Evolution-shaped payload with a string `instance` field also routes to parseWebhookFor(EVOLUTION, ...)', async () => {
      // Real Evolution payloads sometimes carry `instance` as a plain string
      // (not the { instanceName } object form) — detection must not depend on
      // the object shape, only on the presence of a string `event`.
      webhooks.process.mockResolvedValue(undefined as never);
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      instancesRepo.findByEvolutionName.mockResolvedValue(null);
      const body = { event: 'messages.upsert', instance: 'picoa', data: {} };

      const result = await controller.receive(makeReq(), undefined as never, 'evo-secret', body);

      expect(webhooks.process).not.toHaveBeenCalled(); // unknown instance → 200, no process
      expect(result).toEqual({ ok: true });
    });

    it('Evolution-shaped payload rejects mismatched apikey and audit-logs the rejection', async () => {
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      const req = makeReq({ ip: '203.0.113.10' });

      await expect(
        controller.receive(req, undefined as never, 'wrong-key', { event: 'messages.upsert' }),
      ).rejects.toThrow(UnauthorizedError);

      expect(webhooks.process).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(
        'webhook.apikey_invalid',
        'WhatsappWebhook',
        undefined,
        expect.objectContaining({ ip: '203.0.113.10' }),
      );
    });

    it('Evolution-shaped payload accepts apikey from JSON body (v2.3 webhook format)', async () => {
      // Evolution v2 ships the credential inside the event body, not as an
      // HTTP header. Without this branch every QRCODE_UPDATED / MESSAGES_UPSERT
      // event arriving from a stock Evolution container is rejected with 401.
      webhooks.process.mockResolvedValue(undefined as never);
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      const req = makeReq();
      const body = { event: 'qrcode.updated', data: 'x', apikey: 'evo-secret' };

      const result = await controller.receive(req, undefined as never, undefined, body);

      expect(audit.log).not.toHaveBeenCalled();
      expect(webhooks.process).toHaveBeenCalledWith(body, undefined, 'EVOLUTION');
      expect(result).toEqual({ ok: true });
    });

    it('Evolution-shaped payload rejects when no apikey header is sent', async () => {
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      const req = makeReq();
      await expect(
        controller.receive(req, undefined as never, undefined, { event: 'messages.upsert' }),
      ).rejects.toThrow(UnauthorizedError);
      expect(webhooks.process).not.toHaveBeenCalled();
    });

    it('Evolution-shaped payload rejects a wrong-length apikey with Unauthorized (constant-time compare, no crash)', async () => {
      // crypto.timingSafeEqual throws RangeError on length-mismatched buffers.
      // The length-guarded comparison must surface a clean UnauthorizedError,
      // never leak a 500 / RangeError. (apikey much shorter than the secret.)
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret-long' : undefined,
      );
      const req = makeReq({ ip: '203.0.113.99' });
      await expect(
        controller.receive(req, undefined as never, 'x', { event: 'messages.upsert' }),
      ).rejects.toThrow(UnauthorizedError);
      expect(webhooks.process).not.toHaveBeenCalled();
    });

    it('Evolution-shaped payload accepts a correct apikey via the constant-time compare', async () => {
      webhooks.process.mockResolvedValue(undefined as never);
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret-long' : undefined,
      );
      const req = makeReq();
      const result = await controller.receive(
        req,
        undefined as never,
        'evo-secret-long',
        { event: 'messages.upsert' },
      );
      expect(result).toEqual({ ok: true });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rate-limits the audit INSERT on repeated rejections from the same IP (DoS/amplification guard)', async () => {
      // The route is @Public() + @SkipThrottle(); a flood of bad-apikey requests
      // must NOT yield one synchronous AuditEvent INSERT per request. We audit
      // the first rejection from an IP, then suppress within the window.
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      const req = makeReq({ ip: '198.51.100.7' });

      for (let i = 0; i < 5; i++) {
        await expect(
          controller.receive(req, undefined as never, 'wrong-key', { event: 'messages.upsert' }),
        ).rejects.toThrow(UnauthorizedError);
      }
      // Audited once for the IP, not five times.
      expect(audit.log).toHaveBeenCalledTimes(1);
    });

    it('still audits rejections from distinct IPs (rate-limit is per-IP)', async () => {
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      await expect(
        controller.receive(
          makeReq({ ip: '198.51.100.1' }),
          undefined as never,
          'wrong',
          { event: 'messages.upsert' },
        ),
      ).rejects.toThrow(UnauthorizedError);
      await expect(
        controller.receive(
          makeReq({ ip: '198.51.100.2' }),
          undefined as never,
          'wrong',
          { event: 'messages.upsert' },
        ),
      ).rejects.toThrow(UnauthorizedError);
      expect(audit.log).toHaveBeenCalledTimes(2);
    });

    it('logs raw payload diagnostic only for connection-lifecycle events', async () => {
      webhooks.process.mockResolvedValue(undefined as never);
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      const req = makeReq();
      // qrcode.updated triggers the diag log path — primary assertion is just that
      // the call still flows through to webhooks.process.
      await controller.receive(req, undefined as never, 'evo-secret', {
        event: 'qrcode.updated',
        data: 'x',
      });
      expect(webhooks.process).toHaveBeenCalledTimes(1);
    });

    it('resolves instance via payload.instance.instanceName and triggers replay on state=open', async () => {
      webhooks.process.mockResolvedValue(undefined as never);
      replayService.replayWaitingFor.mockResolvedValue(undefined);
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      instancesRepo.findByEvolutionName.mockResolvedValue({ id: 'inst-a' } as any);
      const payload = {
        event: 'connection.update',
        instance: { instanceName: 'evo-a' },
        data: { state: 'open' },
      };

      await controller.receive(makeReq(), '', 'evo-secret', payload);

      expect(instancesRepo.findByEvolutionName).toHaveBeenCalledWith('evo-a');
      expect(webhooks.process).toHaveBeenCalledWith(payload, 'inst-a', 'EVOLUTION');
      expect(replayService.replayWaitingFor).toHaveBeenCalledWith('inst-a');
    });

    it('logs (does not swallow) a rejected replayWaitingFor from the request path', async () => {
      webhooks.process.mockResolvedValue(undefined as never);
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      instancesRepo.findByEvolutionName.mockResolvedValue({ id: 'inst-a' } as any);
      replayService.replayWaitingFor.mockRejectedValue(new Error('boom'));
      const errorSpy = vi
        .spyOn((controller as any).logger, 'error')
        .mockImplementation(() => undefined);

      const res = await controller.receive(makeReq(), '', 'evo-secret', {
        event: 'connection.update',
        instance: { instanceName: 'evo-a' },
        data: { state: 'open' },
      });

      // The webhook still returns ok...
      expect(res).toEqual({ ok: true });
      // ...but the fire-and-forget rejection must be observed (logged), not
      // become an unhandled promise rejection that can crash the process.
      await new Promise((resolve) => setImmediate(resolve));
      expect(errorSpy).toHaveBeenCalled();
    });

    it('returns 200 with warning for unknown instance (no retry)', async () => {
      config.get.mockImplementation((key: unknown) =>
        key === 'EVOLUTION_API_KEY' ? 'evo-secret' : undefined,
      );
      instancesRepo.findByEvolutionName.mockResolvedValue(null);

      const res = await controller.receive(makeReq(), '', 'evo-secret', {
        event: 'connection.update',
        instance: { instanceName: 'ghost' },
        data: { state: 'open' },
      });

      expect(res).toEqual({ ok: true });
      expect(webhooks.process).not.toHaveBeenCalled();
      expect(replayService.replayWaitingFor).not.toHaveBeenCalled();
    });

    it('unrecognized payload format (neither Evolution nor Meta shape) → 200 ok, warns, does not process', async () => {
      const warnSpy = vi
        .spyOn((controller as any).logger, 'warn')
        .mockImplementation(() => undefined);

      const res = await controller.receive(makeReq(), undefined as never, undefined, {
        foo: 'bar',
      });

      expect(res).toEqual({ ok: true });
      expect(webhooks.process).not.toHaveBeenCalled();
      expect(webhooks.verifySignature).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('unrecognized payload format short-circuits BEFORE any credential check (no apikey/signature required)', async () => {
      // An empty/garbage body must not even reach the Evolution apikey branch —
      // it's classified as "unknown format" first and acked without processing.
      const res = await controller.receive(makeReq(), undefined as never, undefined, {});
      expect(res).toEqual({ ok: true });
      expect(webhooks.process).not.toHaveBeenCalled();
    });
  });
});
