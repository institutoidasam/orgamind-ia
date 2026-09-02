// Sentry must be initialised before any other module is loaded so it can
// patch http/express/pg/etc. at require time.
import './sentry.instrument';
import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Redis from 'ioredis';
import { WorkerModule } from './worker.module';
import {
  QUEUE_NAMES,
  REPEATABLE_JOB_CLEANUP_OPTS,
} from './modules/queue/queue.constants';
import { ZERNIO_ANALYTICS_JOB } from './modules/whatsapp-providers/zernio-broadcast-sync.processor';
import { REDIS_CLIENT } from './shared/redis/redis.module';

/**
 * Readiness probe for the worker process. The worker has no HTTP request
 * pipeline, so we ping its dependencies directly. Redis is the hard dependency
 * (BullMQ cannot consume jobs without it); a worker that can't reach Redis is
 * doing no work and must report itself unready so the orchestrator can restart
 * or stop routing to it.
 */
export async function checkReadiness(
  redis: Redis | undefined,
): Promise<{ ready: boolean; redis: 'up' | 'down' }> {
  if (!redis) return { ready: false, redis: 'down' };
  try {
    await redis.ping();
    return { ready: true, redis: 'up' };
  } catch {
    return { ready: false, redis: 'down' };
  }
}

/**
 * Build the http request handler for the worker health server. Extracted so it
 * can be unit-tested without booting the whole Nest worker context.
 */
export function createHealthHandler(redis: Redis | undefined) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/health/ready') {
      const probe = await checkReadiness(redis);
      if (probe.ready) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', redis: probe.redis }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unavailable', redis: probe.redis }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

/**
 * Fix round 1 (revisão pós-commit, item #2(b)) — 06:00 UTC = 02:00 em
 * America/Manaus (o fuso do app, TIMEZONE_DEFAULT), FORA da janela de envio
 * padrão do canal (08h–20h). Todo `sync` que o cron enfileirava caía no gate
 * de janela do `ContactSyncProcessor` e — antes do item #2(a) também tratar
 * `triggeredBy: 'periodic'` como pulo gracioso — falhava TODA noite, sempre
 * na mesma hora. 13:00 UTC = 09:00 em Manaus: já dentro da janela padrão,
 * então o cron corre no mesmo horário "comercial" que a validação por
 * clique do operador respeita.
 *
 * Fix round 2 (revisão pós-commit, item #2 remanescente) — o BullMQ chaveia
 * repetíveis por `md5(name:jobId:endDate:tz:pattern)` (`Repeat.hash`, ver
 * `node_modules/bullmq/dist/.../repeat.js`). Trocar só o `pattern` na
 * chamada `add()` abaixo NÃO substitui o repetível antigo — CRIA um
 * segundo, com uma chave diferente, porque o `pattern` faz parte da chave.
 * Cada job processado do ZSET se re-arma sozinho, então o cron das 06:00 UTC
 * (fora da janela) continuaria rodando PARA SEMPRE ao lado do novo, de 13:00
 * UTC — dobrando o trabalho por nada e (se um dia o operador desligar a
 * janela de envio) disparando `/chat/check` de verdade às 02:00 no GoZap.
 * `removeRepeatable` com a MESMA tripla (`name`, `pattern`, `jobId`) do
 * registro antigo é a única forma de apagar aquela chave — e é seguro
 * chamar mesmo que a chave já não exista (o Lua script por trás dela é um
 * no-op nesse caso, não lança).
 *
 * Extraída de `bootstrap()` para ser testável sem abrir conexões reais com
 * Postgres/Redis (`bootstrap()` inteiro só roda fora do vitest — ver o guard
 * `if (!process.env.VITEST)` no fim deste arquivo); o chamador continua
 * responsável pelo try/catch (mesmo comportamento de antes desta extração).
 *
 * ★ REVISÃO FINAL DA FASE B (crítico) — o cron agora é OPT-IN (`enabled`,
 * alimentado por `CONTACT_SYNC_CRON_ENABLED`, padrão FALSE).
 *
 * Antes da Fase B, `contact-sync.processor.ts` voltava cedo quando não havia
 * canal EVOLUTION; produção só tem GoZap, então o cron diário era um no-op
 * SILENCIOSO — por acidente, não por decisão. A Fase B fez `resolveSyncChannel`
 * resolver o canal de SESSÃO padrão, e com isso o mesmo cron passaria a
 * enfileirar a BASE INTEIRA (`findIdsForSync('stale')`, teto de 5000) para o
 * `/chat/check` TODA NOITE, com ninguém clicando em nada. Consulta de
 * existência em massa por cliente NÃO OFICIAL é sinal conhecido de bloqueio, e
 * este cliente já perdeu um número. A decisão de produto (spec B.5) é que a
 * validação ativa é EXPLÍCITA — o operador clica depois de ler o aviso.
 *
 * DESLIGADO NÃO É "não chamar `add()`": um deploy que já rodou com o cron
 * ligado tem a chave gravada no ZSET de repetíveis, e cada job processado se
 * RE-ARMA sozinho — parar de agendar não apaga nada. Por isso o caminho
 * desligado ainda chama `removeRepeatable` para as DUAS gerações de pattern
 * conhecidas (`0 6 * * *` e `0 13 * * *`): o hash da chave é
 * `md5(name:jobId:endDate:tz:pattern)`, então cada pattern é uma chave
 * distinta. `removeRepeatable` é idempotente (no-op quando a chave não existe).
 */
