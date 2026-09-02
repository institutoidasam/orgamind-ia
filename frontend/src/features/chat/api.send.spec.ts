import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { HTTPError } from 'ky';

// Configurable per test: success by default, rejectable for the 409 cases.
let postImpl: () => { json: () => Promise<unknown> };
vi.mock('@/lib/api-client', () => ({
  api: { post: () => postImpl() },
}));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { useSendReply } from './api';

/** Build a real ky HTTPError whose response.clone().json() resolves to `body`. */
function httpError(body: unknown, status = 409): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, {
    name: 'HTTPError',
    message: `Request failed with status code ${status}`,
    response: {
      status,
      clone: () => ({ json: () => Promise.resolve(body) }),
    },
  });
  return err;
}

const WINDOW_CLOSED_MESSAGE = 'Janela de 24h fechada — envie um template aprovado para reabrir a conversa.';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

describe('useSendReply', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
    toastError.mockClear();
    postImpl = () => ({ json: () => Promise.resolve({ id: 'm1', status: 'SENT' }) });
  });

  it('invalidates the conversation on success', async () => {
    qc.setQueryData(['chat', 'conversations', 'c1', 'messages'], { pages: [], pageParams: [] });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSendReply('c1'), { wrapper: wrapper(qc) });
    await result.current.mutateAsync({ text: 'oi' });
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  // T7 (twilio-platform): janela de 24h fechou entre o load e o envio — o
  // backend responde 409 chat.twilio_window_closed com mensagem PT-BR.
  it('mostra a mensagem PT-BR do backend em toast no 409 chat.twilio_window_closed e refetcha a conversa', async () => {
    postImpl = () => ({
      json: () =>
        Promise.reject(
          httpError({ code: 'chat.twilio_window_closed', title: 'Conflito', detail: WINDOW_CLOSED_MESSAGE, status: 409 }),
        ),
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSendReply('c1'), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync({ text: 'oi' })).rejects.toBeInstanceOf(HTTPError);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(WINDOW_CLOSED_MESSAGE));
    // Refetch da conversa → twilioWindowExpiresAt atualizado → composer flipa
    // para o estado "só template".
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('não mostra toast para outros erros de envio (o composer mostra o erro inline)', async () => {
    postImpl = () => ({
      json: () => Promise.reject(httpError({ code: 'chat.other_error', title: 'Erro', detail: 'boom', status: 500 }, 500)),
    });
    const { result } = renderHook(() => useSendReply('c1'), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync({ text: 'oi' })).rejects.toBeInstanceOf(HTTPError);
    // O onError roda async — dá um tick para garantir que NÃO toastou.
    await new Promise((r) => setTimeout(r, 10));
    expect(toastError).not.toHaveBeenCalled();
  });
});
