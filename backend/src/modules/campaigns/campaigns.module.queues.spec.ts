import { describe, it, expect } from 'vitest';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { CampaignsModule } from './campaigns.module';
import { WhatsappProvidersModule } from '../whatsapp-providers/whatsapp-providers.module';
import { QueueModule } from '../queue/queue.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * K1/K5 (auditoria 2026-08-19) — O `registerQueue` PELADO DO CampaignsModule.
 *
 * Um `registerQueue` sem `defaultJobOptions` cria uma SEGUNDA instância de
 * Queue para o mesmo nome e SOMBREIA a configuração global do QueueModule. É
 * essa instância que o CampaignsService injeta — ou seja, é ela que enfileira
 * TODO envio de campanha. Consequências medidas:
 *
 *  • `attempts` sumia. O caminho retryável do worker faz `releaseClaim`
 *    (SENDING→QUEUED) e RELANÇA, contando com a retentativa do BullMQ. Sem
 *    `attempts`, o job falha e ninguém o pega de novo: a mensagem fica QUEUED
 *    PARA SEMPRE, sem job. Nenhum sweeper cobre esse estado (o de mensagens
 *    paradas só varre WAITING_INSTANCE), `countInFlight` a conta como em voo,
 *    e a campanha fica "Em execução" eternamente, com o botão de redisparo
 *    recusando por I10. O operador não tem botão que destrave.
 *  • `removeOnComplete`/`removeOnFail` sumiam junto: uma campanha de 13.400
 *    pessoas deixava 13.400 hashes de job permanentes no MESMO Redis que
 *    guarda os locks de campanha, o pacing e os contadores de tier.
 *
 * Este teste lê as importações BullMQ REAIS do CampaignsModule e as monta ao
 * lado da configuração global, reproduzindo a fiação de produção.
 */
const REDIS_HOST = process.env.REDIS_HOST ?? 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const campaignsBullImports = (
  Reflect.getMetadata('imports', CampaignsModule) as unknown[]
).filter(
  (m): m is { module: unknown } =>
    typeof m === 'object' &&
    m !== null &&
    (m as { module?: unknown }).module === BullModule,
);

/**
 * ★ 2ª rodada — O TESTE LÊ O `queue.module.ts` DE VERDADE.
 *
 * Antes, a "configuração global" era COPIADA À MÃO aqui como literais. Um teste
 * assim mede a cópia, não o sistema: se alguém baixasse o `attempts` global do
 * envio de 5 para 1 — exatamente a regressão que este arquivo existe para
 * pegar — ele continuaria VERDE. Agora quem fornece a política global é o
 * `QueueModule` real (@Global, `exports: [BullModule]`), montado ao lado das
 * importações reais do `CampaignsModule`: é a fiação de produção, e os números
 * abaixo são afirmações sobre ELA.
 */
async function mountWithGlobal() {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [() => ({ REDIS_HOST, REDIS_PORT })],
      }),
      // A configuração GLOBAL, lida da fonte (queue.module.ts).
      QueueModule,
      // As registrações do próprio CampaignsModule — o que está sob teste.
      ...(campaignsBullImports as never[]),
    ],
  }).compile();
}

