// frontend/src/features/campaigns/api.spec.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import React from 'react';
import type { CreateCampaign } from './schemas';

const postSpy = vi.fn(() => ({
  json: () =>
    Promise.resolve({
      recipients: 3,
      reachability: { total: 3, reachable: 3, invalid: 0, unknown: 0 },
      checks: [{ code: 'VOLUME', severity: 'info', message: 'ok' }],
    }),
}));

const getSpy = vi.fn(() => ({
  json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 50 }),
}));

const deleteSpy = vi.fn(() => ({
  json: () => Promise.resolve({ deleted: true, id: 'camp-1' }),
}));

vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => getSpy(...args),
    post: (...args: unknown[]) => postSpy(...(args as [])),
    delete: (...args: unknown[]) => deleteSpy(...args),
  },
}));

import {
  campaignsQueries,
  useBatchSummary,
  useCampaign,
  useCampaignBatches,
  useCampaigns,
  useCampaignRecipients,
  useCampaignMessages,
  useCancelCampaign,
  useCreateCampaign,
  useDeleteCampaign,
  usePreflightByFilters,
  usePreflightCampaignChecks,
  usePreviewCampaign,
  useDependentSegments,
  useCampaignFailureReasons,
  useLiveCampaignsIndicator,
  useRedispatchMessage,
  useRedispatchCampaign,
  useRetryFailed,
  useRetryMessage,
  useRunCampaign,
  useSendBatch,
  useSendFirstBatch,
  useCampaignWaiting,
} from './api';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

function testClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function primeCampaignCache(qc: QueryClient, campaignId = 'camp-1') {
  qc.setQueryData(['campaigns'], []);
  qc.setQueryData(['campaigns', campaignId], { id: campaignId });
  qc.setQueryData(['campaigns', campaignId, 'messages', { page: 1 }], []);
  qc.setQueryData(['contacts'], []);
}

function expectCampaignTreeInvalidated(qc: QueryClient, campaignId?: string) {
  const campaignEntries = qc
    .getQueryCache()
    .findAll({ queryKey: ['campaigns'] });
  const targetedEntries = campaignId
    ? campaignEntries.filter(
        (entry) =>
          entry.queryKey[1] == null || entry.queryKey[1] === campaignId,
      )
    : campaignEntries;
  expect(targetedEntries.every((entry) => entry.state.isInvalidated)).toBe(true);
  expect(
    qc.getQueryCache().find({ queryKey: ['contacts'] })?.state.isInvalidated,
  ).toBe(false);
  if (campaignId) {
    expect(
      qc
        .getQueryCache()
        .find({ queryKey: ['campaigns', campaignId] })?.state.isInvalidated,
    ).toBe(true);
  }
}

/**
 * Reads the resolved `refetchInterval` for the single messages query that the
 * hook registers in the cache. `refetchInterval` may be a static value or a
 * function of the query — normalise both to the effective number/false.
 */
function resolvedRefetchInterval(qc: QueryClient): number | false {
  const entry = qc.getQueryCache().getAll()[0];
  const ri = entry?.options.refetchInterval as
    | number
    | false
    | ((q: unknown) => number | false)
    | undefined;
  const value = typeof ri === 'function' ? ri(entry) : ri;
  return value ?? false;
}

describe('campaign API query contracts', () => {
  afterEach(() => {
    getSpy.mockClear();
  });

  it('loads campaign lists and details through their public query options', async () => {
    const qc = testClient();
    getSpy
      .mockReturnValueOnce({ json: () => Promise.resolve([]) })
      .mockReturnValueOnce({ json: () => Promise.resolve({ id: 'camp-1' }) });

    await qc.fetchQuery(campaignsQueries.list());
    await qc.fetchQuery(campaignsQueries.detail('camp-1'));

    expect(getSpy).toHaveBeenNthCalledWith(1, 'campaigns');
    expect(getSpy).toHaveBeenNthCalledWith(2, 'campaigns/camp-1');
  });

  it('exposes a campaign list and preserves an HTTP failure for its consumers', async () => {
    const qc = testClient();
    const campaign = { id: 'camp-1', name: 'Aviso mensal' };
    getSpy.mockReturnValueOnce({ json: () => Promise.resolve([campaign]) });
    const { result, unmount } = renderHook(() => useCampaigns(), {
      wrapper: wrapper(qc),
    });

    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([campaign]);
    expect(getSpy).toHaveBeenCalledWith('campaigns');
    unmount();

    const offline = new Error('offline');
    getSpy.mockReturnValueOnce({ json: () => Promise.reject(offline) });
    const failedClient = testClient();
    const failed = renderHook(() => useCampaigns(), {
      wrapper: wrapper(failedClient),
    });

    await vi.waitFor(() => expect(failed.result.current.isError).toBe(true));
    expect(failed.result.current.error).toBe(offline);
  });

  it('polls the live indicator every 15 seconds and maps running campaigns', () => {
    const qc = testClient();
    renderHook(() => useLiveCampaignsIndicator(), { wrapper: wrapper(qc) });
    const query = qc.getQueryCache().getAll()[0];
    const select = query?.options.select as (data: { status: string }[]) => boolean;

    expect(query?.options.refetchInterval).toBe(15_000);
    expect(select([{ status: 'RUNNING' }])).toBe(true);
    expect(select([{ status: 'DRAFT' }])).toBe(false);
  });
});

