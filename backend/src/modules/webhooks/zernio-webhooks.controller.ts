import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { WebhooksService } from './webhooks.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { Public } from '../auth/decorators/public.decorator';
import { UnauthorizedError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WebhookDropsService } from '../whatsapp-providers/webhook-drops.service';

// Zernio delivers at-least-once and retries up to 7x on any non-2xx, so we
// dedupe every event by its stable id for a full day — a redelivered event
// (same id) inside this window is acked without reprocessing.
const DEDUPE_TTL_SECONDS = 24 * 3600;

/** The shape we read off a Zernio webhook envelope (only the fields we need). */
type ZernioEnvelope = {
  id?: unknown;
  event?: unknown;
  account?: unknown;
  message?: { accountId?: unknown } | unknown;
};

/**
 * Zernio posts inbound messages, delivery-status acks and template-review
 * events as JSON and authenticates with an `X-Zernio-Signature` header — the
 * HMAC-SHA256 (lowercase hex, no `sha256=` prefix) of the RAW request body,
 * keyed by the webhook's configured secret. That's a different contract from
 * the Meta/Evolution `/webhooks/whatsapp` route and the Twilio route, hence a
 * dedicated controller.
 *
 * Flow: verify the signature over `req.rawBody` BEFORE anything else (bad/absent
 * → 401, no processing) → dedupe by `payload.id`/`X-Zernio-Event-Id` in Redis
 * (SETNX + 24h TTL; a repeat is acked without reprocessing) → resolve the
 * ZERNIO channel by `account` id → hand the payload to the SAME downstream
 * pipeline (`WebhooksService.process → parse status/inbound…`). Every
 * non-fatal path returns 200 so Zernio doesn't retry OUR config errors 7x; only
 * a failed/missing signature returns 401.
 */
@SkipThrottle()
@Controller('webhooks/zernio')
export class ZernioWebhooksController {
  private readonly logger = new Logger(ZernioWebhooksController.name);

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly wa: WhatsappProvidersService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly drops: WebhookDropsService,
  ) {}

  /**
   * The Zernio account (`account`) that owns this event → the orgamind channel's
   * `zernioAccountId`. `account` is a context object (id/accountId/platform),
   * but we also accept a plain id string, and fall back to `message.accountId`.
   */
  private extractAccountId(body: ZernioEnvelope): string | undefined {
    const account = body?.account;
    if (typeof account === 'string') return account.trim() || undefined;
    if (account && typeof account === 'object') {
      const a = account as Record<string, unknown>;
      for (const key of ['accountId', 'id', '_id']) {
        const v = a[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    const msgAccountId = (body?.message as { accountId?: unknown } | undefined)
      ?.accountId;
    if (typeof msgAccountId === 'string' && msgAccountId.trim()) {
      return msgAccountId.trim();
    }
    return undefined;
  }

  /**
   * Claim the event id via Redis SETNX. Returns true when this is the first
   * time we've seen the id (safe to process), false when it's a redelivery.
   * Fails OPEN: if Redis is unreachable we log and process anyway — a rare
   * duplicate is tolerable (the downstream status pipeline has its own
   * per-(message,status) dedupe), whereas dropping real events is not.
   */
  private async claimEvent(eventId: string): Promise<boolean> {
    const key = `zernio:webhook:evt:${eventId}`;
    try {
      const res = await this.redis.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
      return res !== null; // 'OK' → new; null → already seen
    } catch (err) {
      this.logger.warn(
        `zernio dedupe unavailable (redis), processing fail-open eventId=${eventId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return true;
    }
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-zernio-signature') signature: string | undefined,
    @Headers('x-zernio-event-id') eventIdHeader: string | undefined,
    @Body() body: ZernioEnvelope,
  ): Promise<{ ok: true }> {
    // 1. Signature over the RAW body, before any processing. Without rawBody we
    // can't verify what was signed, so reject outright (rawBody: true is enabled
    // globally in main.ts — an absent buffer means the request was malformed).
    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.warn(`zernio webhook rejected: missing raw body ip=${req.ip}`);
      throw new UnauthorizedError(
        'Missing raw body',
        'webhook.zernio.no_raw_body',
      );
    }
    if (!this.wa.verifyZernioSignature(rawBody, signature)) {
      this.logger.warn(`zernio webhook rejected: bad signature ip=${req.ip}`);
      await this.audit.log(
        'webhook.signature_invalid',
        'WhatsappWebhook',
        undefined,
        {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          provider: 'zernio',
        },
      );
      throw new UnauthorizedError(
        'Invalid Zernio signature',
        'webhook.invalid_zernio_signature',
      );
    }

    const eventType = typeof body?.event === 'string' ? body.event : '?';

    // 2. Dedupe. `payload.id` == the `X-Zernio-Event-Id` header; prefer the body
    // but fall back to the header. If neither is present we can't dedupe, so we
    // process (fail-open) rather than drop the event.
    const eventId =
      (typeof body?.id === 'string' && body.id) ||
      (typeof eventIdHeader === 'string' && eventIdHeader) ||
      undefined;
    if (eventId && !(await this.claimEvent(eventId))) {
      this.logger.log(
        `zernio webhook duplicate id=${eventId} event=${eventType}, acking without reprocessing`,
      );
      return { ok: true };
    }

    // 3. Resolve which ZERNIO channel this event belongs to from the account id.
    const accountId = this.extractAccountId(body);
    if (!accountId) {
      this.logger.warn(
        `zernio webhook: no account id on payload event=${eventType}, ignoring`,
      );
      return { ok: true };
    }
    const channel = await this.prisma.channel.findFirst({
      where: { provider: 'ZERNIO', zernioAccountId: accountId, isActive: true },
    });
    if (!channel) {
      // No active ZERNIO channel for this account — warn and ack (200, not 500)
      // so Zernio doesn't retry OUR configuration gap 7x.
      //
      // ISTO É A PERDA. O warn abaixo era, sozinho, TODA a evidência de que
      // dados estavam sendo jogados fora — e ninguém lê log de produção por
      // hábito: um disparo real de ~100 mensagens evaporou assim, com a
      // interface mostrando conversas e dashboard vazios. O drop agora é
      // CONTADO e vira alerta na página Canais.
      this.logger.warn(
        `zernio webhook: no active ZERNIO channel for account=${accountId} event=${eventType}, ignoring`,
      );
      await this.drops.record({
        provider: 'ZERNIO',
        accountRef: accountId,
        event: eventType,
      });
      return { ok: true };
    }

    // 4. Delegate to the shared, channel/provider-aware ingest pipeline.
    await this.webhooks.process(body, channel.id, 'ZERNIO');
    return { ok: true };
  }
}