describe('CampaignsModule — registro das filas BullMQ', () => {
  /**
   * O CampaignsModule não pode registrar a fila de ENVIO: registrá-la aqui cria
   * uma SEGUNDA instância de Queue para o mesmo nome e sombreia a política
   * global — e é essa instância que o CampaignsService injeta.
   */
  it('não registra mais a fila de ENVIO (quem manda nela é o QueueModule)', () => {
    const nomes = campaignsBullImports.map(
      (m) =>
        (
          (m as { providers?: { provide?: unknown }[] }).providers?.find((p) =>
            typeof p?.provide === 'string' ? p.provide.includes('Bull') : false,
          ) ?? {}
        ).provide,
    );
    expect(nomes).not.toContain(getQueueToken(QUEUE_NAMES.WHATSAPP_SEND));
    expect(nomes).not.toContain(
      getQueueToken(QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL),
    );
  });

  it('K1 — a fila de ENVIO mantém a política global de retentativa (attempts 5)', async () => {
    const moduleRef = await mountWithGlobal();
    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.WHATSAPP_SEND),
    );
    try {
      expect(queue.defaultJobOptions?.attempts).toBe(5);
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });

  it('K5 — a fila de ENVIO mantém a limpeza (jobs de campanha não vazam no Redis)', async () => {
    const moduleRef = await mountWithGlobal();
    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.WHATSAPP_SEND),
    );
    try {
      expect(queue.defaultJobOptions?.removeOnComplete).toBeDefined();
      expect(queue.defaultJobOptions?.removeOnFail).toBeDefined();
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });

  /**
   * O KILL-SWITCH do broadcast (`attempts: 5`, o mais teimoso da casa) existe
   * para PARAR um disparo em voo quando a conta é bloqueada ou o template é
   * pausado. Sombreado, ele desistia na primeira tentativa — e desistir aqui
   * significa deixar o Zernio continuar mandando.
   */
  it('o CANCELAMENTO do broadcast mantém a teimosia da política global (attempts 5)', async () => {
    const moduleRef = await mountWithGlobal();
    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL),
    );
    try {
      expect(queue.defaultJobOptions?.attempts).toBe(5);
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });

  /**
   * A EXCEÇÃO, e ela é deliberada: o disparo de broadcast continua com
   * `attempts: 1`. Nenhum endpoint de broadcast do Zernio aceita
   * `Idempotency-Key`; se o `POST /send` for aceito e a resposta se perder, a
   * retentativa REDISPARA o lote inteiro — a mesma pessoa recebendo duas vezes.
   * Antes isso valia por ACIDENTE (o registro pelado zerava `attempts`); agora
   * está escrito, e a limpeza no Redis vem junto.
   */
  it('o DISPARO por broadcast continua sem retentativa — mas agora de propósito, e com limpeza', async () => {
    const moduleRef = await mountWithGlobal();
    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH),
    );
    try {
      expect(queue.defaultJobOptions?.attempts).toBe(1);
      expect(queue.defaultJobOptions?.removeOnComplete).toBeDefined();
      expect(queue.defaultJobOptions?.removeOnFail).toBeDefined();
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });
});

/**
 * ★ I16 DA REVISÃO DE INTEGRAÇÃO — O MESMO BURACO, NO OUTRO MÓDULO.
 *
 * O bloco acima prova que o CampaignsModule não sombreia mais a fila de ENVIO.
 * Só que quem enfileira o volume do cliente eleitoral no fallback 1-a-1 do
 * broadcast é o `ZernioBroadcastSendService`, e ele injeta a fila de DENTRO do
 * WhatsappProvidersModule — que continuava com `registerQueue` PELADO. O
 * comentário do `campaigns.module.ts` afirmava o problema resolvido; o código
 * dizia o contrário, e o teste de cima passava verde porque nunca olhou para
 * este módulo.
 *
 * Este bloco monta as importações BullMQ REAIS do WhatsappProvidersModule ao
 * lado da política global, exatamente como o de cima faz com o
 * CampaignsModule. Sem ele, a regressão volta pelo mesmo buraco.
 */
const providersBullImports = (
  Reflect.getMetadata('imports', WhatsappProvidersModule) as unknown[]
).filter(
  (m): m is { module: unknown } =>
    typeof m === 'object' &&
    m !== null &&
    (m as { module?: unknown }).module === BullModule,
);

async function mountProvidersWithGlobal() {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [() => ({ REDIS_HOST, REDIS_PORT })],
      }),
      // A configuração GLOBAL, lida da fonte (queue.module.ts).
      QueueModule,
      // As registrações do próprio WhatsappProvidersModule — o que está sob teste.
      ...(providersBullImports as never[]),
    ],
  }).compile();
}

