import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import {
  DISABLED_PROVIDER_QUEUES,
  purgeDisabledProviderRepeatables,
} from './disabled-provider-queues';
import { QUEUE_NAMES, REPEATABLE_JOB_CLEANUP_OPTS } from './queue.constants';

const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

const DAY = 24 * 60 * 60 * 1000;

type Seed = {
  queue: string;
  name: string;
  repeat: { every: number } | { pattern: string };
  jobId: string;
};

/**
 * Os `add(name, {}, { repeat, jobId, ...REPEATABLE_JOB_CLEANUP_OPTS })` do
 * `worker.ts` ANTERIOR à remoção, copiados literalmente. É o formato legado
 * que `getRepeatableJobs` precisa enxergar.
 */
const OLD_WORKER_SEEDS: Seed[] = [
  {
    queue: QUEUE_NAMES.TOKEN_CHECK,
    name: 'check-token-expiry',
    repeat: { pattern: '0 9 * * *' },
    jobId: 'token-expiry-check',
  },
  {
    queue: QUEUE_NAMES.GOZAP_CONNECTION_RECONCILER,
    name: 'reconcile-gozap',
    repeat: { every: 60_000 },
    jobId: 'gozap-connection-reconciler-tick',
  },
  {
    queue: QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC,
    name: 'sync-approvals',
    repeat: { every: 120_000 },
    jobId: 'template-approval-sync-tick',
  },
  {
    queue: QUEUE_NAMES.TWILIO_TIER_SYNC,
    name: 'sync-tiers',
    repeat: { every: DAY },
    jobId: 'twilio-tier-sync-tick',
  },
  {
    queue: QUEUE_NAMES.ZERNIO_TIER_SYNC,
    name: 'sync-tiers',
    repeat: { every: DAY },
    jobId: 'zernio-tier-sync-tick',
  },
  {
    queue: QUEUE_NAMES.ZERNIO_TEMPLATE_SYNC,
    name: 'sync-templates',
    repeat: { every: 60 * 60 * 1000 },
    jobId: 'zernio-template-sync-tick',
  },
  {
    queue: QUEUE_NAMES.ZERNIO_INBOX_SYNC,
    name: 'sync-inbox',
    repeat: { every: 10 * 60 * 1000 },
    jobId: 'zernio-inbox-sync-tick',
  },
  {
    queue: QUEUE_NAMES.ZERNIO_BROADCAST_SYNC,
    name: 'sync-broadcasts',
    repeat: { every: 15 * 60 * 1000 },
    jobId: 'zernio-broadcast-sync-tick',
  },
  {
    // Mesma fila do espelho de disparos: ZERNIO_ANALYTICS_JOB = 'sync-analytics'.
    queue: QUEUE_NAMES.ZERNIO_BROADCAST_SYNC,
    name: 'sync-analytics',
    repeat: { every: DAY },
    jobId: 'zernio-analytics-sync-tick',
  },
  {
    // Fila que CONTINUA ativa: o purge não pode encostar nela.
    queue: QUEUE_NAMES.CONNECTION_RECONCILER,
    name: 'reconcile',
    repeat: { every: 30_000 },
    jobId: 'connection-reconciler-tick',
  },
];

function sum(removed: Record<string, number>): number {
  return Object.values(removed).reduce((total, n) => total + n, 0);
}

/**
 * Sobe o Redis, abre as filas (as desligadas + a que continua ativa) em
 * `queues` e semeia os repetíveis como o worker antigo os deixava.
 */
async function startRedisWithOldSeeds(
  queues: Map<string, Queue>,
): Promise<StartedRedisContainer> {
  const container = await new RedisContainer('redis:7-alpine').start();
  const connection = {
    host: container.getHost(),
    port: container.getMappedPort(6379),
  };
  const names = new Set([
    ...DISABLED_PROVIDER_QUEUES,
    QUEUE_NAMES.CONNECTION_RECONCILER,
  ]);
  for (const name of names) {
    queues.set(name, new Queue(name, { connection }));
  }
  for (const seed of OLD_WORKER_SEEDS) {
    await queues.get(seed.queue)!.add(
      seed.name,
      {},
      {
        repeat: seed.repeat,
        jobId: seed.jobId,
        ...REPEATABLE_JOB_CLEANUP_OPTS,
      },
    );
  }
  return container;
}

/** Sanidade: o semeado existe e o próximo tick de cada um está agendado. */
async function expectSeededRepeatablesScheduled(
  queueOf: (name: string) => Queue,
): Promise<void> {
  for (const name of DISABLED_PROVIDER_QUEUES) {
    expect((await queueOf(name).getRepeatableJobs()).length).toBeGreaterThan(0);
    expect(await queueOf(name).getDelayedCount()).toBeGreaterThan(0);
  }
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'purgeDisabledProviderRepeatables (Redis real)',
  () => {
    let container: StartedRedisContainer;
    const queues = new Map<string, Queue>();

    const queueOf = (name: string): Queue => {
      const queue = queues.get(name);
      if (!queue) throw new Error(`fila ${name} não aberta no teste`);
      return queue;
    };

    beforeAll(async () => {
      container = await startRedisWithOldSeeds(queues);
    }, 120_000);

    afterAll(async () => {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      await container?.stop();
    }, 60_000);

    it('cenário 3: repetíveis semeados como o worker antigo somem; o repetível do CONNECTION_RECONCILER fica', async () => {
      await expectSeededRepeatablesScheduled(queueOf);

      const result = await purgeDisabledProviderRepeatables(queueOf);

      expect(result.failed).toEqual([]);
      // 8 filas, 9 repetíveis: o ZERNIO_BROADCAST_SYNC tinha dois.
      expect(sum(result.removed)).toBe(9);
      expect(result.removed[QUEUE_NAMES.ZERNIO_BROADCAST_SYNC]).toBe(2);
      for (const name of DISABLED_PROVIDER_QUEUES) {
        expect(await queueOf(name).getRepeatableJobs()).toEqual([]);
        // O próximo job do repetível não pode ficar para trás.
        expect(await queueOf(name).getDelayedCount()).toBe(0);
      }

      const reconciler = queueOf(QUEUE_NAMES.CONNECTION_RECONCILER);
      expect(await reconciler.getRepeatableJobs()).toHaveLength(1);
      expect(await reconciler.getDelayedCount()).toBeGreaterThan(0);
    });

    it('segunda execução remove 0 (idempotente)', async () => {
      const result = await purgeDisabledProviderRepeatables(queueOf);

      expect(result.failed).toEqual([]);
      expect(sum(result.removed)).toBe(0);
    });
  },
);
