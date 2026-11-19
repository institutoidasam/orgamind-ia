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
import { EvolutionApiAdapter } from './adapters/evolution-api.adapter';

const T0 = new Date('2026-11-10T12:00:00.000Z');

function build() {
  const evolution = mockDeep<EvolutionApiAdapter>();
  const service = new ChannelLiveStateService(evolution);
  return { evolution, service };
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

describe('ChannelLiveStateService — EVOLUTION', () => {
  it.each<[string, LiveState | Error, LiveState]>([
    ['open', 'open', 'open'],
    ['connecting', 'connecting', 'connecting'],
    ['close', 'close', 'close'],
    ['lança', new Error('evolution fora do ar'), 'unknown'],
  ])('instância %s', async (_label, observed, expected) => {
    const { evolution, service } = build();
    if (observed instanceof Error) {
      evolution.getLiveConnectionState.mockRejectedValue(observed);
    } else {
      evolution.getLiveConnectionState.mockResolvedValue(
        observed === 'unknown' ? null : observed,
      );
    }

    const result = await service.check(channel('ch_e', 'EVOLUTION', 'gbr'));

    expect(result).toEqual({
      channelId: 'ch_e',
      state: expected,
      checkedAt: T0,
    });
    expect(evolution.getLiveConnectionState).toHaveBeenCalledWith('gbr');
  });
});

describe('ChannelLiveStateService — EVOLUTION sem estado e provedores desligados', () => {
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

  it.each<ChannelProvider>(['GOZAP', 'TWILIO'])(
    'canal %s → unknown sem chamada externa',
    async (provider) => {
      const { evolution, service } = build();

      const result = await service.check(channel('ch_x', provider, 'gbr'));

      expect(result.state).toBe('unknown');
      expect(evolution.getLiveConnectionState).not.toHaveBeenCalled();
    },
  );
});

describe('ChannelLiveStateService — cache', () => {
  it('duas chamadas em 14 s consultam uma vez; depois de 15 s, de novo', async () => {
    const { evolution, service } = build();
    evolution.getLiveConnectionState.mockResolvedValue('close');
    const ch = channel('ch_e', 'EVOLUTION', 'gbr');

    await service.check(ch);
    vi.advanceTimersByTime(LIVE_STATE_TTL_MS - 1_000);
    await service.check(ch);
    expect(evolution.getLiveConnectionState).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await service.check(ch);
    expect(evolution.getLiveConnectionState).toHaveBeenCalledTimes(2);
  });

  it('unknown não fica em cache: a próxima chamada consulta de novo', async () => {
    const { evolution, service } = build();
    evolution.getLiveConnectionState.mockRejectedValueOnce(
      new Error('timeout'),
    );
    evolution.getLiveConnectionState.mockResolvedValueOnce('open');
    const ch = channel('ch_e', 'EVOLUTION', 'gbr');

    expect((await service.check(ch)).state).toBe('unknown');
    expect((await service.check(ch)).state).toBe('open');
    expect(evolution.getLiveConnectionState).toHaveBeenCalledTimes(2);
  });

  it('checkedAt é a hora da consulta; em cache, a da consulta original', async () => {
    const { evolution, service } = build();
    evolution.getLiveConnectionState.mockResolvedValue('open');
    const ch = channel('ch_e', 'EVOLUTION', 'gbr');

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
    const { evolution, service } = build();
    evolution.getLiveConnectionState.mockImplementation((name) =>
      Promise.resolve(name === 'gbr' ? 'open' : 'close'),
    );
    const x = channel('ch_x', 'EVOLUTION', 'gbr');
    const y = channel('ch_y', 'EVOLUTION', 'ops');

    const result = await service.checkMany([x, x, y]);

    expect(evolution.getLiveConnectionState).toHaveBeenCalledTimes(2);
    expect([...result.keys()]).toEqual(['ch_x', 'ch_y']);
    expect(result.get('ch_x')?.state).toBe('open');
    expect(result.get('ch_y')?.state).toBe('close');
  });

  it('consulta os canais em paralelo, sem esperar um para iniciar o outro', async () => {
    const { evolution, service } = build();
    // A instância gbr nunca responde: se a ops só começasse depois dela, não
    // seria chamada.
    evolution.getLiveConnectionState.mockImplementation((name) =>
      name === 'gbr' ? new Promise(() => undefined) : Promise.resolve('open'),
    );

    void service.checkMany([
      channel('ch_x', 'EVOLUTION', 'gbr'),
      channel('ch_y', 'EVOLUTION', 'ops'),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(evolution.getLiveConnectionState).toHaveBeenCalledTimes(2);
    expect(evolution.getLiveConnectionState).toHaveBeenCalledWith('ops');
  });
});
