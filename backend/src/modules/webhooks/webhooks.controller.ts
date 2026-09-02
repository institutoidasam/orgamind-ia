import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import type { ChannelProvider } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { Public } from '../auth/decorators/public.decorator';
import { UnauthorizedError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import type { Env } from '../../shared/config/env.schema';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { ReconnectReplayService } from '../whatsapp-instances/reconnect-replay.service';

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` throws when the two
 * buffers differ in length, so we guard the length first (a length mismatch is
 * already a guaranteed non-match). Comparing the credential with `===` short-
 * circuits on the first differing byte, leaking timing about how many leading
 * characters matched — this avoids that.
 */
function timingSafeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Detect which provider's shape a `/webhooks/whatsapp` payload matches — instead
 * of trusting the env-selected `this.wa.providerName`, which is a single global
 * value and breaks the moment a deploy runs BOTH an Evolution and a Meta channel
 * at once (each inbound webhook must be parsed with the adapter matching its OWN
 * shape, not whichever provider happens to be "the" legacy active one).
 *  - Meta Cloud API envelopes always carry `object: 'whatsapp_business_account'`.
 *  - Evolution envelopes always carry a string `event`
 *    (e.g. 'messages.upsert', 'connection.update', 'qrcode.updated'); `instance`
 *    — when present — is either a plain string or `{ instanceName }`, but is not
 *    required for every event, so detection does not depend on it.
 * A payload matching neither shape is unrecognized and must not be processed.
 */
function detectWhatsappWebhookProvider(
  body: unknown,
): Extract<ChannelProvider, 'EVOLUTION' | 'META'> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { object?: unknown; event?: unknown };
  if (b.object === 'whatsapp_business_account') return 'META';
  if (typeof b.event === 'string') return 'EVOLUTION';
  return undefined;
}

// How long to suppress duplicate audit writes from the same source after the
// first rejection. The route is @Public()+@SkipThrottle(), so without this an
// attacker turns one HTTP request into one synchronous AuditEvent INSERT — an
// audit-table-amplification / DB-pressure DoS. We always log() to the app log
// (cheap, async) but write the durable AuditEvent at most once per IP/window.
const AUDIT_DEDUP_WINDOW_MS = 60_000;

@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  // Per-IP timestamp of the last persisted rejection audit. In-memory by design:
  // each instance independently caps its own audit writes, which is sufficient
  // to defang the amplification vector without new infra.
  private readonly lastRejectionAuditAt = new Map<string, number>();

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env>,
    private readonly instancesRepo: WhatsappInstancesRepository,
    private readonly replayService: ReconnectReplayService,
  ) {}

  /**
   * Audit a rejected (unauthenticated) webhook request. Always logs to the app
   * logger (cheap), but persists the durable AuditEvent at most once per source
   * IP per AUDIT_DEDUP_WINDOW_MS — so a flood of bad requests can't be amplified
   * into one synchronous DB INSERT per request on a @Public()+@SkipThrottle()
   * route.
   */
  private async auditRejection(
    action: 'webhook.signature_invalid' | 'webhook.apikey_invalid',
    req: RawBodyRequest<Request>,
  ): Promise<void> {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    this.logger.warn(`webhook rejected action=${action} ip=${ip}`);

    const last = this.lastRejectionAuditAt.get(ip);
    if (last !== undefined && now - last < AUDIT_DEDUP_WINDOW_MS) {
      // Already persisted an audit for this IP recently — suppress the INSERT.
      return;
    }
    this.lastRejectionAuditAt.set(ip, now);
    // Opportunistically prune stale entries so the map can't grow unbounded
    // under a distributed flood (one entry per attacking IP otherwise).
    if (this.lastRejectionAuditAt.size > 1000) {
      for (const [k, t] of this.lastRejectionAuditAt) {
        if (now - t >= AUDIT_DEDUP_WINDOW_MS) this.lastRejectionAuditAt.delete(k);
      }
    }
    await this.audit.log(action, 'WhatsappWebhook', undefined, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Public()
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    return this.webhooks.verifyChallenge(mode, token, challenge);
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('apikey') apikey: string | undefined,
    @Body() body: unknown,
  ) {
    const eventType = (body as { event?: string } | null)?.event;
    const provider = detectWhatsappWebhookProvider(body);
    this.logger.log(
      `Webhook received provider=${provider ?? 'unknown'} event=${eventType ?? '?'} correlationId=${req.headers['x-request-id']}`,
    );
    if (eventType === 'qrcode.updated' || eventType === 'connection.update') {
      // Surface raw payload only for connection-lifecycle events to debug QR flow
      this.logger.log(
        `[diag] ${eventType} body=${JSON.stringify(body).slice(0, 1500)}`,
      );
    }

    if (provider === undefined) {
      // Neither Evolution nor Meta shape — don't 500 trying to parse it, and
      // don't process it either. Just ack so nothing retries forever.
      this.logger.warn('webhook payload format not recognized, ignoring');
      return { ok: true };
    }

    // Meta signs payloads with HMAC-SHA256. Evolution doesn't sign — instead
    // we accept the same APIKEY we use to call Evolution, which the operator
    // can configure as the webhook's Authorization header in the Evolution UI.
    // Without this guard the endpoint is `@Public()` + `@SkipThrottle()`, so
    // anyone reachable on the network could trigger opt-outs and status writes.
    if (provider === 'META') {
      if (!req.rawBody || !this.webhooks.verifySignature(req.rawBody, signature)) {
        await this.auditRejection('webhook.signature_invalid', req);
        throw new UnauthorizedError(
          'Invalid webhook signature',
          'webhook.invalid_signature',
        );
      }
    } else if (provider === 'EVOLUTION') {
      const expected = this.config.get('EVOLUTION_API_KEY', { infer: true });
      // Evolution v2 echoes a per-instance HASH (not the global key) in
      // `body.apikey`. We configure the webhook with custom `headers.apikey`
      // set to OUR global EVOLUTION_API_KEY (see EvolutionApiAdapter
      // .ensureWebhookConfigured), so the header is the credential we trust.
      // Body falls back ONLY if it happens to match — stock containers without
      // custom headers won't be authorised, which is the correct security
      // posture: the operator must re-arm the webhook (POST /whatsapp/connection/restart).
      const bodyApikey = (body as { apikey?: unknown } | null)?.apikey;
      // Constant-time compare (timingSafeStrEqual) instead of `===` — the apikey
      // is a credential, so we don't want to leak how many leading bytes matched.
      const headerOk =
        typeof expected === 'string' &&
        typeof apikey === 'string' &&
        apikey.length > 0 &&
        timingSafeStrEqual(apikey, expected);
      const bodyOk =
        typeof expected === 'string' &&
        typeof bodyApikey === 'string' &&
        bodyApikey.length > 0 &&
        timingSafeStrEqual(bodyApikey, expected);
      if (!expected || !(headerOk || bodyOk)) {
        await this.auditRejection('webhook.apikey_invalid', req);
        throw new UnauthorizedError(
          'Invalid webhook apikey',
          'webhook.invalid_apikey',
        );
      }
    }

    // Resolve instance by Evolution instance name from the payload.
    // Evolution sends instanceName inside body.instance.instanceName (object form)
    // or sometimes as a plain string in body.instance.
    const evoName =
      (body as any)?.instance?.instanceName as string | undefined
      ?? (typeof (body as any)?.instance === 'string' ? (body as any).instance : undefined);

    let instanceId: string | undefined;
    if (evoName) {
      const inst = await this.instancesRepo.findByEvolutionName(evoName);
      if (!inst) {
        this.logger.warn(`webhook for unknown instance ${evoName}`);
        return { ok: true }; // 200 — don't let Evolution retry forever
      }
      instanceId = inst.id;
    }

    await this.webhooks.process(body, instanceId, provider);

    // After the connection event row exists, trigger replay of waiting messages.
    const state = (body as any)?.data?.state;
    if (
      (eventType === 'CONNECTION_UPDATE' || eventType === 'connection.update') &&
      state === 'open' &&
      instanceId
    ) {
      // Fire-and-forget, but never swallow the rejection: without a .catch a
      // transient failure (DB error, mid-loop enqueue failure) would become an
      // unhandled promise rejection — no log/alert, and it can crash the API
      // process under Node's default unhandledRejection behaviour.
      void this.replayService.replayWaitingFor(instanceId).catch((err) => {
        this.logger.error(
          `replayWaitingFor failed for instance=${instanceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return { ok: true };
  }
}
