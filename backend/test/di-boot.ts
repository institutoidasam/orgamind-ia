import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DiscoveryService } from '@nestjs/core';
import { Logger, type Type } from '@nestjs/common';

/**
 * Compartilhado por `src/app.di.spec.ts` e `src/worker.di.spec.ts`: compila o grafo de DI
 * REAL de um módulo raiz com dois ambientes de boot (§8 da spec somente-evolution).
 *
 * O `ConfigModule.forRoot()` valida o env no IMPORT do módulo, então cada caso
 * redefine o env e zera o cache de módulos ANTES de importar o módulo raiz
 * (por import dinâmico). Prisma e Redis são dublês: o que se prova é o GRAFO.
 */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'; // não exportada pelo @nestjs/bullmq

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  APP_BASE_URL: 'https://picoa.test',
  WEBHOOK_BASE_URL: 'https://picoa.test',
  CORS_ORIGIN: 'https://picoa.test',
  EVOLUTION_BASE_URL: 'http://evolution.test:8080',
  EVOLUTION_API_KEY: 'test-evolution-key',
  EVOLUTION_INSTANCE_NAME: 'test-instance',
};

export type BootEnvCase = {
  name: string;
  /** Chaves de provedores desligados presentes no env, na ordem do aviso. */
  extra: Record<string, string>;
  /** Nomes que o aviso de boot deve listar (vazio = nenhum aviso). */
  ignoredKeys: string[];
};

export const BOOT_ENV_CASES: BootEnvCase[] = [
  { name: 'só Evolution', extra: {}, ignoredKeys: [] },
  {
    name: 'Evolution + GOZAP completo + ZERNIO parcial',
    extra: {
      ZERNIO_API_KEY: 'zk_segredo_zernio',
      GOZAP_BASE_URL: 'https://gozap.test',
      GOZAP_ADMIN_TOKEN: 'admin_segredo_gozap',
      GOZAP_WEBHOOK_TOKEN: 'webhook_segredo_gozap',
      GOZAP_TOKEN_ENCRYPTION_KEY: 'k'.repeat(64),
    },
    ignoredKeys: [
      'ZERNIO_API_KEY',
      'GOZAP_BASE_URL',
      'GOZAP_ADMIN_TOKEN',
      'GOZAP_WEBHOOK_TOKEN',
      'GOZAP_TOKEN_ENCRYPTION_KEY',
    ],
  },
];

const PROVIDER_ENV_PREFIX = /^(META|TWILIO|ZERNIO|GOZAP)_/;
let envSnapshot: NodeJS.ProcessEnv | undefined;

/** Troca o env do processo pelo do caso; `restoreBootEnv` devolve o original. */
function applyBootEnv(extra: Record<string, string>): void {
  envSnapshot ??= { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (PROVIDER_ENV_PREFIX.test(key)) delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV, extra);
}

function restoreBootEnv(): void {
  if (!envSnapshot) return;
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  Object.assign(process.env, envSnapshot);
  envSnapshot = undefined;
}