describe('WhatsappProvidersModule — registro das filas BullMQ', () => {
  /**
   * A fila de ENVIO é a que o fallback 1-a-1 do broadcast usa (campanha não
   * broadcastável, ou destinatário no cap de 24h da Meta). Sombreada aqui, ela
   * perdia `attempts` — o caminho retryável do worker faz `releaseClaim`
   * (SENDING→QUEUED) e RELANÇA contando com a retentativa do BullMQ; sem
   * `attempts` a mensagem fica QUEUED PARA SEMPRE, sem job — e perdia a
   * limpeza do Redis (13.400 hashes permanentes por disparo).
   */
  it('I16 — a fila de ENVIO injetada pelo broadcast mantém a política global (attempts 5 + limpeza)', async () => {
    const moduleRef = await mountProvidersWithGlobal();
    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.WHATSAPP_SEND),
    );
    try {
      expect(queue.defaultJobOptions?.attempts).toBe(5);
      expect(queue.defaultJobOptions?.removeOnComplete).toBeDefined();
      expect(queue.defaultJobOptions?.removeOnFail).toBeDefined();
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });

  /**
   * O KILL-SWITCH: `attempts: 5` é o mais teimoso da casa porque é ele que PARA
   * um disparo em voo quando a conta é bloqueada (131031) ou o template é
   * pausado (132015). Registrado pelado aqui, ele desistia na primeira
   * tentativa para qualquer consumidor deste módulo.
   */
  it('I16 — o CANCELAMENTO do broadcast mantém a teimosia da política global (attempts 5)', async () => {
    const moduleRef = await mountProvidersWithGlobal();
    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL),
    );
    try {
      expect(queue.defaultJobOptions?.attempts).toBe(5);
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });

  /**
   * O DISPARO do broadcast NÃO pode ganhar retentativa de brinde por causa da
   * faxina: é este injetor (`ZernioBroadcastSendService`) que reenfileira os
   * lotes excedentes do teto de 24h, e `attempts: 2` num endpoint sem
   * `Idempotency-Key` redispara o LOTE INTEIRO. Em produção ele roda com UMA
   * tentativa hoje; a correção mantém o número e acrescenta a limpeza.
   */
  it('I16 — o DISPARO do broadcast continua com UMA tentativa (não herda o attempts 2 do global)', async () => {
    const moduleRef = await mountProvidersWithGlobal();
    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH),
    );
    try {
      expect(queue.defaultJobOptions?.attempts).toBe(1);
      expect(queue.defaultJobOptions?.removeOnComplete).toBeDefined();
      expect(queue.defaultJobOptions?.removeOnFail).toBeDefined();
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });

  /**
   * NENHUMA fila registrada aqui pode ficar sem política: este é o módulo que
   * fala com os provedores, e todas as suas filas compartilham o MESMO Redis
   * dos locks de campanha, do pacing e dos contadores de tier. Vale inclusive
   * para a única que NÃO existe no `queue.module.ts` (o reconciliador do
   * GoZap), que por isso precisa declarar a política aqui mesmo.
   */
  it('I16 — nenhuma fila deste módulo fica sem defaultJobOptions', async () => {
    const moduleRef = await mountProvidersWithGlobal();
    const nomes = [
      QUEUE_NAMES.TWILIO_TIER_SYNC,
      QUEUE_NAMES.GOZAP_CONNECTION_RECONCILER,
      QUEUE_NAMES.ZERNIO_BROADCAST_SYNC,
      QUEUE_NAMES.ZERNIO_BROADCAST_DISPATCH,
      QUEUE_NAMES.ZERNIO_BROADCAST_POLL,
      QUEUE_NAMES.ZERNIO_BROADCAST_CANCEL,
      QUEUE_NAMES.WHATSAPP_SEND,
    ];
    const queues = nomes.map((n) => moduleRef.get<Queue>(getQueueToken(n)));
    try {
      for (const [i, q] of queues.entries()) {
        expect(
          q.defaultJobOptions?.attempts,
          `${nomes[i]} sem attempts`,
        ).toBeTypeOf('number');
        expect(
          q.defaultJobOptions?.removeOnComplete,
          `${nomes[i]} sem removeOnComplete`,
        ).toBeDefined();
        expect(
          q.defaultJobOptions?.removeOnFail,
          `${nomes[i]} sem removeOnFail`,
        ).toBeDefined();
      }
    } finally {
      await Promise.all(queues.map((q) => q.close()));
      await moduleRef.close();
    }
  });
});
