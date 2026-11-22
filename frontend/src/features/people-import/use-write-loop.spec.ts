import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { HTTPError, NetworkError, TimeoutError } from 'ky';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useImportBatch } from './api';
import { progress, writingBatch } from './write-test-helpers';
import type { BatchSummary } from './schemas';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));

import { useWriteLoop } from './use-write-loop';

const WRITE_URL = 'internal/people-import/batches/b1/write';
const request = () => new Request('https://x');
const DONE = writingBatch({
  situation: 'COMPLETED',
  canContinue: false,
  progress: progress({ created: 300 }),
});
const half = (created: number) => writingBatch({ progress: progress({ created, pending: 300 - created }) });

function httpError(status: number, data?: unknown, headers?: Record<string, string>): HTTPError {
  const error = new HTTPError(new Response(null, { status, headers }), request(), {} as never);
  error.data = data as HTTPError['data'];
  return error;
}

/** Cada chamada a `post` consome o próximo resultado: resumo (resolve) ou erro (rejeita). */
function queue(...results: Array<BatchSummary | Error>) {
  results.forEach((result) =>
    mocks.post.mockReturnValueOnce({
      json: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
    }),
  );
}

function setup(batch: BatchSummary = writingBatch()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook(
    ({ current }) => ({
      loop: useWriteLoop(current),
      cached: useImportBatch(current.id),
    }),
    {
      wrapper,
      initialProps: { current: batch },
    },
  );
  return {
    ...view,
    loop: () => view.result.current.loop,
    cached: () => view.result.current.cached.data,
  };
}

/** Deixa os timers falsos e as promessas encadeadas andarem `ms` (o laço espera em `setTimeout`). */
const elapse = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ json: () => Promise.resolve(writingBatch()) });
});
afterEach(() => vi.useRealTimers());

describe('useWriteLoop: lote sem avanço', () => {
  it('resposta repetida (nada processado, nada reservado a mais): espera 5 s antes do próximo bloco', async () => {
    queue(half(120), half(120), DONE);
    const view = setup();

    act(() => view.loop().start());
    await elapse(0);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await elapse(4_999);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await elapse(1);

    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(view.loop().summary.situation).toBe('COMPLETED');
  });
});

describe('useWriteLoop: limites do Retry-After', () => {
  it('0 vira 1 s e 999 vira o teto de 120 s', async () => {
    queue(httpError(429, undefined, { 'Retry-After': '0' }), httpError(429, undefined, { 'Retry-After': '999' }), DONE);
    const view = setup();

    act(() => view.loop().start());
    await elapse(999);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await elapse(119_999);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await elapse(1);

    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(view.loop().summary.situation).toBe('COMPLETED');
  });
});

describe('useWriteLoop: outras falhas', () => {
  it('erro que não é 403 mostra o detail da API e para', async () => {
    const detail = 'O lote ficou inconsistente.';
    queue(httpError(422, { code: 'people_import.inconsistent', detail }));
    const view = setup();

    act(() => view.loop().start());
    await elapse(60_000);

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(view.loop().error).toBe(detail);
    expect(view.loop().running).toBe(false);
  });

  it('tempo esgotado e a consulta acha o lote COMPLETED: para sem esperar os 5 s', async () => {
    queue(new TimeoutError(request()));
    mocks.get.mockReturnValue({ json: () => Promise.resolve(DONE) });
    const view = setup();

    act(() => view.loop().start());
    await elapse(0);

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(view.loop().summary.situation).toBe('COMPLETED');
    expect(view.loop().running).toBe(false);
    expect(view.loop().error).toBeNull();
  });
});

describe('useWriteLoop: andamento', () => {
  it('pede blocos até acabar', async () => {
    queue(half(120), half(240), DONE);
    const view = setup();

    act(() => view.loop().start());
    await elapse(0);

    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(mocks.post).toHaveBeenCalledWith(WRITE_URL, expect.anything());
    expect(view.loop().summary.situation).toBe('COMPLETED');
    expect(view.loop().running).toBe(false);
    expect(view.cached()?.situation).toBe('COMPLETED');
  });

  it('só reservadas por outro pedido: espera 5 s', async () => {
    queue(
      writingBatch({
        progress: progress({ pending: 0, writing: 20, created: 100 }),
      }),
      DONE,
    );
    const view = setup();

    act(() => view.loop().start());
    await elapse(4_999);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await elapse(1);

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(view.loop().summary.situation).toBe('COMPLETED');
  });
});

describe('useWriteLoop: o que repete', () => {
  it('tempo esgotado ou rede: consulta o andamento e pede de novo', async () => {
    queue(new TimeoutError(request()), new NetworkError(request()), DONE);
    mocks.get.mockReturnValue({ json: () => Promise.resolve(half(150)) });
    const view = setup();

    act(() => view.loop().start());
    await elapse(4_999);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(view.loop().summary.progress?.created).toBe(150);
    await elapse(1);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await elapse(5_000);

    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(view.loop().summary.situation).toBe('COMPLETED');
    expect(view.loop().error).toBeNull();
  });

  it('429: espera o Retry-After (ou 10 s) e pede de novo, sem erro na tela', async () => {
    queue(
      httpError(429, undefined, { 'Retry-After': '7' }),
      httpError(429),
      httpError(429, undefined, { 'Retry-After': 'logo' }),
      DONE,
    );
    const view = setup();

    act(() => view.loop().start());
    await elapse(6_999);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await elapse(9_999);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await elapse(1);
    expect(mocks.post).toHaveBeenCalledTimes(3);
    await elapse(10_000);

    expect(mocks.post).toHaveBeenCalledTimes(4);
    expect(view.loop().error).toBeNull();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});

describe('useWriteLoop: o que para', () => {
  it('403: para com Gravação interrompida e o texto da API', async () => {
    const detail = 'Você não tem permissão para importar planilhas de pessoas.';
    queue(httpError(403, { code: 'auth.permission_denied', detail }));
    const view = setup();

    act(() => view.loop().start());
    await elapse(60_000);

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(view.loop().error).toBe(detail);
    expect(view.loop().running).toBe(false);
  });

  it('409 not_writing: recarrega o resumo e para', async () => {
    queue(httpError(409, { code: 'people_import.not_writing' }));
    mocks.get.mockReturnValue({ json: () => Promise.resolve(DONE) });
    const view = setup();

    act(() => view.loop().start());
    await elapse(60_000);

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(view.loop().summary.situation).toBe('COMPLETED');
    expect(view.loop().error).toBeNull();
    expect(view.loop().running).toBe(false);
  });
});

describe('useWriteLoop: um bloco por vez', () => {
  it('não abre um segundo pedido enquanto o primeiro espera e para ao desmontar', async () => {
    const replies: Array<(summary: BatchSummary) => void> = [];
    mocks.post.mockReturnValueOnce({
      json: () =>
        new Promise<BatchSummary>((resolve) => {
          replies.push(resolve);
        }),
    });
    const view = setup();

    act(() => view.loop().start());
    act(() => view.loop().start());
    await elapse(130_000);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    view.unmount();
    replies[0](half(120));
    await elapse(60_000);

    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('adota o resumo novo do pai quando não está gravando', () => {
    const view = setup();

    view.rerender({ current: DONE });

    expect(view.loop().summary.situation).toBe('COMPLETED');
  });
});
