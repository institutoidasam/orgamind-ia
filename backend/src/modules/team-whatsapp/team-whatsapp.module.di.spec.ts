import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { ChannelLiveStateService } from '../whatsapp-providers/channel-live-state.service';
import { TeamWhatsappService } from './team-whatsapp.service';

// O `ConfigModule.forRoot()` valida o env no IMPORT; `vi.hoisted` roda antes
// dos imports estáticos abaixo, então o env falso já existe quando o AppModule carrega.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'x'.repeat(32),
    APP_BASE_URL: 'https://picoa.test',
    WEBHOOK_BASE_URL: 'https://picoa.test',
    CORS_ORIGIN: 'https://picoa.test',
    ZERNIO_API_KEY: 'zk_test',
    ZERNIO_BASE_URL: 'https://zernio.test/api/v1',
    ZERNIO_WEBHOOK_SECRET: 'whsec_test',
  });
});

/**
 * O TeamWhatsappModule importa o WhatsappProvidersModule (porta do estado ao
 * vivo, D7). Ciclo de módulos ou provider fora de escopo não aparece em `tsc`
 * nem em teste unitário (todos usam `new`): só no boot da API. Aqui o grafo
 * compila (Prisma e Redis são dublês) e o serviço recebe a porta de verdade.
 */
describe('TeamWhatsappModule — o grafo de DI resolve (sem ciclo)', () => {
  it('compila o AppModule e injeta o ChannelLiveStateService no TeamWhatsappService', async () => {
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
    const builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $connect: vi.fn(), $disconnect: vi.fn(), $on: vi.fn() })
      .overrideProvider(REDIS_CLIENT)
      .useValue(fakeRedis);
    for (const name of Object.values(QUEUE_NAMES)) {
      builder.overrideProvider(getQueueToken(name)).useValue({
        add: vi.fn(),
        getJobs: vi.fn().mockResolvedValue([]),
        on: vi.fn(),
        close: vi.fn(),
      });
    }

    const moduleRef = await builder.compile();

    const team = moduleRef.get(TeamWhatsappService, { strict: false });
    expect((team as unknown as { live: unknown }).live).toBeInstanceOf(
      ChannelLiveStateService,
    );
  }, 60_000);
});
