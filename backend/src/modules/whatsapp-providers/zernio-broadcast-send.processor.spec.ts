import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/nestjs', () => ({
  captureException: vi.fn(),
}));

import * as Sentry from '@sentry/nestjs';
import { ZernioBroadcastDispatchProcessor } from './zernio-broadcast-send.processor';

const JOB_DATA = {
  campaignId: 'camp1',
  channelId: 'ch1',
  messageIds: ['m1', 'm2'],
};

function makeProcessor(
  over: {
    dispatch?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const svc = {
    dispatchBatch: over.dispatch ?? vi.fn(async () => ({ sent: 2 })),
    failOrphanedBatch: vi.fn(async (): Promise<void> => undefined),
    cancelForCampaign: vi.fn(async () => 0),
  };
  const proc = new ZernioBroadcastDispatchProcessor(svc as never);
  return { proc, svc };
}

function makeJob(over: Record<string, unknown> = {}) {
  return {
    data: JOB_DATA,
    // BullMQ incrementa `attemptsMade` ANTES de processar, então na 1ª execução
    // ele já vale 1 — é assim que o send-message.processor lê o mesmo sinal.
    attemptsMade: 1,
    opts: { attempts: 2 },
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ZernioBroadcastDispatchProcessor — a ENTREGA INDETERMINADA precisa acordar alguém', () => {
  it('★ lote indeterminado (o /send não respondeu) vira ALARME no Sentry, não sucesso mudo', async () => {
    const { proc } = makeProcessor({
      dispatch: vi.fn(async () => ({ sent: 2, indeterminate: 2 })),
    });

    await proc.process(makeJob());

    // O job NÃO falha (falhar convidaria a retentativa a remontar o lote), então
    // o `@OnWorkerEvent('failed')` nunca roda: sem este alarme, 2.000 mensagens
    // de status desconhecido passariam em silêncio absoluto.
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('lote normal não gera alarme', async () => {
    const { proc } = makeProcessor();
    await proc.process(makeJob());
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('ZernioBroadcastDispatchProcessor — o lote nunca fica QUEUED sem dono', () => {
  it('★ ÚLTIMA tentativa falhou: o lote devolvido a QUEUED vira falha recuperável', async () => {
    const { proc, svc } = makeProcessor();
    const err = new Error('rede caiu antes de criar o disparo');

    proc.onFailed(makeJob({ attemptsMade: 2, opts: { attempts: 2 } }), err);
    await Promise.resolve();

    expect(svc.failOrphanedBatch).toHaveBeenCalledWith(JOB_DATA, err);
  });

  it('AINDA há tentativa pela frente: não mexe nas linhas (a retentativa vai reivindicá-las)', async () => {
    const { proc, svc } = makeProcessor();

    proc.onFailed(
      makeJob({ attemptsMade: 1, opts: { attempts: 2 } }),
      new Error('boom'),
    );
    await Promise.resolve();

    expect(svc.failOrphanedBatch).not.toHaveBeenCalled();
  });

  it('★ o resgate é AGUARDADO e a rejeição dele não escapa como unhandled rejection', async () => {
    // `void svc.failOrphanedBatch(...)` dentro de um @OnWorkerEvent é uma promise
    // flutuante: se ela rejeitar (banco fora no pior momento possível — que é
    // justamente quando este caminho roda), o processo recebe uma unhandled
    // rejection e o erro some. O worker precisa APRENDER que o resgate falhou,
    // senão o lote fica QUEUED órfão e ninguém fica sabendo.
    const { proc, svc } = makeProcessor();
    svc.failOrphanedBatch.mockRejectedValueOnce(new Error('banco fora'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await proc.onFailed(
        makeJob({ attemptsMade: 2, opts: { attempts: 2 } }),
        new Error('rede caiu'),
      );
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
    // E o alarme sai: o erro original MAIS o do resgate.
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  it('fila registrada SEM attempts (o padrão do BullMQ é 1): a 1ª falha JÁ é a última', async () => {
    // Os dois registros de fila do dispatch são "pelados" (campaigns.module.ts e
    // whatsapp-providers.module.ts), então o defaultJobOptions do QueueModule não
    // chega ao job e `attempts` vem undefined. Se este caso não fosse tratado, o
    // lote ficaria QUEUED sem NENHUM job — a campanha travada para sempre.
    const { proc, svc } = makeProcessor();

    proc.onFailed(makeJob({ attemptsMade: 1, opts: {} }), new Error('boom'));
    await Promise.resolve();

    expect(svc.failOrphanedBatch).toHaveBeenCalled();
  });
});
