import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Channel } from '@prisma/client';
import { WebhooksService } from './webhooks.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { Public } from '../auth/decorators/public.decorator';
import { ForbiddenError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import type { Env } from '../../shared/config/env.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WebhookDropsService } from '../whatsapp-providers/webhook-drops.service';

/**
 * Twilio posts inbound messages and status callbacks as
 * `application/x-www-form-urlencoded` (NOT JSON) and authenticates with an
 * `X-Twilio-Signature` HMAC-SHA1 over the full URL + sorted POST params — a
 * different contract from the Meta/Evolution `/webhooks/whatsapp` JSON route,
 * hence a dedicated controller. The signature is validated before any
 * processing; on success we hand the parsed body to the SAME downstream
 * ingest/ack pipeline (WebhooksService.process → parseWebhook/parseInbound…).
 */
@SkipThrottle()
@Controller('webhooks/twilio')
export class TwilioWebhooksController {
  private readonly logger = new Logger(TwilioWebhooksController.name);

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly wa: WhatsappProvidersService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env>,
    private readonly prisma: PrismaService,
    private readonly drops: WebhookDropsService,
  ) {}

  /**
   * Resolve which TWILIO channel a webhook belongs to from the `To` field
   * (`whatsapp:+E164`) — a deploy can have several Twilio numbers/channels
   * active, so we can no longer just grab "the" default instance.
   *  1. Strip the `whatsapp:` prefix and match a channel by phoneE164.
   *  2. If that doesn't resolve (missing/malformed `To`, or no channel row
   *     for that number yet), fall back to the single active TWILIO channel —
   *     but only when there's EXACTLY one, otherwise the fallback is ambiguous.
   *  3. Otherwise, unresolved — the caller must warn and ack without processing.
   */
  /** `whatsapp:+55…` → `+55…` (a mesma chave guardada em Channel.phoneE164). */
  private toE164(body: Record<string, unknown>): string | undefined {
    const rawTo = body?.To;
    return typeof rawTo === 'string'
      ? (rawTo.startsWith('whatsapp:') ? rawTo.slice('whatsapp:'.length) : rawTo).trim() ||
          undefined
      : undefined;
  }

  /**
   * Um status callback (delivered/read/failed) traz `MessageStatus`/`SmsStatus` e
   * casa por `providerMessageId` — NÃO precisa de canal e NÃO se perde quando
   * nenhum resolve. Distinguir os dois importa: o `To` de um status callback é o
   * número do CLIENTE, e contá-lo como "webhook perdido" encheria a tela de
   * alertas falsos, um por destinatário.
   */
  private isStatusCallback(body: Record<string, unknown>): boolean {
    return (
      typeof body?.MessageStatus === 'string' || typeof body?.SmsStatus === 'string'
    );
  }

  private async resolveTwilioChannel(
    body: Record<string, unknown>,
  ): Promise<Channel | null> {
    const toE164 = this.toE164(body);

    if (toE164) {
      const byPhone = await this.prisma.channel.findFirst({
        where: { provider: 'TWILIO', phoneE164: toE164, isActive: true },
      });
      if (byPhone) return byPhone;
    }

    // Fallback: the single active TWILIO channel, when unambiguous.
    const activeTwilioChannels = await this.prisma.channel.findMany({
      where: { provider: 'TWILIO', isActive: true },
      take: 2,
    });
    if (activeTwilioChannels.length === 1) {
      return activeTwilioChannels[0];
    }
    return null;
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() req: Request,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ): Promise<string> {
    // Twilio signs the EXACT URL it was configured to POST to. The app sits
    // behind a proxy that terminates TLS and strips the `/api` prefix, so
    // `req.originalUrl` (and any internal WEBHOOK_BASE_URL) can't reproduce that
    // signed URL. Prefer the explicit TWILIO_WEBHOOK_URL (the same value put in
    // the Twilio console); fall back to the old reconstruction only if it's unset.
    // Empty/whitespace (the compose default when unset) counts as absent.
    const configuredUrl =
      this.config.get('TWILIO_WEBHOOK_URL', { infer: true })?.trim() || undefined;
    const fullUrl =
      configuredUrl ??
      `${this.config.get('WEBHOOK_BASE_URL', { infer: true }) ?? ''}${req.originalUrl}`;
    const params = body ?? {};

    if (!this.wa.verifyTwilioSignature(fullUrl, params, signature)) {
      this.logger.warn(`twilio webhook rejected: bad signature ip=${req.ip}`);
      await this.audit.log(
        'webhook.signature_invalid',
        'WhatsappWebhook',
        undefined,
        {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          provider: 'twilio',
        },
      );
      throw new ForbiddenError(
        'Invalid Twilio signature',
        'webhook.invalid_twilio_signature',
      );
    }

    // Resolve which TWILIO channel this webhook belongs to from the `To`
    // number — a deploy can have several Twilio channels, so we can no longer
    // assume "the" default instance. Status callbacks are matched by
    // providerMessageId and don't strictly need the instance, but inbound chat
    // ingest (which requires an instanceId) does.
    const channel = await this.resolveTwilioChannel(body);
    if (!channel) {
      this.logger.warn(
        `twilio webhook: no TWILIO channel resolved (To=${String(body?.To ?? '?')}), processing status-acks only (no instanceId)`,
      );
      // Mesmo padrão de perda silenciosa que custou ~100 mensagens no Zernio: os
      // acks de status ainda passam (casam por providerMessageId), mas a
      // ingestão de chat exige instanceId e vira no-op — ou seja, TODO inbound
      // desse número é descartado sem deixar rastro na interface. Contamos o
      // drop para que a página Canais possa gritar.
      //
      // Só para INBOUND: um status callback não se perde aqui, e o `To` dele é o
      // número do cliente — registrá-lo geraria um alerta falso por destinatário.
      if (!this.isStatusCallback(body)) {
        await this.drops.record({
          provider: 'TWILIO',
          // Sem o prefixo `whatsapp:` — mesma chave que casa com Channel.phoneE164.
          accountRef: this.toE164(body) ?? 'desconhecido',
          event: 'inbound',
        });
      }
      // Status callbacks (delivered/read/failed — including opt-out-triggering
      // `failed`) match by providerMessageId and don't need an instanceId, so
      // we must not drop them just because the `To` didn't resolve a channel
      // (e.g. status callbacks carry the CUSTOMER's number in `To`, or a
      // deploy has 2+ TWILIO channels and the fallback is ambiguous). Chat
      // ingest is a no-op without an instanceId, so this is safe either way.
      await this.webhooks.process(body, undefined, 'TWILIO');
      return '<Response></Response>';
    }
    await this.webhooks.process(body, channel.id, 'TWILIO');

    // Twilio is happy with an empty TwiML response on 200.
    return '<Response></Response>';
  }
}
