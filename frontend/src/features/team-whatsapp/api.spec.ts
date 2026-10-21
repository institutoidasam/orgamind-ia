import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const post = vi.fn();
const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));

import {
  dispatchPollInterval, POLL_WINDOW_MS, scheduledPollInterval, useCancelDispatch, useCreateTeamDispatch,
  useScheduledDispatches, useTeamRoster,
} from './api';
import type { DispatchList, ScheduledList } from './schemas';

const NOW = Date.parse('2026-10-16T12:00:00Z');

function list(queued: number, ageMs: number): DispatchList {
  return {
    items: [{
      id: 'd1',
      createdAt: new Date(NOW - ageMs).toISOString(),
      author: null,
      target: { type: 'sector', id: 's1', label: 'Compras', shift: null },
      channel: null,
      counts: { queued, sent: 0, failed: 0, skipped: 0, scheduled: 0, cancelled: 0 },
      recipients: [],
      rosterDate: null,
      state: 'DISPATCHED',
      scheduledFor: null,
      firedAt: null,
      unselected: [],
      off: [],
    }],
  };
}

describe('dispatchPollInterval', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it('consulta a cada 10 s enquanto há QUEUED com menos de 60 min', () => {
    expect(dispatchPollInterval(list(2, 5 * 60_000))).toBe(10_000);
  });

  it('para de consultar quando o QUEUED tem mais de 60 min', () => {
    expect(dispatchPollInterval(list(2, POLL_WINDOW_MS + 1))).toBe(false);
  });

  it('não consulta sem QUEUED nem sem dados', () => {
    expect(dispatchPollInterval(list(0, 1_000))).toBe(false);
    expect(dispatchPollInterval(undefined)).toBe(false);
  });
});

describe('useTeamRoster', () => {
  const wrapperFor = (qc: QueryClient) => ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);

  it('pede /internal/team-whatsapp/roster?sectorId&date com a key [team-whatsapp, roster, sectorId, date]', async () => {
    const roster = { sectorId: 's1', date: '2026-10-21', shiftStarts: [], members: [] };
    get.mockReturnValue({ json: () => Promise.resolve(roster) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useTeamRoster({ sectorId: 's1', date: '2026-10-21' }), {
      wrapper: wrapperFor(qc),
    });
    await waitFor(() => expect(result.current.data).toEqual(roster));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/roster', {
      searchParams: { sectorId: 's1', date: '2026-10-21' },
    });
    expect(qc.getQueryData(['team-whatsapp', 'roster', 's1', '2026-10-21'])).toEqual(roster);
  });

  it('sem setor e data escolhidos não busca', () => {
    get.mockClear();
    const { result } = renderHook(() => useTeamRoster(null), { wrapper: wrapperFor(new QueryClient()) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('useCreateTeamDispatch', () => {
  it('após o POST com sucesso invalida a lista de envios e a de agendados', async () => {
    post.mockReturnValue({
      json: () => Promise.resolve({ dispatchId: 'd1', queued: 1, scheduled: 0, scheduledFor: null, skipped: [] }),
    });
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useCreateTeamDispatch(), { wrapper });
    const input = { channelId: 'ch1', text: 'Oi', target: { type: 'user' as const, userId: 'u1' } };
    await result.current.mutateAsync(input);
    expect(post).toHaveBeenCalledWith('internal/team-whatsapp/dispatches', { json: input });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'dispatches'] }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'scheduled'] });
  });
});

const wrap = (qc: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: qc }, children);

const SCHEDULED: ScheduledList = {
  items: [{
    id: 'd1',
    scheduledFor: '2026-10-22T02:00:00.000Z',
    rosterDate: '2026-10-21',
    shift: { id: 'noite', name: 'Noite', startTime: '22:00', endTime: '06:00' },
    label: 'Produção · Noite · 21/10',
    recipientCount: 3,
    channel: { id: 'ch1', name: 'GoZap Principal' },
    author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
  }],
};

describe('scheduledPollInterval', () => {
  it('reconsulta a cada 60 s enquanto há agendados', () => {
    expect(scheduledPollInterval(SCHEDULED)).toBe(60_000);
  });

  it('não reconsulta sem agendados nem sem dados', () => {
    expect(scheduledPollInterval({ items: [] })).toBe(false);
    expect(scheduledPollInterval(undefined)).toBe(false);
  });
});

describe('useScheduledDispatches', () => {
  async function load(list: ScheduledList) {
    get.mockReset();
    get.mockReturnValue({ json: () => Promise.resolve(list) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useScheduledDispatches(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toEqual(list));
    const query = qc.getQueryCache().find({ queryKey: ['team-whatsapp', 'scheduled'] });
    const interval = query?.options.refetchInterval as (q: unknown) => number | false;
    return { qc, interval: interval(query) };
  }

  it('pede /internal/team-whatsapp/scheduled com a key [team-whatsapp, scheduled] e reconsulta a cada 60 s', async () => {
    const { qc, interval } = await load(SCHEDULED);
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/scheduled');
    expect(qc.getQueryData(['team-whatsapp', 'scheduled'])).toEqual(SCHEDULED);
    expect(interval).toBe(60_000);
  });

  it('sem agendados não reconsulta', async () => {
    expect((await load({ items: [] })).interval).toBe(false);
  });
});

describe('useCancelDispatch', () => {
  async function cancel(response: Promise<unknown>) {
    post.mockReset();
    post.mockReturnValue({ json: () => response });
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCancelDispatch(), { wrapper: wrap(qc) });
    await result.current.mutateAsync('d1').catch(() => undefined);
    expect(post).toHaveBeenCalledWith('internal/team-whatsapp/dispatches/d1/cancel');
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'scheduled'] }));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'dispatches'] });
  }

  it('POST cancel e invalida agendados e envios', async () => {
    await cancel(Promise.resolve({ id: 'd1', state: 'CANCELLED' }));
  });

  it('também invalida agendados e envios quando o cancelamento falha (409)', async () => {
    await cancel(Promise.reject(new Error('team_whatsapp.not_cancellable')));
  });
});