export async function scheduleContactSyncCron(
  contactSyncCronQueue: Pick<Queue, 'removeRepeatable' | 'add'>,
  enabled = false,
): Promise<'scheduled' | 'disabled'> {
  await contactSyncCronQueue.removeRepeatable(
    'cron',
    { pattern: '0 6 * * *' },
    'contact-sync-cron-daily',
  );
  if (!enabled) {
    await contactSyncCronQueue.removeRepeatable(
      'cron',
      { pattern: '0 13 * * *' },
      'contact-sync-cron-daily',
    );
    return 'disabled';
  }
  await contactSyncCronQueue.add(
    'cron',
    {},
    {
      repeat: { pattern: '0 13 * * *' },
      jobId: 'contact-sync-cron-daily',
      ...REPEATABLE_JOB_CLEANUP_OPTS,
    },
  );
  return 'scheduled';
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const logger = app.get(Logger);
  logger.log('Worker started', 'Bootstrap');

  // Schedule the daily Meta token expiry check as a repeatable job. The
  // deterministic jobId guarantees only one repeatable definition exists
  // even across worker restarts.
  try {
    const tokenCheckQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.TOKEN_CHECK),
    );
    await tokenCheckQueue.add(
      'check-token-expiry',
      {},
      {
        repeat: { pattern: '0 9 * * *' }, // daily at 09:00 server time
        jobId: 'token-expiry-check',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log(
      'Scheduled repeatable Meta token expiry check (cron 0 9 * * *)',
      'Bootstrap',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to schedule token expiry check');
  }

  // Schedule the campaign scheduler tick. Runs every minute.
  try {
    const schedulerQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.CAMPAIGN_SCHEDULER),
    );
    await schedulerQueue.add(
      'tick',
      {},
      {
        repeat: { pattern: '* * * * *' },
        jobId: 'campaign-scheduler-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled campaign scheduler tick (every minute)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule campaign scheduler tick');
  }

  // Schedule the daily cleanup of old connection events (7-day retention).
  try {
    const cleanupQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.CLEANUP_EVENTS),
    );
    await cleanupQueue.add(
      'cleanup',
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 }, // every 24h
        jobId: 'cleanup-events-daily',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled cleanup-events repeatable (every 24h)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule cleanup-events');
  }

  try {
    const contactSyncCronQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.CONTACT_SYNC_CRON),
    );
    const config = app.get(ConfigService, { strict: false });
    const cronEnabled =
      config?.get<boolean>('CONTACT_SYNC_CRON_ENABLED') === true;
    const outcome = await scheduleContactSyncCron(
      contactSyncCronQueue,
      cronEnabled,
    );
    logger.log(
      outcome === 'scheduled'
        ? 'Scheduled contact-sync cron (daily 13:00 UTC = 09:00 Manaus; old 06:00 UTC repeatable removed)'
        : 'cron de validação desligado (CONTACT_SYNC_CRON_ENABLED) — repetíveis 06:00/13:00 UTC removidos; a validação ativa só roda por clique do operador',
      'Bootstrap',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to schedule contact-sync cron');
  }

  // Schedule the connection-state reconciler. Runs every 30 s to detect
  // instances whose stored lastConnectionState has drifted from the live
  // Evolution socket state (missed / out-of-order CONNECTION_UPDATE webhooks).
  try {
    const reconcilerQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.CONNECTION_RECONCILER),
    );
    await reconcilerQueue.add(
      'reconcile',
      {},
      {
        repeat: { every: 30_000 }, // every 30 seconds
        jobId: 'connection-reconciler-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled connection-reconciler tick (every 30s)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule connection-reconciler');
  }

  // O mesmo, para GOZAP — o reconciler acima é Evolution-only (pula todo canal
  // sem evolutionInstanceName). Sem este tick, um canal GoZap pareado nunca
  // ganha o WhatsappConnectionEvent('open') que o roteador exige e todo envio
  // para em WAITING_INSTANCE em silêncio (incidente 2026-08-07). 60s em vez de
  // 30s: cada tick é uma chamada ao SaaS do GoZap por canal.
  try {
    const gozapReconcilerQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.GOZAP_CONNECTION_RECONCILER),
    );
    await gozapReconcilerQueue.add(
      'reconcile-gozap',
      {},
      {
        repeat: { every: 60_000 },
        jobId: 'gozap-connection-reconciler-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log(
      'Scheduled gozap-connection-reconciler tick (every 60s)',
      'Bootstrap',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to schedule gozap-connection-reconciler');
  }

  // A REDE das mensagens estacionadas. Varre pelo lado das MENSAGENS, não dos
  // canais — nenhum filtro de provedor pode esconder uma parada de si mesma.
  // 5min: é rede, não mecanismo principal (o caminho do provedor solta na hora
  // em que o canal volta). Ver parked-messages-sweeper.processor.ts.
  try {
    const parkedSweepQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.PARKED_MESSAGES_SWEEP),
    );
    await parkedSweepQueue.add(
      'sweep-parked',
      {},
      {
        repeat: { every: 300_000 },
        jobId: 'parked-messages-sweep-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled parked-messages-sweep tick (every 5min)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule parked-messages-sweep');
  }

  // Schedule the SENDING reconciler (A2). Runs every 2 min to recover message
  // rows stranded in SENDING by a worker crash between the atomic claim and
  // markSent. The deterministic jobId keeps a single repeatable definition
  // even across worker restarts.
  try {
    const sendingReconcilerQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.SENDING_RECONCILER),
    );
    await sendingReconcilerQueue.add(
      'reconcile-sending',
      {},
      {
        repeat: { every: 2 * 60 * 1000 }, // every 2 minutes
        jobId: 'sending-reconciler-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled sending-reconciler tick (every 2min)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule sending-reconciler');
  }

  // Schedule the Twilio template approval sync. Twilio has NO approval
  // webhook — polling GET /v1/ContentAndApprovals every 2 min is the
  // canonical way to learn a template was approved/rejected/paused
  // (see TemplateApprovalSyncProcessor).
  try {
    const templateSyncQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC),
    );
    await templateSyncQueue.add(
      'sync-approvals',
      {},
      {
        repeat: { every: 120_000 }, // every 2 minutes
        jobId: 'template-approval-sync-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log(
      'Scheduled template-approval-sync tick (every 2min)',
      'Bootstrap',
    );
  } catch (err) {
    logger.error({ err }, 'Failed to schedule template-approval-sync');
  }

  // Schedule the daily Twilio tier sync (T8). The Meta tier (unique users /
  // rolling 24h) changes without any webhook — the Senders API v2
  // (`properties.messaging_limit`) is the canonical read; the processor
  // updates each TWILIO channel's dailySendLimit when it differs.
  try {
    const tierSyncQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.TWILIO_TIER_SYNC),
    );
    await tierSyncQueue.add(
      'sync-tiers',
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 }, // every 24h
        jobId: 'twilio-tier-sync-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled twilio-tier-sync tick (every 24h)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule twilio-tier-sync');
  }

  // ZA2 — tier-sync diário do Zernio. O tier da Meta (usuários ÚNICOS / 24h
  // ROLANTES) e o qualityRating mudam SEM webhook; `GET /accounts` é a leitura
  // canônica. O processor atualiza o dailySendLimit do canal ZERNIO e reage à
  // queda de qualidade. 24h (e não minutos) porque cada chamada consome o mesmo
  // balde de 60 req/min que o ENVIO usa.
  try {
    const zernioTierQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_TIER_SYNC),
    );
    await zernioTierQueue.add(
      'sync-tiers',
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 }, // a cada 24h
        jobId: 'zernio-tier-sync-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled zernio-tier-sync tick (every 24h)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule zernio-tier-sync');
  }

  // ZC — reconciliação do catálogo de templates do Zernio. É a REDE DE
  // SEGURANÇA; o caminho normal é o webhook `whatsapp.template.status_updated`,
  // que atualiza o status na hora. O tick de 1h (contra os 2 MINUTOS do
  // template-approval-sync da Twilio, que não tem webhook de aprovação nenhum) é
  // deliberado: o balde do Zernio é de 60 req/min POR CHAVE e é o MESMO balde do
  // ENVIO — um sync agressivo roubaria vazão da campanha.
  try {
    const zernioTemplateQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_TEMPLATE_SYNC),
    );
    await zernioTemplateQueue.add(
      'sync-templates',
      {},
      {
        repeat: { every: 60 * 60 * 1000 }, // a cada 1h
        jobId: 'zernio-template-sync-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled zernio-template-sync tick (every 1h)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule zernio-template-sync');
  }

  // Sync do inbox do Zernio (a cada 10 min). O webhook cobre o caminho ao vivo;
  // este tick é a REDE DE SEGURANÇA — traz o que foi enviado/respondido pelo
  // PAINEL do Zernio (fora do orgamind) e o que o webhook porventura perdeu. É
  // idempotente (dedupe por wamid), então um tick sem novidade não faz nada.
  try {
    const zernioInboxQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_INBOX_SYNC),
    );
    await zernioInboxQueue.add(
      'sync-inbox',
      {},
      {
        repeat: { every: 10 * 60 * 1000 }, // a cada 10 minutos
        jobId: 'zernio-inbox-sync-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled zernio-inbox-sync tick (every 10min)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule zernio-inbox-sync');
  }

  // ZD — espelho dos disparos do Zernio (a cada 15 min). É o que responde ao
  // pedido do cliente: ele dispara PELO PAINEL do Zernio e o orgamind ficava cego.
  // NÃO existe webhook de broadcast — aqui o polling é o único caminho, e por
  // isso ele é espaçado (15 min) e CEDE o balde para qualquer campanha ativa.
  try {
    const zernioBroadcastQueue = app.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_BROADCAST_SYNC),
    );
    await zernioBroadcastQueue.add(
      'sync-broadcasts',
      {},
      {
        repeat: { every: 15 * 60 * 1000 }, // a cada 15 minutos
        jobId: 'zernio-broadcast-sync-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled zernio-broadcast-sync tick (every 15min)', 'Bootstrap');

    // ZD — snapshot DIÁRIO do volume de mensagens (`GET /analytics/inbox/volume`).
    // MESMA fila do espelho de disparos, de propósito: os dois bebem do mesmo
    // balde de 60 req/min, e `concurrency: 1` numa fila só garante que nunca
    // rodem em paralelo. Diário porque a leitura é de 1 requisição por canal e
    // a janela relida é de 7 dias — o `read` de uma mensagem chega quando a
    // pessoa abre o WhatsApp, às vezes dias depois.
    await zernioBroadcastQueue.add(
      ZERNIO_ANALYTICS_JOB,
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 }, // a cada 24h
        jobId: 'zernio-analytics-sync-tick',
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log('Scheduled zernio-analytics-sync tick (every 24h)', 'Bootstrap');
  } catch (err) {
    logger.error({ err }, 'Failed to schedule zernio-broadcast-sync');
  }

  // Lightweight health server. /health/ready now reflects real dependency
  // health (Redis ping) instead of always returning 200.
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
  const redis = app.get<Redis>(REDIS_CLIENT, { strict: false });
  const healthHandler = createHealthHandler(redis);
  const healthServer = http.createServer((req, res) => {
    void healthHandler(req, res).catch((err) => {
      logger.error({ err }, 'Health handler error');
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unavailable' }));
      }
    });
  });
  healthServer.listen(port, () =>
    logger.log(`Worker health server on :${port}`, 'Bootstrap'),
  );

  // Cleanup
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down...`, 'Bootstrap');
    healthServer.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // The worker has no HTTP filter, so rely on process-level handlers to
  // forward unhandled errors to Sentry. We deliberately do not exit here —
  // the container supervisor (Docker / compose) decides if a restart is
  // warranted, and BullMQ's own retry semantics handle per-job failures.
  process.on('unhandledRejection', (reason) => {
    Sentry.captureException(reason);
    logger.error({ reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    Sentry.captureException(err);
    logger.error({ err }, 'uncaughtException');
  });
}
// Don't boot the worker when this module is imported by the test runner —
// the exported helpers (checkReadiness/createHealthHandler) must be importable
// in isolation.
if (!process.env.VITEST) {
  void bootstrap();
}
