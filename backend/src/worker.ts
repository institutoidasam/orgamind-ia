// Sentry must be initialised before any other module is loaded so it can
// patch http/express/pg/etc. at require time.
import './sentry.instrument';
import * as Sentry from '@sentry/nestjs';
import type { INestApplicationContext } from '@nestjs/common';
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
import { purgeDisabledProviderRepeatables } from './modules/queue/disabled-provider-queues';
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

/**
 * Repeatable `tick` every minute on `queue`, with a deterministic jobId (one
 * definition across restarts). A failure is logged and does not stop the boot.
 */
async function scheduleMinuteTick(
  app: INestApplicationContext,
  logger: Logger,
  tick: { queue: string; jobId: string; label: string },
): Promise<void> {
  try {
    const queue = app.get<Queue>(getQueueToken(tick.queue));
    await queue.add(
      'tick',
      {},
      {
        repeat: { pattern: '* * * * *' },
        jobId: tick.jobId,
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
    logger.log(`Scheduled ${tick.label} tick (every minute)`, 'Bootstrap');
  } catch (err: unknown) {
    logger.error({ err }, `Failed to schedule ${tick.label} tick`);
  }
}

/**
 * Verificador de presos do envio da equipe (Lote H, DH4): a cada 5 min, com
 * jobId fixo (uma definição só entre reinícios) e a limpeza explícita de todo
 * repetível. Falha logada sem parar o boot.
 */
async function scheduleTeamStuckReconciler(
  app: INestApplicationContext,
  logger: Logger,
): Promise<void> {
  const label = 'team WhatsApp stuck-reconciler';
  try {
    await app
      .get<Queue>(getQueueToken(QUEUE_NAMES.TEAM_WHATSAPP_STUCK_RECONCILER))
      .add(
        'reconcile-stuck',
        {},
        {
          repeat: { every: 300_000 },
          jobId: 'team-whatsapp-stuck-reconciler',
          ...REPEATABLE_JOB_CLEANUP_OPTS,
        },
      );
    logger.log(`Scheduled ${label} tick (every 5min)`, 'Bootstrap');
  } catch (err: unknown) {
    logger.error({ err }, `Failed to schedule ${label}`);
  }
}

/**
 * Boot-time cleanup of the repeatables the old worker scheduled for the
 * providers that are now off (Meta/Twilio/GoZap/Zernio). Not scheduling them
 * anymore is not enough: their keys live in Redis and re-arm themselves. A
 * failure is logged and does not stop the boot.
 */
async function purgeDisabledProviderQueues(
  app: INestApplicationContext,
  logger: Logger,
): Promise<void> {
  try {
    const { removed, failed } = await purgeDisabledProviderRepeatables((name) =>
      app.get<Queue>(getQueueToken(name)),
    );
    const total = Object.values(removed).reduce((sum, n) => sum + n, 0);
    if (total > 0) {
      logger.log(
        `Removed ${total} repeatable(s) of disabled-provider queues: ${JSON.stringify(removed)}`,
        'Bootstrap',
      );
    }
    if (failed.length > 0) {
      logger.warn(
        `Could not clean repeatables of disabled-provider queues: ${failed.join(', ')}`,
        'Bootstrap',
      );
    }
  } catch (err: unknown) {
    logger.error({ err }, 'Failed to clean disabled-provider repeatables');
  }
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const logger = app.get(Logger);
  logger.log('Worker started', 'Bootstrap');

  // Scheduler ticks that run every minute: campaigns, and the team WhatsApp
  // scheduled send (envio agendado para o início do turno; the claim in the
  // repository makes each fire idempotent).
  await scheduleMinuteTick(app, logger, {
    queue: QUEUE_NAMES.CAMPAIGN_SCHEDULER,
    jobId: 'campaign-scheduler-tick',
    label: 'campaign scheduler',
  });
  await scheduleMinuteTick(app, logger, {
    queue: QUEUE_NAMES.TEAM_WHATSAPP_SCHEDULER,
    jobId: 'team-whatsapp-scheduler-tick',
    label: 'team WhatsApp scheduler',
  });
  await scheduleTeamStuckReconciler(app, logger);
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

  await purgeDisabledProviderQueues(app, logger);

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
