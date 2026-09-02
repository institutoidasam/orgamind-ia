import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

// --- mock the auth store with a tiny mutable getState + subscribe ---
type Listener = (s: { accessToken: string | null }, p: { accessToken: string | null }) => void;
let token: string | null = 'tok-initial';
const listeners = new Set<Listener>();
const setToken = (next: string | null) => {
  const prev = token;
  token = next;
  for (const l of listeners) l({ accessToken: token }, { accessToken: prev });
};
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: token }),
    subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l); },
  },
}));

// --- capture the fetchEventSource calls so we can drive onopen / inspect fetch ---
type FesInit = {
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  onopen?: (res: Response) => Promise<void>;
  onmessage?: (ev: { data: string }) => void;
  onerror?: (err: unknown) => number | void;
  signal?: AbortSignal;
};
const fesCalls: Array<{ url: string; init: FesInit }> = [];
const fesAbortFlags: boolean[] = [];
vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: vi.fn((url: string, init: FesInit) => {
    const idx = fesCalls.length;
    fesCalls.push({ url, init });
    fesAbortFlags.push(false);
    init.signal?.addEventListener('abort', () => { fesAbortFlags[idx] = true; });
    return new Promise<void>(() => {});
  }),
}));

// --- mock refresh + granular invalidations from the chat api ---
const refreshAuth = vi.fn(async () => { setToken('tok-refreshed'); return true; });
const invalidateThread = vi.fn();
const invalidateLists = vi.fn();
vi.mock('./api', () => ({
  invalidateConversationThread: (_qc: unknown, id: string) => invalidateThread(id),
  invalidateConversationLists: () => invalidateLists(),
  refreshChatToken: () => refreshAuth(),
}));

import { useChatStream } from './use-chat-stream';

function wrapper() {
  const qc = new QueryClient();
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

describe('useChatStream auth resilience (Médio)', () => {
  beforeEach(() => {
    token = 'tok-initial';
    listeners.clear();
    fesCalls.length = 0;
    fesAbortFlags.length = 0;
    refreshAuth.mockClear();
  });

  it('reads the CURRENT token per connection attempt (not the mount-time token)', async () => {
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    try {
      renderHook(() => useChatStream(), { wrapper: wrapper() });
      await waitFor(() => expect(fesCalls.length).toBeGreaterThan(0));

      // The token rotates AFTER mount (e.g. a normal access-token refresh).
      act(() => { setToken('tok-rotated'); });

      // The custom fetch used by the stream must send the rotated token, proving
      // the header is resolved per request rather than frozen at mount.
      const { init } = fesCalls[fesCalls.length - 1];
      const req = new Request('http://x/chat/stream');
      const customFetch = init.fetch as typeof fetch;
      await customFetch(req);
      expect(req.headers.get('Authorization')).toBe('Bearer tok-rotated');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('renews the token when the stream gets a 401 on open', async () => {
    renderHook(() => useChatStream(), { wrapper: wrapper() });
    await waitFor(() => expect(fesCalls.length).toBeGreaterThan(0));

    const { init } = fesCalls[0];
    // Simulate the server rejecting the (expired) token on connect.
    await expect(init.onopen!(new Response(null, { status: 401 }))).rejects.toBeTruthy();
    expect(refreshAuth).toHaveBeenCalled();
  });

  it('re-subscribes (reconnects) when the access token changes', async () => {
    renderHook(() => useChatStream(), { wrapper: wrapper() });
    await waitFor(() => expect(fesCalls.length).toBe(1));

    act(() => { setToken('tok-new-login'); });

    // The old connection is aborted and a new fetchEventSource opens.
    await waitFor(() => expect(fesCalls.length).toBe(2));
    expect(fesAbortFlags[0]).toBe(true);
  });
});

// Num dia de disparo, o webhook publica um evento por ack (sent/delivered/
// read) de CADA destinatário. A lista de conversas é uma query INFINITA — o
// refetch refaz todas as páginas carregadas — então invalidá-la por evento
// virava tráfego contínuo com o refetch sempre abortado no meio. A conversa
// do evento continua invalidada NA HORA; a lista colapsa a rajada.
describe('useChatStream — rajada de acks não vira rajada de refetch da lista', () => {
  beforeEach(() => {
    token = 'tok-initial';
    listeners.clear();
    fesCalls.length = 0;
    fesAbortFlags.length = 0;
    invalidateThread.mockClear();
    invalidateLists.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const statusEvent = (conversationId: string) => ({
    data: JSON.stringify({ type: 'message.status', conversationId }),
  });

  it('invalida a conversa do evento na hora e a lista uma vez por janela', () => {
    renderHook(() => useChatStream(), { wrapper: wrapper() });
    const { init } = fesCalls[0];

    // Rajada: 3 acks em sequência imediata.
    act(() => {
      init.onmessage!(statusEvent('c1'));
      init.onmessage!(statusEvent('c2'));
      init.onmessage!(statusEvent('c1'));
    });

    // A thread de cada evento foi invalidada imediatamente (tick vivo)…
    expect(invalidateThread).toHaveBeenCalledTimes(3);
    expect(invalidateThread).toHaveBeenCalledWith('c1');
    expect(invalidateThread).toHaveBeenCalledWith('c2');

    // …e a lista UMA vez (leading), não três.
    act(() => { vi.advanceTimersByTime(0); });
    expect(invalidateLists).toHaveBeenCalledTimes(1);

    // Eventos dentro da janela agendam UM trailing para o fim dela.
    act(() => {
      init.onmessage!(statusEvent('c3'));
      init.onmessage!(statusEvent('c4'));
    });
    expect(invalidateLists).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(2_500); });
    expect(invalidateLists).toHaveBeenCalledTimes(2);
  });

  it('desmontar o hook cancela o trailing pendente (sem invalidação póstuma)', () => {
    const view = renderHook(() => useChatStream(), { wrapper: wrapper() });
    const { init } = fesCalls[0];

    act(() => { init.onmessage!(statusEvent('c1')); });
    view.unmount();
    act(() => { vi.advanceTimersByTime(5_000); });

    expect(invalidateLists).not.toHaveBeenCalled();
  });
});