describe('useCampaign polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls initial and active campaigns, but stops for errors and terminal states', () => {
    const qc = testClient();
    renderHook(() => useCampaign('camp-1'), { wrapper: wrapper(qc) });
    const query = qc.getQueryCache().getAll()[0];
    const interval = query?.options.refetchInterval as (value: {
      state: { status: string; data?: { status: string } };
    }) => number | false;

    expect(interval({ state: { status: 'pending' } })).toBe(2_000);
    expect(interval({ state: { status: 'success', data: { status: 'QUEUED' } } })).toBe(2_000);
    expect(interval({ state: { status: 'success', data: { status: 'RUNNING' } } })).toBe(2_000);
    expect(interval({ state: { status: 'success', data: { status: 'COMPLETED' } } })).toBe(false);
    expect(interval({ state: { status: 'error' } })).toBe(false);
  });

  it('stops campaign polling after thirty minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    const qc = testClient();
    renderHook(() => useCampaign('camp-1'), { wrapper: wrapper(qc) });
    const interval = qc.getQueryCache().getAll()[0]?.options
      .refetchInterval as (value: { state: { status: string } }) => number | false;

    vi.setSystemTime(new Date('2026-08-24T12:30:01.000Z'));
    expect(interval({ state: { status: 'success' } })).toBe(false);
  });
});

describe('useCampaignMessages polling', () => {
  it('polls every 5s while the campaign is live', () => {
    const qc = new QueryClient();
    renderHook(
      () => useCampaignMessages('c1', { page: 1, pageSize: 50 }, { live: true }),
      { wrapper: wrapper(qc) },
    );
    expect(resolvedRefetchInterval(qc)).toBe(5_000);
  });

  it('does not poll for a terminal (non-live) campaign', () => {
    const qc = new QueryClient();
    renderHook(
      () => useCampaignMessages('c1', { page: 1, pageSize: 50 }, { live: false }),
      { wrapper: wrapper(qc) },
    );
    expect(resolvedRefetchInterval(qc)).toBe(false);
  });

  it('defaults to no polling when liveness is unspecified', () => {
    const qc = new QueryClient();
    renderHook(
      () => useCampaignMessages('c1', { page: 1, pageSize: 50 }),
      { wrapper: wrapper(qc) },
    );
    expect(resolvedRefetchInterval(qc)).toBe(false);
  });
});

// Reproduces the bug: when useCampaignMessages cache key includes a query
// object, the wildcard ['campaigns', id, 'messages'] invalidation does
// not match it.
describe('campaigns cache invalidation', () => {
  it('predicate match invalidates messages queries that include query params', () => {
    const qc = new QueryClient();

    // Simulate two messages queries with different filter params
    qc.setQueryData(
      ['campaigns', 'c1', 'messages', { page: 1, status: 'FAILED', q: '' }],
      { items: [], total: 0 },
    );
    qc.setQueryData(
      ['campaigns', 'c1', 'messages', { page: 1, status: 'SENT', q: 'a' }],
      { items: [], total: 0 },
    );

    qc.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] === 'campaigns' && q.queryKey[1] === 'c1',
    });

    const states = qc
      .getQueryCache()
      .findAll({ queryKey: ['campaigns', 'c1'] })
      .map((q) => q.state.isInvalidated);
    expect(states).toEqual([true, true]);
  });

  it('exact match key fails to invalidate keys that include extra params (legacy behavior)', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      ['campaigns', 'c1', 'messages', { page: 1, status: 'FAILED', q: '' }],
      { items: [], total: 0 },
    );
    qc.invalidateQueries({
      queryKey: ['campaigns', 'c1', 'messages'],
      exact: true,
    });
    const found = qc
      .getQueryCache()
      .findAll({ queryKey: ['campaigns', 'c1', 'messages'], exact: true });
    expect(found.length).toBe(0);
  });
});

