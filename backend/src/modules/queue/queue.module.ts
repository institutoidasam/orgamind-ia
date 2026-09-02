import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QUEUE_NAMES } from './queue.constants';
import type { Env } from '../../shared/config/env.schema';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>) => ({
        connection: {
          host: config.get('REDIS_HOST', { infer: true }),
          port: config.get('REDIS_PORT', { infer: true }),
        },
      }),
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.WHATSAPP_SEND,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.TOKEN_CHECK,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 86400, count: 50 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CAMPAIGN_SCHEDULER,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 60 },
        removeOnFail: { age: 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CLEANUP_EVENTS,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 86400, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CONTACT_SYNC,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CONTACT_SYNC_CRON,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86400, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CHAT_MEDIA_DOWNLOAD,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CHAT_HISTORY_SYNC,
      defaultJobOptions: { attempts: 1, removeOnComplete: { age: 86400, count: 20 }, removeOnFail: { age: 7 * 86400 } },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.CONNECTION_RECONCILER,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.SENDING_RECONCILER,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.TWILIO_TIER_SYNC,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    // ZA2 — tier-sync diário do Zernio (messagingLimitTier → dailySendLimit +
    // qualityRating). attempts: 1: o tick é diário e cada tentativa consome o
    // MESMO balde de 60 req/min do envio.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_TIER_SYNC,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    // Backfill/rede de segurança da inbox do Zernio. attempts: 1 — o tick é a
    // cada 10 min e o sync é idempotente; repetir a mesma falha 3x só empilha
    // chamadas ao Zernio sem trazer nada de novo.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_INBOX_SYNC,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    // ZD — espelho dos disparos do Zernio + snapshot diário de volume.
    // attempts: 1 — o tick é a cada 15 min e o sync é idempotente (upsert por
    // zernioId); repetir a mesma falha 3x só empilha chamadas ao Zernio.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_BROADCAST_SYNC,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 10 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    BullModule.registerQueue({
      name: QUEUE_NAMES.BOT_REPLY,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    }),
    // ★ ZB — o DISPARO do broadcast do Zernio.
    //
    // `attempts: 2`, e o número é uma decisão sobre DINHEIRO E BAN, não sobre
    // robustez. NENHUM endpoint de broadcast do Zernio aceita `Idempotency-Key`:
    // se o `POST /send` for aceito e a resposta se perder (timeout), a retentativa
    // NÃO é neutra — ela pode disparar o mesmo lote de novo, cobrado e entregue
    // duas vezes. Entrega duplicada é sinal de spam, e este número já teve display
    // name reprovado pela Meta. O serviço devolve as mensagens para QUEUED e
    // cancela o rascunho antes de subir o erro, então UMA retentativa cobre a
    // falha honesta (rede caiu antes de criar o disparo); mais do que isso é
    // apostar contra a ausência de idempotência.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
    // ZB — o POLLING do status por destinatário. `attempts: 1`: o próprio
    // serviço se reagenda com backoff (e sabe DESISTIR); uma retentativa do
    // BullMQ por cima disso só dobraria o consumo do balde de 60 req/min — que é
    // o MESMO do envio.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_BROADCAST_POLL,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 50 },
        removeOnFail: { age: 86400 },
      },
    }),
    // ★ ZB — o KILL-SWITCH. `attempts: 5`, o mais teimoso da casa, e de propósito:
    // este job é o que PARA um disparo em voo quando a conta é bloqueada (131031)
    // ou o template é pausado (132015). Desistir dele cedo significa deixar o
    // Zernio continuar mandando. Cancelar duas vezes é inofensivo (o `/cancel` de
    // um disparo já cancelado devolve erro, que o cliente trata como `false`);
    // não cancelar, não é.
    BullModule.registerQueue({
      name: QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 86400, count: 50 },
        removeOnFail: { age: 7 * 86400 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