/** Compila o módulo raiz com Prisma, Redis e filas BullMQ como dublês. */
async function compileBootGraph(
  load: () => Promise<Type<unknown>>,
): Promise<TestingModule> {
  vi.resetModules();
  const rootModule = await load();
  const { PrismaService } =
    await import('../src/shared/prisma/prisma.service.js');
  const { REDIS_CLIENT } = await import('../src/shared/redis/redis.module.js');
  const { QUEUE_NAMES } =
    await import('../src/modules/queue/queue.constants.js');

  const fakeRedis = {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    pttl: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
    duplicate: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  const builder = Test.createTestingModule({ imports: [rootModule] })
    .overrideProvider(PrismaService)
    .useValue({ $connect: vi.fn(), $disconnect: vi.fn(), $on: vi.fn() })
    .overrideProvider(REDIS_CLIENT)
    .useValue(fakeRedis);
  // As filas abririam conexão de verdade com o Redis; cada uma vira um dublê.
  for (const name of Object.values(QUEUE_NAMES)) {
    builder.overrideProvider(getQueueToken(name)).useValue({
      add: vi.fn(),
      getJobs: vi.fn().mockResolvedValue([]),
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
      removeRepeatableByKey: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    });
  }
  return builder.compile();
}

/** Nome da fila de cada provider descoberto que carrega `@Processor`. */
function processorQueueNames(moduleRef: TestingModule): string[] {
  const discovery = moduleRef.get(DiscoveryService, { strict: false });
  return discovery.getProviders().flatMap((wrapper) => {
    const options = wrapper.metatype
      ? (Reflect.getMetadata(PROCESSOR_METADATA, wrapper.metatype) as
          { name?: string } | undefined)
      : undefined;
    return options?.name ? [options.name] : [];
  });
}

const IGNORED_WARN = 'chaves de provedores desligados ignoradas';

/**
 * Suíte de boot dos dois ambientes (`BOOT_ENV_CASES`) para um módulo raiz:
 * compila uma vez por caso e prova (1) só a Evolution no registry, (2) nenhum
 * `@Processor` de fila exclusiva de provedor desligado (R8) e (3) o aviso de
 * chaves ignoradas uma única vez, só com os NOMES (GC6). `extra` acrescenta
 * as verificações próprias do módulo, sobre o mesmo grafo compilado.
 */
export function describeBootGraph(
  label: string,
  load: () => Promise<Type<unknown>>,
  extra: (getModule: () => TestingModule) => void,
): void {
  describe.each(BOOT_ENV_CASES)(`$name — ${label}`, (envCase) => {
    let moduleRef: TestingModule;
    let warn: MockInstance<Logger['warn']>;

    beforeAll(async () => {
      applyBootEnv(envCase.extra);
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      moduleRef = await compileBootGraph(load);
    }, 120_000);

    afterAll(async () => {
      await moduleRef?.close();
      warn?.mockRestore();
      restoreBootEnv();
    });

    it('compila e deixa só a Evolution no ProviderRegistry', async () => {
      const { ProviderRegistry } =
        await import('../src/modules/whatsapp-providers/provider-registry.service.js');
      const registry = moduleRef.get(ProviderRegistry, { strict: false });
      expect(registry.configured()).toEqual(['EVOLUTION']);
    });

    it('não registra nenhum @Processor de fila exclusiva de provedor desligado', async () => {
      const { DISABLED_PROVIDER_QUEUES } =
        await import('../src/modules/queue/disabled-provider-queues.js');
      const { QUEUE_NAMES } =
        await import('../src/modules/queue/queue.constants.js');
      // DV3: o `TemplateApprovalSyncProcessor` FICA registrado (R8 não lista a
      // fila `templates.approval-sync`); só o cron e o repetível dela saem (B8).
      const exclusive = new Set<string>([
        ...DISABLED_PROVIDER_QUEUES.filter(
          (name) => name !== QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC,
        ),
        QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH,
        QUEUE_NAMES.ZERNIO_BROADCAST_POLL,
        QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL,
      ]);
      const names = processorQueueNames(moduleRef);
      // Controle positivo: a descoberta enxerga processors de verdade.
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => exclusive.has(name))).toEqual([]);
    });

    it('avisa as chaves ignoradas uma vez, só com os nomes', () => {
      const messages = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes(IGNORED_WARN));
      if (envCase.ignoredKeys.length === 0) {
        expect(messages).toEqual([]);
        return;
      }
      expect(messages).toEqual([
        `${IGNORED_WARN}: ${envCase.ignoredKeys.join(', ')}`,
      ]);
      for (const value of Object.values(envCase.extra)) {
        expect(messages[0]).not.toContain(value);
      }
    });

    extra(() => moduleRef);
  });
}
