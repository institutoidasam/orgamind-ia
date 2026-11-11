import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const post = vi.fn();
const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));

import {
  detailPollInterval, dispatchPollInterval, PAGE_SIZE, POLL_WINDOW_MS, RECIPIENT_PAGE_SIZE, scheduledPollInterval,
  useCancelDispatch, useCreateTeamDispatch, useDispatchRecipients, useRetryRecipients, useScheduledDispatches,
  useTeamDispatch, useTeamDispatches, useTeamPersonRoute, useTeamRoster,
} from './api';
import type { DispatchDetail, DispatchList, ScheduledList } from './schemas';

const NOW = Date.parse('2026-10-16T12:00:00Z');

const ZERO_COUNTS = {
  queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, uncertain: 0, skipped: 0, scheduled: 0, cancelled: 0,
};
const PAGE_META = { total: 1, page: 1, pageSize: 20 };

const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function list(queued: number, ageMs: number, firedAgoMs?: number): DispatchList {
  return {
    items: [{
      id: 'd1',
      createdAt: ago(ageMs),
      author: null,
      target: { type: 'sector', id: 's1', label: 'Compras', shift: null },
      sectors: [{ id: 's1', name: 'Compras' }],
      channels: [],
      counts: { ...ZERO_COUNTS, queued },
      rosterDate: null,
      state: 'DISPATCHED',
      scheduledFor: null,
      firedAt: firedAgoMs === undefined ? null : ago(firedAgoMs),
    }],
    ...PAGE_META,
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

  it('a janela de 60 min do histórico conta do disparo do agendado, não da criação', () => {
    expect(dispatchPollInterval(list(2, 3 * POLL_WINDOW_MS, 5 * 60_000))).toBe(10_000);
    expect(dispatchPollInterval(list(2, 3 * POLL_WINDOW_MS, POLL_WINDOW_MS + 1))).toBe(false);
  });

  it('não consulta sem QUEUED nem sem dados', () => {
    expect(dispatchPollInterval(list(0, 1_000))).toBe(false);
    expect(dispatchPollInterval(undefined)).toBe(false);
  });
});

function detail(queued: number, ageMs: number, firedAgoMs?: number): DispatchDetail {
  return {
    id: 'd1', targetLabel: 'Compras', text: 'Oi', state: 'DISPATCHED', scheduledFor: null,
    firedAt: firedAgoMs === undefined ? null : ago(firedAgoMs),
    createdAt: ago(ageMs), author: { id: 'a1', name: 'Ada' },
    sectors: [{ id: 's1', name: 'Compras' }], channels: [], counts: { ...ZERO_COUNTS, queued },
    leftOut: { unselected: [], off: [] },
  };
}

describe('detailPollInterval', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it('consulta a cada 10 s só enquanto há QUEUED com menos de 60 min', () => {
    expect(detailPollInterval(detail(2, 5 * 60_000))).toBe(10_000);
    expect(detailPollInterval(detail(2, POLL_WINDOW_MS + 1))).toBe(false);
    expect(detailPollInterval(detail(0, 1_000))).toBe(false);
    expect(detailPollInterval(undefined)).toBe(false);
  });

  it('agendado criado há dias e disparado há pouco: a janela conta do disparo', () => {
    expect(detailPollInterval(detail(2, 72 * POLL_WINDOW_MS, 5 * 60_000))).toBe(10_000);
  });

  it('envio antigo com Repetir bem-sucedido agora: a janela conta do Repetir', () => {
    expect(detailPollInterval(detail(2, 3 * POLL_WINDOW_MS), NOW - 5 * 60_000)).toBe(10_000);
    expect(detailPollInterval(detail(2, 3 * POLL_WINDOW_MS), NOW - POLL_WINDOW_MS - 1)).toBe(false);
  });

  it('envio antigo sem Repetir não consulta', () => {
    expect(detailPollInterval(detail(2, 3 * POLL_WINDOW_MS), undefined)).toBe(false);
  });
});

