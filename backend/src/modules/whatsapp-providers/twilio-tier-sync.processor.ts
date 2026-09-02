import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  TwilioSendersService,
  parseMessagingLimit,
} from './twilio-senders.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * Tier sync diário (T8, twilio-platform).
 *
 * O tier da Meta (250 → 1k → 10k → 100k → ilimitado, usuários ÚNICOS/24h)
 * sobe/desce sem webhook — a leitura canônica é a Senders API v2
 * (`GET /v2/Channels/Senders?Channel=whatsapp` → `properties.messaging_limit`).
 * Este job repetível (24h, registrado no worker.ts) casa cada sender por
 * phoneE164 com os canais TWILIO ativos e, quando o limite difere do
 * dailySendLimit do canal, atualiza + audita ('channel.tier_sync').
 * "Unavailable"/desconhecido → NÃO mexe (portfólio não verificado ainda não
 * expõe o limite; o valor configurado no canal prevalece).
 *
 * Mesmo padrão do template-approval-sync: concurrency 1, try/catch por item
 * (um canal ruim não aborta o loop), log-resumo por tick.
 */
@Processor(QUEUE_NAMES.TWILIO_TIER_SYNC, { concurrency: 1 })
export class TwilioTierSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(TwilioTierSyncProcessor.name);

  constructor(
    private readonly senders: TwilioSendersService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(): Promise<void> {
    // Deploy sem o grupo de credenciais Twilio → nada a sincronizar (e sem
    // 401 diário contra a Senders API).
    if (!this.senders.configured) return;

    const channels = await this.prisma.channel.findMany({
      where: { provider: 'TWILIO', isActive: true },
    });
    if (channels.length === 0) return;

    // Uma falha aqui lança e falha o tick (BullMQ registra) — melhor do que
    // rodar o loop com um catálogo parcial.
    const senders = await this.senders.listSenders();
    const byPhone = new Map(senders.map((s) => [s.phoneE164, s]));

    let updated = 0;
    let unchanged = 0;
    let unmatched = 0;
    for (const channel of channels) {
      try {
        const sender = channel.phoneE164
          ? byPhone.get(channel.phoneE164)
          : undefined;
        if (!sender) {
          unmatched++;
          continue;
        }
        const limit = parseMessagingLimit(sender.messagingLimit);
        // null = "Unavailable"/desconhecido → não mexe no canal.
        if (limit === null || limit === channel.dailySendLimit) {
          unchanged++;
          continue;
        }
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: { dailySendLimit: limit },
        });
        // Actor null — mudança automática vinda da Twilio/Meta.
        await this.audit.log('channel.tier_sync', 'Channel', channel.id, {
          previousLimit: channel.dailySendLimit,
          newLimit: limit,
          messagingLimit: sender.messagingLimit,
          qualityRating: sender.qualityRating,
          senderSid: sender.sid,
        });
        updated++;
        this.logger.log(
          `twilio-tier-sync: canal ${channel.id} (${channel.phoneE164}) dailySendLimit ${channel.dailySendLimit} → ${limit} (messaging_limit="${sender.messagingLimit}")`,
        );
      } catch (err) {
        this.logger.warn(
          `twilio-tier-sync: erro sincronizando canal ${channel.id}: ${
            err instanceof Error ? err.message : String(err)
          } — pulando`,
        );
      }
    }

    this.logger.log(
      `twilio-tier-sync: channels=${channels.length} updated=${updated} unchanged=${unchanged} unmatched=${unmatched}`,
    );
  }
}
