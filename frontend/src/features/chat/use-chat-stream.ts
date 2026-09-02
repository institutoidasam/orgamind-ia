import { useEffect } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { invalidateConversationLists, invalidateConversationThread, refreshChatToken } from './api';
import type { ChatEvent } from './schemas';

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Janela do throttle da invalidação de LISTA. Num dia de disparo, o webhook
 * publica um evento por ack (sent/delivered/read) de CADA destinatário — e a
 * lista é uma query infinita cujo refetch refaz todas as páginas carregadas.
 * Invalidá-la por evento virava tráfego contínuo com as páginas ≥2 nunca
 * completando. 2,5s colapsa a rajada sem deixar a lista visivelmente velha
 * (o polling de 15s continua de rede de segurança).
 */
const LIST_INVALIDATE_THROTTLE_MS = 2_500;

/**
 * Opens the chat SSE stream and invalidates the relevant TanStack Query caches
 * on each event. Polling (refetchInterval) remains as a fallback if the stream
 * drops. fetch-based SSE is required because native EventSource can't send the
 * Authorization header.
 *
 * Auth resilience: the token is resolved PER request (via a custom fetch that
 * reads useAuthStore.getState() on every attempt), so the library's internal
 * reconnects never reuse a stale header. On a 401 at connect we rotate the
 * token (refresh cookie) and retry. The hook also re-subscribes — tears down
 * the old connection and opens a fresh one — whenever the access token changes
 * (e.g. after a refresh or a re-login), so the stream never lingers with an
 * expired/wrong identity.
 */
export function useChatStream() {
  const qc = useQueryClient();
  useEffect(() => {
    let ctrl: AbortController | null = null;
    let stopped = false;

    // A conversa do evento é invalidada NA HORA (o tick de status da thread
    // aberta precisa ser vivo); a LISTA colapsa a rajada num refetch por
    // janela — leading (primeiro evento dispara já) + trailing (o último da
    // rajada não se perde).
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    let lastListInvalidateAt = 0;
    const invalidateListsThrottled = () => {
      if (listTimer) return; // já há um refetch agendado para esta janela
      const wait = Math.max(0, LIST_INVALIDATE_THROTTLE_MS - (Date.now() - lastListInvalidateAt));
      listTimer = setTimeout(() => {
        listTimer = null;
        lastListInvalidateAt = Date.now();
        invalidateConversationLists(qc);
      }, wait);
    };

    // A fetch that stamps the CURRENT access token on every attempt. The
    // fetch-event-source library reuses its static `headers` object across
    // reconnects; routing through this keeps the Authorization header fresh.
    const authedFetch: typeof fetch = (input, init) => {
      const token = useAuthStore.getState().accessToken;
      // fetch-event-source always calls fetch with a Request. Stamp the header
      // on that exact object so the freshest token is sent on every attempt.
      if (input instanceof Request) {
        if (token) input.headers.set('Authorization', `Bearer ${token}`);
        return fetch(input);
      }
      const req = new Request(input as RequestInfo, init);
      if (token) req.headers.set('Authorization', `Bearer ${token}`);
      return fetch(req);
    };

    function connect() {
      if (stopped) return;
      const token = useAuthStore.getState().accessToken;
      if (!token) return;
      ctrl = new AbortController();
      void fetchEventSource(`${baseURL}/chat/stream`, {
        signal: ctrl.signal,
        fetch: authedFetch,
        openWhenHidden: true,
        async onopen(response) {
          if (response.status === 401) {
            // Expired/invalid token on connect — rotate it, then throw so the
            // library retries (authedFetch then sends the refreshed token).
            await refreshChatToken();
            throw new Error('chat-stream-unauthorized');
          }
          // 2xx (or any other status) — let the library proceed as usual.
        },
        onmessage(ev) {
          if (!ev.data) return;
          try {
            const event = JSON.parse(ev.data) as ChatEvent;
            if (event.conversationId) invalidateConversationThread(qc, event.conversationId);
            invalidateListsThrottled();
          } catch {
            /* ignore malformed event */
          }
        },
      }).catch(() => { /* aborted or network error; polling covers it */ });
    }

    connect();

    // Reconnect whenever the access token changes so the stream picks up the
    // new identity instead of dying on the stale one.
    let lastToken = useAuthStore.getState().accessToken;
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (state.accessToken === lastToken) return;
      lastToken = state.accessToken;
      ctrl?.abort();
      connect();
    });

    return () => {
      stopped = true;
      unsubscribe();
      ctrl?.abort();
      if (listTimer) clearTimeout(listTimer);
    };
  }, [qc]);
}
