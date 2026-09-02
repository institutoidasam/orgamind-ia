import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Logger } from '@nestjs/common';
import { GozapConnectionReconcilerProcessor } from './gozap-connection-reconciler.processor';
import { GozapInstancesService } from './gozap-instances.service';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';

function channel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch1',
    provider: 'GOZAP',
    gozapInstanceToken: 'CIPHERTEXT',
    isActive: true,
    ...overrides,
  } as never;
}

describe('GozapConnectionReconcilerProcessor', () => {
  let repo: MockProxy<WhatsappInstancesRepository>;
  let gozap: MockProxy<GozapInstancesService>;
  let processor: GozapConnectionReconcilerProcessor;

  beforeEach(() => {
    repo = mockDeep<WhatsappInstancesRepository>();
    gozap = mockDeep<GozapInstancesService>();
    processor = new GozapConnectionReconcilerProcessor(repo, gozap);
  });

  it('reconcilia todo canal GOZAP ativo com token', async () => {
    repo.listActive.mockResolvedValue([
      channel({ id: 'a' }),
      channel({ id: 'b' }),
    ]);
    gozap.reconcileConnection.mockResolvedValue('open');

    await processor.process();

    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(2);
    expect(gozap.reconcileConnection).toHaveBeenCalledWith('a');
    expect(gozap.reconcileConnection).toHaveBeenCalledWith('b');
  });

  it('ignora canais de outro provedor e canais GOZAP sem token', async () => {
    repo.listActive.mockResolvedValue([
      channel({ id: 'evo', provider: 'EVOLUTION', gozapInstanceToken: null }),
      channel({ id: 'twi', provider: 'TWILIO', gozapInstanceToken: null }),
      channel({ id: 'gz-sem-token', gozapInstanceToken: null }),
      channel({ id: 'gz-ok' }),
    ]);
    gozap.reconcileConnection.mockResolvedValue('open');

    await processor.process();

    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(1);
    expect(gozap.reconcileConnection).toHaveBeenCalledWith('gz-ok');
  });

  it('um canal que explode NÃO aborta o loop dos demais', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repo.listActive.mockResolvedValue([
      channel({ id: 'a' }),
      channel({ id: 'b' }),
      channel({ id: 'c' }),
    ]);
    gozap.reconcileConnection.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('GoZap fora do ar');
      return 'open';
    });

    await expect(processor.process()).resolves.toBeUndefined();

    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('nenhum canal GOZAP → não chama nada e não loga (o deploy sem GoZap fica silencioso)', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    repo.listActive.mockResolvedValue([
      channel({ id: 'evo', provider: 'EVOLUTION', gozapInstanceToken: null }),
    ]);

    await processor.process();

    expect(gozap.reconcileConnection).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
