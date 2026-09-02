import { describe, it, expect, vi } from 'vitest';
import { resolveSyncChannel } from './resolve-sync-channel.util';
import { SyncNotSupportedError } from './errors/contacts.errors';

/**
 * Fix round 1 (revisão pós-commit) — `WhatsappInstancesRepository.findDefault()`
 * (sem `provider`) devolve o `isDefault` MAIS VELHO entre TODOS os provedores,
 * porque `setDefault` é escopado POR PROVEDOR (T8): pode haver um default
 * EVOLUTION e um default GOZAP ao mesmo tempo, e `findDefault()` ignora qual
 * dos dois está de pé. Em produção isto elegia uma linha EVOLUTION morta
 * (canal de teste antigo) em vez do GOZAP que está realmente online.
 *
 * `resolveSyncChannel` substitui `findDefault()` nos dois consumidores da
 * validação ativa (`ContactsService.syncBackfill` e `ContactSyncProcessor`) por
 * uma escolha entre TODOS os defaults ativos que sabem validar número,
 * preferindo quem está online agora.
 */
describe('resolveSyncChannel', () => {
  const EVOLUTION_OLD = {
    id: 'ch-evo',
    name: 'evo-antigo',
    provider: 'EVOLUTION',
    isDefault: true,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  const GOZAP_NEW = {
    id: 'ch-gozap',
    name: 'robo',
    provider: 'GOZAP',
    isDefault: true,
    isActive: true,
    createdAt: new Date('2026-08-01T00:00:00Z'),
  };

  function makeCollaborators(opts: {
    active: unknown[];
    supports?: (provider: string) => boolean;
    online?: (channel: { id: string }) => boolean;
  }) {
    const instancesRepo = {
      listActive: vi.fn().mockResolvedValue(opts.active),
    };
    const wa = {
      supportsNumberCheckFor: vi.fn((opts.supports ?? (() => true)) as never),
    };
    const onlineFn = opts.online ?? (() => true);
    const contactsRepo = {
      isSessionChannelOnline: vi
        .fn()
        .mockImplementation((c: { id: string }) =>
          Promise.resolve(onlineFn(c)),
        ),
    };
    return { instancesRepo, wa, contactsRepo };
  }

  it('Evolution-default(old)+GoZap-default(online): escolhe o GoZap, não o mais velho', async () => {
    const { instancesRepo, wa, contactsRepo } = makeCollaborators({
      active: [EVOLUTION_OLD, GOZAP_NEW],
      online: (c) => c.id === 'ch-gozap',
    });

    const channel = await resolveSyncChannel(instancesRepo, wa, contactsRepo);

    expect(channel.id).toBe('ch-gozap');
  });

  it('só-Evolution-offline: é o único candidato, então o resolver o devolve mesmo assim — quem recusa é o gate de online do chamador, não o resolver', async () => {
    const { instancesRepo, wa, contactsRepo } = makeCollaborators({
      active: [EVOLUTION_OLD],
      online: () => false,
    });

    const channel = await resolveSyncChannel(instancesRepo, wa, contactsRepo);

    // Não lança: com um candidato só, não há entre quem escolher. O chamador
    // (ContactsService.syncBackfill / ContactSyncProcessor) já faz o SEU
    // PRÓPRIO `isSessionChannelOnline(channel)` logo depois e recusa ali —
    // ver 'recusa NA HORA quando o canal está desconectado' (service) e
    // 'aborta quando o canal está offline' (processor), agora exercendo
    // este resolver por baixo.
    expect(channel.id).toBe('ch-evo');
  });

  it('nenhum canal ativo padrão sabe validar número: recusa com SyncNotSupportedError', async () => {
    const { instancesRepo, wa, contactsRepo } = makeCollaborators({
      active: [EVOLUTION_OLD, GOZAP_NEW],
      supports: () => false,
    });

    await expect(
      resolveSyncChannel(instancesRepo, wa, contactsRepo),
    ).rejects.toThrow(SyncNotSupportedError);
  });

  it('ignora candidatos que não são isDefault, mesmo que estejam ativos e suportem checagem', async () => {
    const naoDefault = { ...GOZAP_NEW, id: 'ch-nao-default', isDefault: false };
    const { instancesRepo, wa, contactsRepo } = makeCollaborators({
      active: [naoDefault, EVOLUTION_OLD],
      online: () => true,
    });

    const channel = await resolveSyncChannel(instancesRepo, wa, contactsRepo);

    expect(channel.id).toBe('ch-evo');
  });

  it('nenhum candidato está online: devolve o primeiro de forma determinística (ordem de listActive), para o gate do chamador recusar com o canal certo', async () => {
    const { instancesRepo, wa, contactsRepo } = makeCollaborators({
      active: [EVOLUTION_OLD, GOZAP_NEW],
      online: () => false,
    });

    const channel = await resolveSyncChannel(instancesRepo, wa, contactsRepo);

    expect(channel.id).toBe('ch-evo');
  });
});
