import { useInfiniteQuery, useQuery, infiniteQueryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { extractApiError } from '@/lib/api-error';
import { useAuthStore } from '@/stores/auth.store';
import { parseConversationsPage, parseMessagesPage, parseConversationSummary, parseChatMessage } from './schemas';
import type { ConversationSummary } from './schemas';
import type { ChannelProvider } from '@/features/whatsapp/api';

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Rotate the access token via the refresh cookie and write it back to the store.
 * The SSE stream (use-chat-stream) can't ride the ky 401→refresh hook because
 * it doesn't go through ky, so it calls this when the server rejects an expired
 * token on connect. Returns whether a fresh token is now available.
 */
export async function refreshChatToken(): Promise<boolean> {
  try {
    const res = await fetch(`${baseURL}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
    const { accessToken } = (await res.json()) as { accessToken: string };
    const store = useAuthStore.getState();
    if (!store.user || !accessToken) return false;
    store.setSession({ accessToken, user: store.user, mustChangePassword: store.mustChangePassword });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tamanho da página da lista de conversas (o padrão do backend; cap 100).
 * Cada tick de polling refaz TODAS as páginas carregadas — página menor mantém
 * cada request barato, e o scroll infinito busca as seguintes sob demanda.
 */
const CONVERSATIONS_PAGE_SIZE = 30;

/**
 * A lista é VIVA (ordena por última mensagem): entre o fetch de uma página e o
 * da seguinte, uma conversa que recebeu mensagem sobe de posição e pode
 * aparecer nas duas. Dedup por id, mantendo a primeira ocorrência (a de
 * ordenação mais recente).
 */
export function dedupeById(items: ConversationSummary[]): ConversationSummary[] {
  const seen = new Set<string>();
  const out: ConversationSummary[] = [];
  for (const c of items) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

export const chatQueries = {
  // `provider` (F4b — inbox provider filter): applied server-side, same as
  // instanceId/assignee, so it narrows the DB query BEFORE the page cut
  // instead of filtering an already-paginated page client-side (which could
  // hide matches sitting beyond the first page for a low-volume provider).
  conversations: (filter: 'all' | 'unread' | 'awaiting', search: string, instanceId?: string, assignee?: string, provider?: ChannelProvider) =>
    infiniteQueryOptions({
      queryKey: [
        'chat',
        'conversations',
        {
          filter,
          search,
          ...(instanceId ? { instanceId } : {}),
          ...(assignee ? { assignee } : {}),
          ...(provider ? { provider } : {}),
        },
      ] as const,
      queryFn: ({ pageParam }) => {
        const params = new URLSearchParams({
          filter,
          page: String(pageParam),
          pageSize: String(CONVERSATIONS_PAGE_SIZE),
        });
        if (search) params.set('search', search);
        if (instanceId) params.set('instanceId', instanceId);
        if (assignee) params.set('assignee', assignee);
        if (provider) params.set('provider', provider);
        return api.get(`chat/conversations?${params.toString()}`).json<unknown>().then(parseConversationsPage);
      },
      initialPageParam: 1,
      // O backend pagina por page/pageSize e devolve o total: há próxima
      // página enquanto o que já veio não cobre o total.
      getNextPageParam: (last) =>
        last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    }),
};

export function useConversations(filter: 'all' | 'unread' | 'awaiting', search: string, instanceId?: string, assignee?: string, provider?: ChannelProvider) {
  return useInfiniteQuery({
    ...chatQueries.conversations(filter, search, instanceId, assignee, provider),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
    // As páginas achatadas + o total mais fresco — a lista consome uma forma
    // só, sem saber de paginação.
    select: (data) => ({
      items: dedupeById(data.pages.flatMap((p) => p.items)),
      total: data.pages.at(-1)?.total ?? 0,
    }),
  });
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: ['chat', 'conversations', id] as const,
    queryFn: () => api.get(`chat/conversations/${id}`).json<unknown>().then(parseConversationSummary),
  });
}

export function useConversationMessages(conversationId: string) {
  return useInfiniteQuery({
    queryKey: ['chat', 'conversations', conversationId, 'messages'] as const,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '30' });
      if (pageParam) params.set('cursor', String(pageParam));
      return api.get(`chat/conversations/${conversationId}/messages?${params.toString()}`).json<unknown>().then(parseMessagesPage);
    },
    initialPageParam: '' as string,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function invalidateChat(qc: QueryClient, conversationId?: string) {
  qc.invalidateQueries({
    predicate: (q) => {
      if (q.queryKey[0] !== 'chat') return false;
      if (!conversationId) return true;
      // Invalidate the conversations list queries (key[2] is an object like { filter, search })
      if (typeof q.queryKey[2] === 'object' && q.queryKey[2] !== null) return true;
      // Invalidate only the specific conversation and its messages
      return q.queryKey[2] == null || q.queryKey[2] === conversationId;
    },
  });
}

/**
 * Invalida SÓ as queries de LISTA de conversas (o segmento [2] da key é o
 * objeto de filtros). Existe separada do invalidateChat para o stream SSE
 * poder atrasá-la (throttle) sem atrasar a conversa aberta.
 *
 * `cancelRefetch: false` — a lista é uma query INFINITA: o refetch refaz as
 * páginas carregadas em SEQUÊNCIA, e o padrão do TanStack (true) ABORTA o
 * refetch em voo a cada nova invalidação e recomeça da página 1. Numa rajada
 * de acks de disparo, as páginas ≥2 nunca completavam — a metade de baixo da
 * lista congelava exatamente enquanto o broadcast rodava. Com false, o
 * refetch em voo termina; a query continua marcada stale e o próximo tick a
 * atualiza.
 */
export function invalidateConversationLists(qc: QueryClient) {
  qc.invalidateQueries(
    {
      predicate: (q) =>
        q.queryKey[0] === 'chat' && typeof q.queryKey[2] === 'object' && q.queryKey[2] !== null,
    },
    { cancelRefetch: false },
  );
}

/**
 * Invalida a conversa específica (resumo + mensagens) — SEM tocar nas listas.
 * O tick de status da conversa aberta precisa ser vivo; é a lista que aguenta
 * esperar o throttle.
 */
export function invalidateConversationThread(qc: QueryClient, conversationId: string) {
  qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'chat' && q.queryKey[2] === conversationId,
  });
}

export function useSendReply(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string; quotedWaMessageId?: string; quotedPreview?: string }) =>
      api.post(`chat/conversations/${conversationId}/messages`, { json: input }).json<unknown>().then(parseChatMessage),
    onSuccess: () => invalidateChat(qc, conversationId),
    // T7 (twilio-platform): a janela de 24h fechou entre o load e o envio — o
    // backend responde 409 chat.twilio_window_closed com mensagem PT-BR
    // acionável. Toast com a mensagem do backend + refetch da conversa para o
    // composer flipar para o estado "só template" (twilioWindowExpiresAt
    // atualizado). Outros erros seguem no aviso inline do composer.
    onError: async (err) => {
      const apiErr = await extractApiError(err);
      if (apiErr.code === 'chat.twilio_window_closed') {
        toast.error(apiErr.message);
        invalidateChat(qc, conversationId);
      }
    },
  });
}

export function useSendMedia(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: File; caption?: string }) => {
      const form = new FormData();
      form.append('file', input.file);
      if (input.caption) form.append('caption', input.caption);
      return api.post(`chat/conversations/${conversationId}/media`, { body: form, timeout: 60_000 }).json<unknown>().then(parseChatMessage);
    },
    onSuccess: () => invalidateChat(qc, conversationId),
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => api.post(`chat/conversations/${conversationId}/read`).json().catch(() => null),
    onSuccess: (_d, conversationId) => invalidateChat(qc, conversationId),
  });
}

export function useTyping(conversationId: string) {
  return useMutation({
    mutationFn: (state: 'composing' | 'paused') =>
      api.post(`chat/conversations/${conversationId}/typing`, { json: { state } }).json().catch(() => null),
  });
}

export function usePauseBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) => { await api.post(`chat/conversations/${conversationId}/bot/pause`); },
    onSuccess: (_d, conversationId) => invalidateChat(qc, conversationId),
  });
}

export function useResumeBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) => { await api.post(`chat/conversations/${conversationId}/bot/resume`); },
    onSuccess: (_d, conversationId) => invalidateChat(qc, conversationId),
  });
}

export function useAssignConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    // The endpoint returns 200 with no body — don't call .json() (it throws on
    // an empty response, which would fire a false error toast on a successful
    // assign). ky still rejects on a non-2xx status, so real failures (e.g.
    // user-not-found) still reach onError.
    mutationFn: (input: { userId: string | null }) =>
      api.post(`chat/conversations/${conversationId}/assign`, { json: input }),
    onSuccess: () => invalidateChat(qc, conversationId),
    onError: () => toast.error('Falha ao atribuir a conversa'),
  });
}
