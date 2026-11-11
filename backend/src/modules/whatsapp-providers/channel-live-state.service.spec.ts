/* eslint-disable @typescript-eslint/unbound-method */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ChannelProvider } from '@prisma/client';
import {
  ChannelLiveStateService,
  LIVE_STATE_TTL_MS,
  type LiveCheckChannel,
  type LiveState,
} from './channel-live-state.service';
import { GozapInstancesService } from './gozap-instances.service';
import { EvolutionApiAdapter } from './adapters/evolution-api.adapter';

const T0 = new Date('2026-11-10T12:00:00.000Z');

function build() {
  const gozap = mockDeep<GozapInstancesService>();
  const evolution = mockDeep<EvolutionApiAdapter>();
  const service = new ChannelLiveStateService(gozap, evolution);
  return { gozap, evolution, service };
}

function channel(
  id: string,
  provider: ChannelProvider,
  evolutionInstanceName: string | null = null,
): LiveCheckChannel {
  return { id, provider, evolutionInstanceName };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChannelLiveStateService — GOZAP', () => {
  it.each<[string, 'open' | 'connecting' | 'close' | null | Error, LiveState]>([
    ['open', 'open', 'open'],
    ['connecting', 'connecting', 'connecting'],
    ['close', 'close', 'close'],
    ['null (não deu para observar)', null, 'unknown'],
    ['lança', new Error('gozap fora do ar'), 'unknown'],
  ])('reconcile %s', async (_label, reconciled, expected) => {
    const { gozap, service } = build();
    if (reconciled instanceof Error) {
      gozap.reconcileConnection.mockRejectedValue(reconciled);
    } else {
      gozap.reconcileConnection.mockResolvedValue(reconciled);
    }

    const result = await service.check(channel('ch_g', 'GOZAP'));

    expect(result).toEqual({
      channelId: 'ch_g',
      state: expected,
      checkedAt: T0,
    });
    expect(gozap.reconcileConnection).toHaveBeenCalledWith('ch_g');
    // getConnectionInfo pode abrir sessão no GoZap: nunca é o caminho.
    expect(gozap.getConnectionInfo).not.toHaveBeenCalled();
  });
});

describe('ChannelLiveStateService — EVOLUTION e demais provedores', () => {
  it('EVOLUTION com nome consulta a instância do canal', async () => {
    const { evolution, service } = build();
    evolution.getLiveConnectionState.mockResolvedValue('open');

    const result = await service.check(channel('ch_e', 'EVOLUTION', 'gbr'));

    expect(result.state).toBe('open');
    expect(evolution.getLiveConnectionState).toHaveBeenCalledWith('gbr');
  });

  it('EVOLUTION sem nome é unknown e não chama o adaptador (cairia na instância padrão)', async () => {
    const { evolution, service } = build();

    const result = await service.check(channel('ch_e', 'EVOLUTION', null));

    expect(result.state).toBe('unknown');
    expect(evolution.getLiveConnectionState).not.toHaveBeenCalled();
  });

  it('EVOLUTION que devolve null é unknown', async () => {
    const { evolution, service } = build();
    evolution.getLiveConnectionState.mockResolvedValue(null);

    const result = await service.check(channel('ch_e', 'EVOLUTION', 'gbr'));

    expect(result.state).toBe('unknown');
  });

  it('TWILIO é unknown e não consulta ninguém', async () => {
    const { gozap, evolution, service } = build();

    const result = await service.check(channel('ch_t', 'TWILIO'));

    expect(result.state).toBe('unknown');
    expect(gozap.reconcileConnection).not.toHaveBeenCalled();
    expect(evolution.getLiveConnectionState).not.toHaveBeenCalled();
  });
});

describe('ChannelLiveStateService — cache', () => {
  it('duas chamadas em 14 s consultam uma vez; depois de 15 s, de novo', async () => {
    const { gozap, service } = build();
    gozap.reconcileConnection.mockResolvedValue('close');
    const ch = channel('ch_g', 'GOZAP');

    await service.check(ch);
    vi.advanceTimersByTime(LIVE_STATE_TTL_MS - 1_000);
    await service.check(ch);
    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await service.check(ch);
    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(2);
  });

  it('unknown não fica em cache: a próxima chamada consulta de novo', async () => {
    const { gozap, service } = build();
    gozap.reconcileConnection.mockRejectedValueOnce(new Error('timeout'));
    gozap.reconcileConnection.mockResolvedValueOnce('open');
    const ch = channel('ch_g', 'GOZAP');

    expect((await service.check(ch)).state).toBe('unknown');
    expect((await service.check(ch)).state).toBe('open');
    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(2);
  });

  it('checkedAt é a hora da consulta; em cache, a da consulta original', async () => {
    const { gozap, service } = build();
    gozap.reconcileConnection.mockResolvedValue('open');
    const ch = channel('ch_g', 'GOZAP');

    await service.check(ch);
    vi.advanceTimersByTime(5_000);
    expect((await service.check(ch)).checkedAt).toEqual(T0);

    vi.advanceTimersByTime(LIVE_STATE_TTL_MS);
    const later = new Date(T0.getTime() + 5_000 + LIVE_STATE_TTL_MS);
    expect((await service.check(ch)).checkedAt).toEqual(later);
  });
});

describe('ChannelLiveStateService.checkMany', () => {
  it('ids repetidos consultam uma vez; o mapa tem uma entrada por canal', async () => {
    const { gozap, evolution, service } = build();
    gozap.reconcileConnection.mockResolvedValue('open');
    evolution.getLiveConnectionState.mockResolvedValue('close');
    const x = channel('ch_x', 'GOZAP');
    const y = channel('ch_y', 'EVOLUTION', 'gbr');

    const result = await service.checkMany([x, x, y]);

    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(1);
    expect(evolution.getLiveConnectionState).toHaveBeenCalledTimes(1);
    expect([...result.keys()]).toEqual(['ch_x', 'ch_y']);
    expect(result.get('ch_x')?.state).toBe('open');
    expect(result.get('ch_y')?.state).toBe('close');
  });

  it('consulta os canais em paralelo, sem esperar um para iniciar o outro', async () => {
    const { gozap, evolution, service } = build();
    // O GOZAP nunca responde: se o EVOLUTION só começasse depois dele, não
    // seria chamado.
    gozap.reconcileConnection.mockReturnValue(new Promise(() => undefined));
    evolution.getLiveConnectionState.mockResolvedValue('open');

    void service.checkMany([
      channel('ch_x', 'GOZAP'),
      channel('ch_y', 'EVOLUTION', 'gbr'),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(gozap.reconcileConnection).toHaveBeenCalledTimes(1);
    expect(evolution.getLiveConnectionState).toHaveBeenCalledTimes(1);
  });
});
