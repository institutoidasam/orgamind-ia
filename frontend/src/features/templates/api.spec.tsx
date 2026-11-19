import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

import {
  useCreateTemplate,
  useDeclareConsentButtons,
  useDeleteTemplate,
  useTemplates,
  useUpdateTemplate,
} from './api';

function jsonResponse(value: unknown) {
  return { json: () => Promise.resolve(value) };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

async function expectTemplatesInvalidated(
  client: QueryClient,
  mutation: { mutateAsync: (input: never) => Promise<unknown> },
  input: never,
) {
  const invalidate = vi.spyOn(client, 'invalidateQueries');

  await mutation.mutateAsync(input);

  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['templates'] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listagem de templates', () => {
  it('busca a lista completa sem parâmetro quando nenhum provedor foi escolhido', async () => {
    getMock.mockReturnValue(jsonResponse([]));
    const client = queryClient();
    const { result } = renderHook(() => useTemplates(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('templates', undefined);
    expect(result.current.data).toEqual([]);
  });

  it('serializa o filtro de provedor sem mudar a chave da família templates', async () => {
    getMock.mockReturnValue(jsonResponse([]));
    const client = queryClient();
    const { result } = renderHook(() => useTemplates('ZERNIO'), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('templates', {
      searchParams: { provider: 'ZERNIO' },
    });
  });
});

describe('ciclo genérico', () => {
  it('envia o payload genérico intacto ao criar e ao editar', async () => {
    postMock.mockReturnValue(jsonResponse({ id: 'tpl-1' }));
    patchMock.mockReturnValue(jsonResponse({ id: 'tpl-1' }));
    const client = queryClient();
    const { result } = renderHook(
      () => ({ create: useCreateTemplate(), update: useUpdateTemplate() }),
      { wrapper: wrapper(client) },
    );
    const create = {
      metaName: 'lembrete',
      language: 'pt_BR',
      body: 'Olá',
      category: 'UTILITY',
      kind: 'TEXT',
      provider: 'EVOLUTION',
    } as never;
    const update = { language: 'en_US', status: 'PAUSED' } as never;

    await expectTemplatesInvalidated(client, result.current.create, create);
    await expectTemplatesInvalidated(client, result.current.update, {
      id: 'tpl-1',
      input: update,
    } as never);

    expect(postMock).toHaveBeenCalledWith('templates', { json: create });
    expect(patchMock).toHaveBeenCalledWith('templates/tpl-1', { json: update });
  });
});

describe('botões de consentimento', () => {
  it('preserva os papéis declarados ao ajustar os botões', async () => {
    patchMock.mockReturnValue(jsonResponse({ id: 'tpl-zernio' }));
    const client = queryClient();
    const { result } = renderHook(() => useDeclareConsentButtons(), {
      wrapper: wrapper(client),
    });
    const buttons = [{ text: 'Não', role: 'OPT_OUT' }];

    await expectTemplatesInvalidated(client, result.current, {
      id: 'tpl-zernio',
      buttons,
    } as never);

    expect(patchMock).toHaveBeenCalledWith('templates/tpl-zernio/consent-buttons', {
      json: { buttons },
    });
  });

});

describe('remoção e falhas', () => {
  it('remove pelo identificador e invalida a lista', async () => {
    deleteMock.mockReturnValue(jsonResponse({ id: 'tpl-1' }));
    const client = queryClient();
    const { result } = renderHook(() => useDeleteTemplate(), {
      wrapper: wrapper(client),
    });

    await expectTemplatesInvalidated(client, result.current, 'tpl-1' as never);

    expect(deleteMock).toHaveBeenCalledWith('templates/tpl-1');
  });

  it('propaga erro do cliente e não invalida a lista quando a criação falha', async () => {
    postMock.mockReturnValue({ json: () => Promise.reject(new Error('offline')) });
    const client = queryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateTemplate(), {
      wrapper: wrapper(client),
    });

    await expect(result.current.mutateAsync({} as never)).rejects.toThrow('offline');

    expect(invalidate).not.toHaveBeenCalled();
  });
});