describe('useTeamRoster', () => {
  const wrapperFor = (qc: QueryClient) => ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);

  it('pede /internal/team-whatsapp/roster?sectorIds=a,b&date com a key [team-whatsapp, roster, a,b, date]', async () => {
    const roster = { date: '2026-10-21', shiftStarts: [], sectors: [{ sectorId: 'a', name: 'A', channel: null, members: [] }] };
    get.mockReturnValue({ json: () => Promise.resolve(roster) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useTeamRoster(['a', 'b'], '2026-10-21'), {
      wrapper: wrapperFor(qc),
    });
    await waitFor(() => expect(result.current.data).toEqual(roster));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/roster', {
      searchParams: { sectorIds: 'a,b', date: '2026-10-21' },
    });
    expect(qc.getQueryData(['team-whatsapp', 'roster', 'a,b', '2026-10-21'])).toEqual(roster);
  });

  it('sem setor e data escolhidos não busca', () => {
    get.mockClear();
    const { result } = renderHook(() => useTeamRoster([], '2026-10-21'), { wrapper: wrapperFor(new QueryClient()) });
    expect(result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('useTeamPersonRoute', () => {
  const wrapperFor = (qc: QueryClient) => ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);

  it('pede /internal/team-whatsapp/person-route?userId com a key [team-whatsapp, person-route, userId]', async () => {
    const route = {
      userId: 'u1', sector: { id: 's1', name: 'Logística' },
      channel: {
        id: 'ch1', name: 'GoZap Principal', phoneE164: '+5592991234567', provider: 'GOZAP',
        live: { state: 'open', checkedAt: '2026-11-10T18:05:00.000Z' },
      },
    };
    get.mockReturnValue({ json: () => Promise.resolve(route) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useTeamPersonRoute('u1'), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(result.current.data).toEqual(route));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/person-route', { searchParams: { userId: 'u1' } });
    expect(qc.getQueryData(['team-whatsapp', 'person-route', 'u1'])).toEqual(route);
  });

  it('sem pessoa não busca', () => {
    get.mockClear();
    const { result } = renderHook(() => useTeamPersonRoute(''), { wrapper: wrapperFor(new QueryClient()) });
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
    const input = { text: 'Oi', target: { type: 'user' as const, userId: 'u1' } };
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
  ...PAGE_META,
};

describe('scheduledPollInterval', () => {
  it('reconsulta a cada 60 s enquanto há agendados', () => {
    expect(scheduledPollInterval(SCHEDULED)).toBe(60_000);
  });

  it('não reconsulta sem agendados nem sem dados', () => {
    expect(scheduledPollInterval({ items: [], ...PAGE_META })).toBe(false);
    expect(scheduledPollInterval(undefined)).toBe(false);
  });
});

describe('useTeamDispatches', () => {
  it('pede a página em /internal/team-whatsapp/dispatches com a key [team-whatsapp, dispatches, page]', async () => {
    const page2 = { ...list(0, 1_000), page: 2, total: 45 };
    get.mockReset();
    get.mockReturnValue({ json: () => Promise.resolve(page2) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useTeamDispatches(2), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toEqual(page2));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/dispatches', {
      searchParams: { page: 2, pageSize: PAGE_SIZE },
    });
    expect(qc.getQueryData(['team-whatsapp', 'dispatches', 2])).toEqual(page2);
  });
});

describe('useScheduledDispatches', () => {
  async function load(list: ScheduledList, page: number) {
    get.mockReset();
    get.mockReturnValue({ json: () => Promise.resolve(list) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useScheduledDispatches(page), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toEqual(list));
    const query = qc.getQueryCache().find({ queryKey: ['team-whatsapp', 'scheduled', page] });
    const interval = query?.options.refetchInterval as (q: unknown) => number | false;
    return { qc, interval: interval(query) };
  }

  it('pede a página em /internal/team-whatsapp/scheduled com a key [team-whatsapp, scheduled, page] e reconsulta a cada 60 s', async () => {
    const { qc, interval } = await load(SCHEDULED, 2);
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/scheduled', {
      searchParams: { page: 2, pageSize: PAGE_SIZE },
    });
    expect(qc.getQueryData(['team-whatsapp', 'scheduled', 2])).toEqual(SCHEDULED);
    expect(interval).toBe(60_000);
  });

  it('sem agendados não reconsulta', async () => {
    expect((await load({ items: [], ...PAGE_META }, 1)).interval).toBe(false);
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

describe('resultado do envio', () => {
  const RECIPIENTS = { items: [], total: 0, page: 1, pageSize: RECIPIENT_PAGE_SIZE };

  it('useTeamDispatch pede o detalhe com a key [team-whatsapp, dispatch, id]', async () => {
    get.mockReset();
    get.mockReturnValue({ json: () => Promise.resolve(detail(0, 1_000)) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useTeamDispatch('d1'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data?.id).toBe('d1'));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/dispatches/d1');
    expect(qc.getQueryData(['team-whatsapp', 'dispatch', 'd1'])).toBeDefined();
  });

  it('useDispatchRecipients pede status e página, e reconsulta enquanto o detalhe em cache tem QUEUED', async () => {
    get.mockReset();
    get.mockReturnValue({ json: () => Promise.resolve(RECIPIENTS) });
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const qc = new QueryClient();
    qc.setQueryData(['team-whatsapp', 'dispatch', 'd1'], detail(1, 1_000));
    const { result } = renderHook(() => useDispatchRecipients('d1', { status: 'READ', page: 2 }), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toEqual(RECIPIENTS));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/dispatches/d1/recipients', {
      searchParams: { page: 2, pageSize: RECIPIENT_PAGE_SIZE, status: 'READ' },
    });
    const query = qc.getQueryCache().find({ queryKey: ['team-whatsapp', 'dispatch', 'd1', 'recipients', 'READ', 2] });
    expect((query?.options.refetchInterval as (q: unknown) => number | false)(query)).toBe(10_000);
    vi.restoreAllMocks();
  });

  it('useDispatchRecipients sem filtro não manda status', async () => {
    get.mockReset();
    get.mockReturnValue({ json: () => Promise.resolve(RECIPIENTS) });
    const { result } = renderHook(() => useDispatchRecipients('d1', { page: 1 }), { wrapper: wrap(new QueryClient()) });
    await waitFor(() => expect(result.current.data).toEqual(RECIPIENTS));
    expect(get).toHaveBeenCalledWith('internal/team-whatsapp/dispatches/d1/recipients', {
      searchParams: { page: 1, pageSize: RECIPIENT_PAGE_SIZE },
    });
  });

});

describe('repetir falhas', () => {
  it('useRetryRecipients faz POST retry e invalida o detalhe e o histórico', async () => {
    post.mockReset();
    post.mockReturnValue({ json: () => Promise.resolve({ requeued: 1 }) });
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRetryRecipients('d1'), { wrapper: wrap(qc) });
    await expect(result.current.mutateAsync({ all: true })).resolves.toEqual({ requeued: 1 });
    expect(post).toHaveBeenCalledWith('internal/team-whatsapp/dispatches/d1/retry', { json: { all: true } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'dispatch', 'd1'] }));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'dispatches'] });
  });
});

const retriedKey = ['team-whatsapp', 'dispatch', 'd1', 'retriedAt'];
const POLL_RECIPIENTS = { items: [], total: 0, page: 1, pageSize: RECIPIENT_PAGE_SIZE };
const intervalOf = (qc: QueryClient, queryKey: unknown[]) => {
  const query = qc.getQueryCache().find({ queryKey });
  return (query?.options.refetchInterval as (q: unknown) => number | false)(query);
};

describe('poll do resultado depois do Repetir', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it('useRetryRecipients guarda o instante do Repetir, e a entrada vive pela janela do poll', async () => {
    post.mockReset();
    post.mockReturnValue({ json: () => Promise.resolve({ requeued: 1 }) });
    const qc = new QueryClient();
    const { result } = renderHook(() => useRetryRecipients('d1'), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ all: true });
    expect(qc.getQueryData(retriedKey)).toBe(NOW);
    expect(qc.getQueryCache().find({ queryKey: retriedKey })?.options.gcTime).toBe(POLL_WINDOW_MS);
  });

  it('o poll do detalhe e o dos destinatários de um envio antigo ligam só depois do Repetir', async () => {
    get.mockReset();
    get.mockImplementation((url: string) => ({
      json: () => Promise.resolve(url.endsWith('/recipients') ? POLL_RECIPIENTS : detail(1, 3 * POLL_WINDOW_MS)),
    }));
    const qc = new QueryClient();
    const { result } = renderHook(
      () => ({ d: useTeamDispatch('d1'), r: useDispatchRecipients('d1', { page: 1 }) }), { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.r.data).toEqual(POLL_RECIPIENTS));
    await waitFor(() => expect(result.current.d.data?.id).toBe('d1'));
    const recipientsKey = ['team-whatsapp', 'dispatch', 'd1', 'recipients', undefined, 1];
    expect([intervalOf(qc, ['team-whatsapp', 'dispatch', 'd1']), intervalOf(qc, recipientsKey)]).toEqual([false, false]);
    qc.setQueryData(retriedKey, NOW - 1_000);
    expect([intervalOf(qc, ['team-whatsapp', 'dispatch', 'd1']), intervalOf(qc, recipientsKey)]).toEqual([10_000, 10_000]);
  });
});