/**
 * ★ A prévia e o template.
 *
 * `templateId` é obrigatório no TIPO (o esquecimento dele foi o que fez a tela
 * de confirmação prometer 500 e o disparo fazer 88), mas o CONTRATO do backend
 * é `z.string().min(1).optional()`: aceita a string ou a ausência do campo —
 * um `null` no corpo é 400. Quem declara "não há template" com `null` não pode
 * levar um erro por isso; a normalização mora aqui, num lugar só.
 */
describe('usePreviewCampaign', () => {
  const FILTERS = { combinator: 'and' as const, rules: [] };

  it('leva o templateId ao backend quando há template', async () => {
    postSpy.mockClear();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePreviewCampaign(), {
      wrapper: wrapper(qc),
    });

    await result.current.mutateAsync({
      filters: FILTERS,
      limit: 200,
      templateId: 'tpl-T',
    });

    expect(postSpy).toHaveBeenCalledWith('campaigns/preview', {
      json: {
        filters: FILTERS,
        limit: 200,
        templateId: 'tpl-T',
        excludeAnyPreviousCampaign: false,
      },
    });
  });

  it('OMITE o campo quando não há template (um null no corpo seria 400)', async () => {
    postSpy.mockClear();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePreviewCampaign(), {
      wrapper: wrapper(qc),
    });

    await result.current.mutateAsync({
      filters: FILTERS,
      limit: null,
      templateId: null,
    });

    expect(postSpy).toHaveBeenCalledWith('campaigns/preview', {
      json: { filters: FILTERS, limit: null, excludeAnyPreviousCampaign: false },
    });
  });

  /**
   * ★ Pedido do cliente 2026-08-25 — "excluir quem já recebeu parece não
   * funcionar": o campo existia no contrato do backend
   * (`campaign.schema.ts`) mas nenhuma chamada do frontend o enviava. A
   * prévia leva o MESMO valor que o create vai levar — senão a tela promete
   * um número e o disparo materializa outro.
   */
  it('leva excludeAnyPreviousCampaign:true quando o operador liga a opção', async () => {
    postSpy.mockClear();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePreviewCampaign(), {
      wrapper: wrapper(qc),
    });

    await result.current.mutateAsync({
      filters: FILTERS,
      limit: 200,
      templateId: 'tpl-T',
      excludeAnyPreviousCampaign: true,
    });

    expect(postSpy).toHaveBeenCalledWith('campaigns/preview', {
      json: {
        filters: FILTERS,
        limit: 200,
        templateId: 'tpl-T',
        excludeAnyPreviousCampaign: true,
      },
    });
  });
});

describe('usePreflightCampaignChecks', () => {
  it('POSTs to campaigns/preflight-checks and resolves the send-analysis result', async () => {
    postSpy.mockClear();
    const qc = new QueryClient();
    const { result } = renderHook(() => usePreflightCampaignChecks(), {
      wrapper: wrapper(qc),
    });

    const input = {
      filters: { combinator: 'and' as const, rules: [] },
      defaultInstanceId: 'i1',
      schedule: { type: 'IMMEDIATE' as const },
      timezone: 'America/Sao_Paulo',
    };
    const res = await result.current.mutateAsync(input);

    expect(postSpy).toHaveBeenCalledWith('campaigns/preflight-checks', {
      json: input,
    });
    expect(res).toEqual({
      recipients: 3,
      reachability: { total: 3, reachable: 3, invalid: 0, unknown: 0 },
      checks: [{ code: 'VOLUME', severity: 'info', message: 'ok' }],
    });
  });
});

