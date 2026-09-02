import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ZernioSyncRunsService } from './zernio-sync-runs.service';
import { PrismaService } from '../../shared/prisma/prisma.service';

const CHANNEL = 'ch1';
const run = (over: Record<string, unknown> = {}) => ({
  id: 'run1',
  channelId: CHANNEL,
  status: 'PENDING',
  totalConversations: 0,
  processedConversations: 0,
  importedMessages: 0,
  failedConversations: 0,
  cursor: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe('ZernioSyncRunsService', () => {
  let prisma: MockProxy<PrismaService>;
  let runs: ZernioSyncRunsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    runs = new ZernioSyncRunsService(prisma);
  });

  /**
   * O operador clica duas vezes (ou o F5 reenvia). Sem esta guarda, cada clique
   * enfileira um sync — e DOIS syncs no mesmo canal dobram o consumo do balde,
   * que é exatamente o que causou o incidente.
   */
  it('clique repetido não cria um segundo run: reaproveita o que está em curso', async () => {
    prisma.zernioSyncRun.findFirst.mockResolvedValue(
      run({ status: 'RUNNING' }) as never,
    );

    const res = await runs.startOrReuse(CHANNEL);

    expect(res.created).toBe(false);
    expect(res.run.id).toBe('run1');
    expect(prisma.zernioSyncRun.create).not.toHaveBeenCalled();
  });

  it('sem run ativo, cria um novo em PENDING', async () => {
    prisma.zernioSyncRun.findFirst.mockResolvedValue(null as never);
    prisma.zernioSyncRun.create.mockResolvedValue(run() as never);

    const res = await runs.startOrReuse(CHANNEL);

    expect(res.created).toBe(true);
    expect(res.run.status).toBe('PENDING');
    expect(prisma.zernioSyncRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ channelId: CHANNEL }) }),
    );
  });

  it('saveProgress grava o parcial (é o que a tela mostra: "42 de 100")', async () => {
    prisma.zernioSyncRun.update.mockResolvedValue(run() as never);

    await runs.saveProgress('run1', {
      totalConversations: 100,
      processedConversations: 42,
      importedMessages: 7,
      failedConversations: 1,
      cursor: 'CUR2',
    });

    expect(prisma.zernioSyncRun.update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: expect.objectContaining({
        totalConversations: 100,
        processedConversations: 42,
        importedMessages: 7,
        failedConversations: 1,
        cursor: 'CUR2',
      }),
    });
  });

  it('finish fecha o run com SUCCEEDED e carimba finishedAt', async () => {
    prisma.zernioSyncRun.update.mockResolvedValue(run() as never);

    await runs.finish('run1', { conversations: 10, messages: 20, failed: 0 });

    const arg = prisma.zernioSyncRun.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.status).toBe('SUCCEEDED');
    expect(arg.data.finishedAt).toBeInstanceOf(Date);
  });

  /**
   * Erro parcial NÃO é 500: o run fecha como SUCCEEDED com `failedConversations`
   * preenchido. A tela mostra "entraram 98, falharam 2" — que é a verdade.
   * FAILED fica para o erro que derruba o run inteiro (401, canal sem conta).
   */
  it('falha parcial fecha SUCCEEDED com o contador de falhas (não FAILED)', async () => {
    prisma.zernioSyncRun.update.mockResolvedValue(run() as never);

    await runs.finish('run1', { conversations: 100, messages: 300, failed: 2 });

    const arg = prisma.zernioSyncRun.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.status).toBe('SUCCEEDED');
    expect(arg.data.failedConversations).toBe(2);
  });

  it('fail fecha o run com FAILED e guarda o motivo', async () => {
    prisma.zernioSyncRun.update.mockResolvedValue(run() as never);

    await runs.fail('run1', new Error('401 chave revogada'));

    const arg = prisma.zernioSyncRun.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.status).toBe('FAILED');
    expect(String(arg.data.error)).toContain('401');
  });

  it('latest devolve o run mais recente do canal (é o que a tela consulta)', async () => {
    prisma.zernioSyncRun.findFirst.mockResolvedValue(run({ id: 'run9' }) as never);

    const res = await runs.latest(CHANNEL);

    expect(res?.id).toBe('run9');
    expect(prisma.zernioSyncRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { channelId: CHANNEL },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });
});