describe('poll do resultado depois do Repetir', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it('2º Repetir dentro da janela do 1º: o instante vive 60 min a partir do 2º e o detalhe segue no poll', async () => {
    // Só o gc (setTimeout) é falso; o relógio lido pelo app vem do Date.now mockado no beforeEach.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const MIN = 60_000;
      const at = (ms: number) => vi.mocked(Date.now).mockReturnValue(NOW + ms);
      post.mockReset();
      post.mockReturnValue({ json: () => Promise.resolve({ requeued: 1 }) });
      get.mockReset();
      get.mockReturnValue({ json: () => Promise.resolve(detail(1, 3 * POLL_WINDOW_MS)) });
      const qc = new QueryClient();
      const { result } = renderHook(
        () => ({ d: useTeamDispatch('d1'), retry: useRetryRecipients('d1') }), { wrapper: wrap(qc) },
      );
      const retryNow = async () => {
        const done = result.current.retry.mutateAsync({ all: true });
        await vi.advanceTimersByTimeAsync(1);
        await done;
      };
      await vi.advanceTimersByTimeAsync(1);
      expect(intervalOf(qc, ['team-whatsapp', 'dispatch', 'd1'])).toBe(false);

      await retryNow();
      at(50 * MIN);
      await vi.advanceTimersByTimeAsync(50 * MIN);
      await retryNow();

      at(65 * MIN); // passou a janela do 1º, não a do 2º
      await vi.advanceTimersByTimeAsync(15 * MIN);
      expect(qc.getQueryData(retriedKey)).toBe(NOW + 50 * MIN);
      expect(intervalOf(qc, ['team-whatsapp', 'dispatch', 'd1'])).toBe(10_000);

      at(111 * MIN); // passou também a do 2º: o instante sai do cache e o poll para
      await vi.advanceTimersByTimeAsync(46 * MIN);
      expect(qc.getQueryData(retriedKey)).toBeUndefined();
      expect(intervalOf(qc, ['team-whatsapp', 'dispatch', 'd1'])).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
