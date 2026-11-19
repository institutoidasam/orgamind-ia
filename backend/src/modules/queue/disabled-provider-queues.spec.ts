import { describe, expect, it, vi } from 'vitest';
import { WorkerModule } from '../../worker.module';
import {
  DISABLED_PROVIDER_QUEUES,
  purgeDisabledProviderRepeatables,
  type RepeatableQueue,
} from './disabled-provider-queues';

/**
 * O `ConfigModule.forRoot()` VALIDA o env no ato do IMPORT do módulo, então o
 * env falso tem de existir ANTES do import do WorkerModule: `vi.hoisted` roda
 * antes dos imports estáticos deste arquivo.
 */
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'x'.repeat(32),
    APP_BASE_URL: 'https://picoa.test',
    WEBHOOK_BASE_URL: 'https://picoa.test',
    CORS_ORIGIN: 'https://picoa.test',
    // Ao menos um grupo de provedor tem de estar completo (Evolution).
    EVOLUTION_BASE_URL: 'https://evolution.test',
    EVOLUTION_API_KEY: 'evo_test',
    EVOLUTION_INSTANCE_NAME: 'orgamind',
  });
});

type FakeQueue = RepeatableQueue & {
  getRepeatableJobs: ReturnType<typeof vi.fn>;
  removeRepeatableByKey: ReturnType<typeof vi.fn>;
};

function fakeQueue(keys: string[]): FakeQueue {
  return {
    getRepeatableJobs: vi.fn(() =>
      Promise.resolve(keys.map((key) => ({ key }))),
    ),
    removeRepeatableByKey: vi.fn(() => Promise.resolve(true)),
  } as unknown as FakeQueue;
}

describe('purgeDisabledProviderRepeatables', () => {
  it('remove todos os repetíveis de cada fila desligada e devolve a contagem', async () => {
    const queues = new Map<string, FakeQueue>(
      DISABLED_PROVIDER_QUEUES.map((name, i) => [
        name,
        // Alterna 2 e 1 repetíveis por fila (a do ZERNIO_BROADCAST_SYNC tinha
        // dois no worker antigo: o espelho e o analytics).
        fakeQueue(i % 2 === 0 ? [`${name}:a`, `${name}:b`] : [`${name}:a`]),
      ]),
    );
    const getQueue = vi.fn((name: string) => queues.get(name)!);

    const result = await purgeDisabledProviderRepeatables(getQueue);

    expect(result.failed).toEqual([]);
    expect(Object.keys(result.removed).sort()).toEqual(
      [...DISABLED_PROVIDER_QUEUES].sort(),
    );
    DISABLED_PROVIDER_QUEUES.forEach((name, i) => {
      const queue = queues.get(name)!;
      expect(result.removed[name]).toBe(i % 2 === 0 ? 2 : 1);
      expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(
        result.removed[name],
      );
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith(`${name}:a`);
    });
  });
});

describe('purgeDisabledProviderRepeatables — falhas isoladas por fila', () => {
  it('falha numa fila não impede as demais; nome vai para failed', async () => {
    const [broken, ...healthy] = DISABLED_PROVIDER_QUEUES;
    const queues = new Map<string, FakeQueue>(
      DISABLED_PROVIDER_QUEUES.map((name) => [name, fakeQueue(['k'])]),
    );
    queues
      .get(broken)!
      .getRepeatableJobs.mockRejectedValueOnce(new Error('redis caiu'));

    const result = await purgeDisabledProviderRepeatables((name) =>
      queues.get(name)!,
    );

    expect(result.failed).toEqual([broken]);
    expect(result.removed[broken]).toBeUndefined();
    for (const name of healthy) {
      expect(result.removed[name]).toBe(1);
      expect(queues.get(name)!.removeRepeatableByKey).toHaveBeenCalledWith('k');
    }
  });

  it('getQueue lançando para uma fila → nome em failed, demais seguem', async () => {
    const [absent, ...healthy] = DISABLED_PROVIDER_QUEUES;
    const queues = new Map<string, FakeQueue>(
      healthy.map((name) => [name, fakeQueue(['k'])]),
    );
    const getQueue = (name: string): RepeatableQueue => {
      if (name === absent) throw new Error('Nest could not find the queue');
      return queues.get(name)!;
    };

    const result = await purgeDisabledProviderRepeatables(getQueue);

    expect(result.failed).toEqual([absent]);
    expect(Object.keys(result.removed).sort()).toEqual([...healthy].sort());
  });
});

describe('WorkerModule', () => {
  it('WorkerModule não registra processors dos desligados', () => {
    const providers = Reflect.getMetadata(
      'providers',
      WorkerModule,
    ) as unknown[];
    const names = providers.map((p) =>
      typeof p === 'function' ? p.name : String(p),
    );

    for (const gone of [
      'CheckTokenExpiryProcessor',
      'ZernioInboxSyncProcessor',
      'ZernioTierSyncProcessor',
      'ZernioBroadcastSendService',
      'ZernioBroadcastPollService',
      'ZernioBroadcastDispatchProcessor',
      'ZernioBroadcastPollProcessor',
      'ZernioBroadcastCancelProcessor',
    ]) {
      expect(names).not.toContain(gone);
    }
    // Sanidade: o que continua é registrado (o teste não passa por lista vazia).
    expect(names).toContain('SendMessageProcessor');
  });
});