// F1 T9 — alimenta o aviso de "apagar campanha" (segmentos dependentes).
describe('useDependentSegments', () => {
  it('busca campaigns/:id/dependent-segments', async () => {
    getSpy.mockClear();
    getSpy.mockReturnValueOnce({
      json: () =>
        Promise.resolve([{ id: 'seg-1', name: 'Já receberam a campanha X' }]),
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => useDependentSegments('camp-1'), {
      wrapper: wrapper(qc),
    });

    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getSpy).toHaveBeenCalledWith('campaigns/camp-1/dependent-segments');
    expect(result.current.data).toEqual([
      { id: 'seg-1', name: 'Já receberam a campanha X' },
    ]);
  });

  it('não busca quando enabled:false (o diálogo de apagar ainda está fechado)', () => {
    getSpy.mockClear();
    const qc = new QueryClient();
    renderHook(
      () => useDependentSegments('camp-1', { enabled: false }),
      { wrapper: wrapper(qc) },
    );

    expect(getSpy).not.toHaveBeenCalled();
  });
});

/**
 * F2 — o resumo "por que falhou" da aba de falhas. O endpoint existia no
 * backend desde o F2 T7 e não tinha UM consumidor no front; o teste fixa a
 * rota (`campaigns/:id/failure-reasons`) e o gating por aba.
 */
describe('useCampaignFailureReasons', () => {
  it('busca campaigns/:id/failure-reasons', async () => {
    getSpy.mockClear();
    getSpy.mockReturnValueOnce({
      json: () =>
        Promise.resolve([
          {
            failureReason: 'CANAL_FORA',
            count: 12,
            label: 'Canal fora do ar ou desautorizado',
          },
        ]),
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => useCampaignFailureReasons('camp-1'), {
      wrapper: wrapper(qc),
    });

    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getSpy).toHaveBeenCalledWith('campaigns/camp-1/failure-reasons');
    expect(result.current.data).toEqual([
      {
        failureReason: 'CANAL_FORA',
        count: 12,
        label: 'Canal fora do ar ou desautorizado',
      },
    ]);
  });

  it('não busca enquanto a aba de falhas está fechada (enabled:false)', () => {
    getSpy.mockClear();
    const qc = new QueryClient();
    renderHook(
      () => useCampaignFailureReasons('camp-1', { enabled: false }),
      { wrapper: wrapper(qc) },
    );

    expect(getSpy).not.toHaveBeenCalled();
  });
});

/**
 * ★ CRÍTICO — "Disparar de novo para TODOS" é a ÚNICA ação que a Fase A
 * deixa repetir de propósito (spec A.5). O bug: `useRedispatchCampaign`
 * fazia POST sem corpo, então `RedispatchCampaignDto.resendToAll` caía no
 * default `false` no backend — o service usava o recorte `unreached`
 * (`campaigns.service.ts:1633-1636`), e com `pending = 0` o operador digitava
 * o número de quem já recebeu e levava um 409 "não há destinatários
 * pendentes". A confirmação digitada continua exigindo o número de quem já
 * recebeu (ver campaign-progress-header.tsx) — só o CORPO do POST estava
 * mentindo sobre o que ia acontecer.
 *
 * Este teste asserta o CORPO do POST, não só que a mutation foi chamada: um
 * teste que só checasse `postSpy` ter sido chamado passaria mesmo sem o
 * corpo, porque a chamada sem `json` também "acontece".
 */
