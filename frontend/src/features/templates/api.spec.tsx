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
  useConsentButtonChoices,
  useCreateTemplate,
  useCreateTwilioTemplate,
  useCreateZernioTemplate,
  useDeclareConsentButtons,
  useDeleteTemplate,
  useSubmitTwilioTemplate,
  useSyncTemplates,
  useSyncZernioTemplates,
  useTemplates,
  useUpdateTemplate,
  useUpdateTwilioDraft,
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

describe('sincronização e ciclo genérico', () => {
  it('sincroniza Meta e Zernio pelos endpoints distintos e invalida a mesma lista', async () => {
    postMock.mockReturnValue(jsonResponse({ synced: 2, skipped: 0 }));
    const client = queryClient();
    const { result } = renderHook(
      () => ({ meta: useSyncTemplates(), zernio: useSyncZernioTemplates() }),
      { wrapper: wrapper(client) },
    );

    await expectTemplatesInvalidated(client, result.current.meta, undefined as never);
    await expectTemplatesInvalidated(client, result.current.zernio, undefined as never);

    expect(postMock).toHaveBeenNthCalledWith(1, 'templates/sync');
    expect(postMock).toHaveBeenNthCalledWith(2, 'templates/sync/zernio');
  });

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

describe('ciclo de rascunho Twilio', () => {
  it('mantém os endpoints do fluxo de rascunho Twilio separados do CRUD genérico', async () => {
    postMock.mockReturnValue(jsonResponse({ id: 'tpl-twilio' }));
    patchMock.mockReturnValue(jsonResponse({ id: 'tpl-twilio' }));
    const client = queryClient();
    const { result } = renderHook(
      () => ({
        create: useCreateTwilioTemplate(),
        submit: useSubmitTwilioTemplate(),
        update: useUpdateTwilioDraft(),
      }),
      { wrapper: wrapper(client) },
    );
    const draft = {
      channelId: 'ch-1',
      name: 'novidade',
      language: 'pt_BR',
      category: 'MARKETING',
      body: 'Novidade',
      variables: [],
      buttons: [],
    } as never;
    const edit = { body: 'Atualizado', variables: [], buttons: [] } as never;

    await expectTemplatesInvalidated(client, result.current.create, draft);
    await expectTemplatesInvalidated(client, result.current.submit, 'tpl-twilio' as never);
    await expectTemplatesInvalidated(client, result.current.update, {
      id: 'tpl-twilio',
      input: edit,
    } as never);

    expect(postMock).toHaveBeenNthCalledWith(1, 'templates/twilio', { json: draft });
    expect(postMock).toHaveBeenNthCalledWith(2, 'templates/tpl-twilio/twilio-submit');
    expect(patchMock).toHaveBeenCalledWith('templates/tpl-twilio/twilio-draft', {
      json: edit,
    });
  });

});

describe('ciclo Zernio', () => {
  it('preserva os papéis declarados ao criar e ajustar botões Zernio', async () => {
    postMock.mockReturnValue(jsonResponse({ id: 'tpl-zernio' }));
    patchMock.mockReturnValue(jsonResponse({ id: 'tpl-zernio' }));
    const client = queryClient();
    const { result } = renderHook(
      () => ({ create: useCreateZernioTemplate(), declare: useDeclareConsentButtons() }),
      { wrapper: wrapper(client) },
    );
    const create = {
      channelId: 'ch-z',
      name: 'optin',
      language: 'pt_BR',
      category: 'MARKETING',
      body: 'Aceita?',
      bodyExamples: [],
      buttons: [{ type: 'QUICK_REPLY', text: 'Sim', role: 'OPT_IN' }],
    } as never;
    const buttons = [{ text: 'Não', role: 'OPT_OUT' }];

    await expectTemplatesInvalidated(client, result.current.create, create);
    await expectTemplatesInvalidated(client, result.current.declare, {
      id: 'tpl-zernio',
      buttons,
    } as never);

    expect(postMock).toHaveBeenCalledWith('templates/zernio', { json: create });
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

  it('propaga erro do cliente e não invalida uma lista quando a sincronização falha', async () => {
    postMock.mockReturnValue({ json: () => Promise.reject(new Error('offline')) });
    const client = queryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSyncTemplates(), {
      wrapper: wrapper(client),
    });

    await expect(result.current.mutateAsync()).rejects.toThrow('offline');

    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('vocabulário de consentimento', () => {
  it('aceita somente a resposta estruturada servida pelo backend', async () => {
    getMock.mockReturnValue(
      jsonResponse({ optIn: ['Sim, autorizo'], optOut: ['Não quero mais'] }),
    );
    const client = queryClient();
    const { result } = renderHook(() => useConsentButtonChoices(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getMock).toHaveBeenCalledWith('templates/consent-buttons');
    expect(result.current.data).toEqual({
      optIn: ['Sim, autorizo'],
      optOut: ['Não quero mais'],
    });
  });

  it('rejeita uma resposta inválida em vez de oferecer rótulos locais', async () => {
    getMock.mockReturnValue(jsonResponse({ optIn: ['Sim'] }));
    const client = queryClient();
    const { result } = renderHook(() => useConsentButtonChoices(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 2_500 });

    expect(result.current.error).toBeTruthy();
  });
});
