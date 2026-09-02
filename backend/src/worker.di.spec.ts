import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';

/**
 * O `ConfigModule.forRoot()` VALIDA o env no ato do IMPORT do módulo (não no
 * boot), então o env falso tem de existir ANTES de qualquer import do
 * WorkerModule. `vi.hoisted` roda antes de tudo; o WorkerModule entra por import
 * DINÂMICO, dentro do teste.
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
    // O grupo ZERNIO é tudo-ou-nada (o env.schema recusa um grupo pela metade —
    // é o que impede um deploy de subir "meio configurado" e falhar no 1º envio).
    ZERNIO_API_KEY: 'zk_test',
    ZERNIO_BASE_URL: 'https://zernio.test/api/v1',
    ZERNIO_WEBHOOK_SECRET: 'whsec_test',
  });
});

/**
 * ★ O GRAFO DE DI DO WORKER RESOLVE?
 *
 * Este teste existe por causa de um aviso literal no `worker.module.ts`:
 *
 *   "WhatsappProvidersModule → CampaignsModule fecharia um ciclo
 *    (CampaignsModule → TemplatesModule → WhatsappProvidersModule)"
 *
 * Um ciclo de módulos (ou um provider que o escopo não resolve) **não é pego pelo
 * `tsc` nem por nenhum teste unitário** — todos eles constroem os serviços com
 * `new`. O erro só aparece no BOOT do worker: o processo morre, e o efeito em
 * produção é que NENHUMA mensagem sai. Numa campanha eleitoral, no dia do
 * disparo, esse é o pior desfecho possível — e quem o descobriria seria o cliente.
 *
 * O `ZernioBroadcastSendService` precisa do `CampaignsRepository` (claim atômico,
 * releaseClaim, createSkippedMessage), então foi registrado no WorkerModule — o
 * único escopo onde CampaignsModule e WhatsappProvidersModule já convivem —,
 * exatamente como o `ZernioTierSyncProcessor` que o precedeu. Este teste é a prova
 * de que a escolha está certa.
 *
 * Prisma e Redis são dublês: o que se testa aqui é o GRAFO, não a rede.
 */
describe('WorkerModule — o grafo de DI resolve (sem ciclo)', () => {
  it('compila o WorkerModule e instancia os serviços de BROADCAST do Zernio', async () => {
    const { WorkerModule } = await import('./worker.module');
    const { PrismaService } = await import('./shared/prisma/prisma.service');
    const { REDIS_CLIENT } = await import('./shared/redis/redis.module');
    const { QUEUE_NAMES } = await import('./modules/queue/queue.constants');
    const { ZernioBroadcastSendService } = await import(
      './modules/whatsapp-providers/zernio-broadcast-send.service'
    );
    const { ZernioBroadcastPollService } = await import(
      './modules/whatsapp-providers/zernio-broadcast-poll.service'
    );
    const { CampaignsService } = await import(
      './modules/campaigns/campaigns.service'
    );

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

    const builder = Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(PrismaService)
      .useValue({ $connect: vi.fn(), $disconnect: vi.fn(), $on: vi.fn() })
      .overrideProvider(REDIS_CLIENT)
      .useValue(fakeRedis);

    // As filas do BullMQ abririam conexão de verdade com o Redis no boot. O que
    // interessa aqui é o GRAFO, então cada uma vira um dublê.
    for (const name of Object.values(QUEUE_NAMES)) {
      builder.overrideProvider(getQueueToken(name)).useValue({
        add: vi.fn(),
        getJobs: vi.fn(async () => []),
        on: vi.fn(),
        close: vi.fn(),
      });
    }

    const moduleRef = await builder.compile();

    // Se houvesse ciclo (ou um provider fora de escopo), o `compile()` acima já
    // teria explodido. Estas asserções provam que os serviços NOVOS existem de
    // verdade no grafo — não só que ele compilou.
    expect(moduleRef.get(ZernioBroadcastSendService)).toBeInstanceOf(
      ZernioBroadcastSendService,
    );
    expect(moduleRef.get(ZernioBroadcastPollService)).toBeInstanceOf(
      ZernioBroadcastPollService,
    );

    // ★ E que o CampaignsService REALMENTE recebeu as filas do broadcast.
    //
    // Elas são OPCIONAIS no construtor (os specs históricos constroem o serviço
    // posicionalmente), e é justamente isso que as tornaria fáceis de nunca serem
    // injetadas em produção — o kill-switch viraria um no-op SILENCIOSO: o
    // operador aperta "Cancelar", o orgamind diz que cancelou, e o Zernio continua
    // disparando. Esta asserção é o que impede esse desfecho.
    const campaigns = moduleRef.get(CampaignsService);
    expect(
      (campaigns as unknown as { broadcastDispatchQueue?: unknown })
        .broadcastDispatchQueue,
    ).toBeDefined();
    expect(
      (campaigns as unknown as { broadcastCancelQueue?: unknown })
        .broadcastCancelQueue,
    ).toBeDefined();

    await moduleRef.close();
  }, 60_000);
});