describe('useRedispatchCampaign — "Disparar de novo para TODOS" tem de reenviar a TODOS', () => {
  it('POSTs { resendToAll: true } no corpo de campaigns/:id/redispatch', async () => {
    postSpy.mockClear();
    postSpy.mockReturnValueOnce({
      json: () => Promise.resolve({ queued: 500, skippedAlreadyLive: 0 }),
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => useRedispatchCampaign('camp-1'), {
      wrapper: wrapper(qc),
    });

    await result.current.mutateAsync({ resendToAll: true });

    expect(postSpy).toHaveBeenCalledWith('campaigns/camp-1/redispatch', {
      json: { resendToAll: true },
    });
  });
});

/**
 * Fix round (achado 6, review final) — a versão inline que existia antes de
 * `useCampaignWaiting` virar hook compartilhado parava de sondar em erro e
 * depois de 30 minutos (`$campaignId.tsx`, removida no commit que criou o
 * cabeçalho de progresso). O hook novo perdeu as duas guardas: virou um
 * `refetchInterval: opts.live ? 8_000 : false` fixo, que sonda para sempre
 * enquanto `live` for `true` — inclusive contra um endpoint que só devolve
 * erro, e numa aba aberta por horas.
 */
describe('useCampaignWaiting polling', () => {
  function getRefetchIntervalFn(qc: QueryClient) {
    const entry = qc.getQueryCache().getAll()[0];
    const ri = entry?.options.refetchInterval as
      | number
      | false
      | ((q: unknown) => number | false)
      | undefined;
    if (typeof ri !== 'function') {
      throw new Error('refetchInterval não é uma função — era fixo em 8_000');
    }
    return ri;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('usa um refetchInterval em forma de função, não um número fixo', () => {
    const qc = new QueryClient();
    renderHook(() => useCampaignWaiting('c1', { live: true }), {
      wrapper: wrapper(qc),
    });
    expect(() => getRefetchIntervalFn(qc)).not.toThrow();
  });

  it('continua sondando a cada 8s enquanto live:true e sem erro', () => {
    const qc = new QueryClient();
    renderHook(() => useCampaignWaiting('c1', { live: true }), {
      wrapper: wrapper(qc),
    });
    const fn = getRefetchIntervalFn(qc);
    expect(fn({ state: { status: 'success' } })).toBe(8_000);
  });

  it('não sonda quando live:false (campanha terminal)', () => {
    const qc = new QueryClient();
    renderHook(() => useCampaignWaiting('c1', { live: false }), {
      wrapper: wrapper(qc),
    });
    const fn = getRefetchIntervalFn(qc);
    expect(fn({ state: { status: 'success' } })).toBe(false);
  });

  it('para de sondar quando a query está em erro, mesmo com live:true', () => {
    const qc = new QueryClient();
    renderHook(() => useCampaignWaiting('c1', { live: true }), {
      wrapper: wrapper(qc),
    });
    const fn = getRefetchIntervalFn(qc);
    expect(fn({ state: { status: 'error' } })).toBe(false);
  });

  it('para de sondar depois de 30 minutos de aba aberta', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    const qc = new QueryClient();
    renderHook(() => useCampaignWaiting('c1', { live: true }), {
      wrapper: wrapper(qc),
    });
    const fn = getRefetchIntervalFn(qc);
    expect(fn({ state: { status: 'success' } })).toBe(8_000);

    vi.setSystemTime(new Date('2026-08-24T12:30:01.000Z')); // 30min + 1s
    expect(fn({ state: { status: 'success' } })).toBe(false);
  });
});

describe('campaign command contracts', () => {
  afterEach(() => {
    postSpy.mockClear();
    deleteSpy.mockClear();
  });

  it('creates a campaign and refreshes every campaign view', async () => {
    const qc = testClient();
    primeCampaignCache(qc);
    const { result } = renderHook(() => useCreateCampaign(), {
      wrapper: wrapper(qc),
    });
    const input: CreateCampaign = {
      name: 'Aviso mensal',
      templateId: 'template-1',
      defaultInstanceId: 'cm9qs0mqw000008l64jkf7fl8',
      filters: { combinator: 'and', rules: [] },
      variableMap: {},
      schedule: { type: 'IMMEDIATE' },
      timezone: 'America/Manaus',
      excludeAnyPreviousCampaign: true,
    };

    await result.current.mutateAsync(input);

    expect(postSpy).toHaveBeenCalledWith('campaigns', { json: input });
    expectCampaignTreeInvalidated(qc);
  });

  it('deletes a campaign and refreshes the inbox alongside campaign views', async () => {
    const qc = testClient();
    primeCampaignCache(qc);
    qc.setQueryData(['chat', 'conversations'], []);
    const { result } = renderHook(() => useDeleteCampaign(), {
      wrapper: wrapper(qc),
    });

    await result.current.mutateAsync('camp-1');

    expect(deleteSpy).toHaveBeenCalledWith('campaigns/camp-1');
    expectCampaignTreeInvalidated(qc);
    expect(
      qc
        .getQueryCache()
        .findAll({ queryKey: ['chat'] })
        .every((entry) => entry.state.isInvalidated),
    ).toBe(true);
  });

  it('runs and cancels only the affected campaign tree', async () => {
    const qc = testClient();
    primeCampaignCache(qc);
    qc.setQueryData(['campaigns', 'camp-2'], { id: 'camp-2' });
    const run = renderHook(() => useRunCampaign(), { wrapper: wrapper(qc) });
    const cancel = renderHook(() => useCancelCampaign(), { wrapper: wrapper(qc) });

    await run.result.current.mutateAsync('camp-1');
    await cancel.result.current.mutateAsync('camp-1');

    expect(postSpy).toHaveBeenCalledWith('campaigns/camp-1/run');
    expect(postSpy).toHaveBeenCalledWith('campaigns/camp-1/cancel');
    expectCampaignTreeInvalidated(qc, 'camp-1');
    expect(
      qc.getQueryCache().find({ queryKey: ['campaigns', 'camp-2'] })?.state
        .isInvalidated,
    ).toBe(false);
  });

  it('retries, redispatches and retries failures through their campaign endpoints', async () => {
    const qc = testClient();
    primeCampaignCache(qc);
    const retry = renderHook(() => useRetryMessage('camp-1'), { wrapper: wrapper(qc) });
    const redispatch = renderHook(() => useRedispatchMessage('camp-1'), { wrapper: wrapper(qc) });
    const failed = renderHook(() => useRetryFailed('camp-1'), { wrapper: wrapper(qc) });

    await retry.result.current.mutateAsync('message-1');
    await redispatch.result.current.mutateAsync('message-1');
    await failed.result.current.mutateAsync();

    expect(postSpy).toHaveBeenCalledWith('campaigns/messages/message-1/retry');
    expect(postSpy).toHaveBeenCalledWith('campaigns/messages/message-1/redispatch');
    expect(postSpy).toHaveBeenCalledWith('campaigns/camp-1/retry-failed');
    expectCampaignTreeInvalidated(qc, 'camp-1');
  });

  it('sends later batches and the wizard first batch with the requested size', async () => {
    const qc = testClient();
    primeCampaignCache(qc);
    const batch = renderHook(() => useSendBatch('camp-1'), { wrapper: wrapper(qc) });
    const firstBatch = renderHook(() => useSendFirstBatch(), { wrapper: wrapper(qc) });

    await batch.result.current.mutateAsync(25);
    await firstBatch.result.current.mutateAsync({ campaignId: 'camp-1', size: 10 });

    expect(postSpy).toHaveBeenCalledWith('campaigns/camp-1/batches', { json: { size: 25 } });
    expect(postSpy).toHaveBeenCalledWith('campaigns/camp-1/batches', { json: { size: 10 } });
    expectCampaignTreeInvalidated(qc, 'camp-1');
  });

  it('surfaces API failures to the wizard instead of treating preflight as successful', async () => {
    postSpy.mockReturnValueOnce({ json: () => Promise.reject(new Error('offline')) });
    const qc = testClient();
    const { result } = renderHook(() => usePreflightByFilters(), {
      wrapper: wrapper(qc),
    });

    await expect(
      result.current.mutateAsync({ combinator: 'and', rules: [] }),
    ).rejects.toThrow('offline');
  });
});

describe('campaign list endpoints', () => {
  afterEach(() => {
    getSpy.mockClear();
  });

  it('serializes message filters into the messages endpoint', async () => {
    const qc = testClient();
    const { result } = renderHook(
      () =>
        useCampaignMessages('camp-1', {
          page: 2,
          pageSize: 25,
          status: 'FAILED',
          search: 'Ana Silva',
        }),
      { wrapper: wrapper(qc) },
    );

    await vi.waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getSpy).toHaveBeenCalledWith(
      'campaigns/camp-1/messages?page=2&pageSize=25&status=FAILED&search=Ana+Silva',
    );
  });

  it('uses the summary, batch history and recipient contracts for one campaign', async () => {
    const qc = testClient();
    const { result } = renderHook(
      () => ({
        summary: useBatchSummary('camp-1', { live: true }),
        batches: useCampaignBatches('camp-1', { live: true }),
        recipients: useCampaignRecipients('camp-1', {
          group: 'SENT',
          page: 3,
          pageSize: 20,
        }),
      }),
      { wrapper: wrapper(qc) },
    );

    await vi.waitFor(() => expect(result.current.summary.isSuccess).toBe(true));
    expect(getSpy).toHaveBeenCalledWith('campaigns/camp-1/batch-summary');
    expect(getSpy).toHaveBeenCalledWith('campaigns/camp-1/batches');
    expect(getSpy).toHaveBeenCalledWith(
      'campaigns/camp-1/recipients?group=SENT&page=3&pageSize=20',
    );
  });
});
