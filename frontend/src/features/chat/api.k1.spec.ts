import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { HTTPError } from 'ky';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import {
  chatQueries,
  invalidateConversationThread,
  useAssignConversation,
  useChatAssignees,
  useConversationHistory,
  useConversationList,
  useReopenConversation,
  useResolveConversation,
  useSendMedia,
  useSendReply,
} from './api';

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, { name: 'HTTPError', message: `status ${status}`, data: body, response: { status } });
  return err;
}

const emptyPage = { items: [], total: 0, page: 1, pageSize: 30 };
const json = (value: unknown) => ({ json: () => Promise.resolve(value) });

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

/** Lista, conversa e histórico da c1, mais o histórico da c2 (que não pode ser tocado). */
function seed(qc: QueryClient) {
  qc.setQueryData(['chat', 'conversations', { filter: 'all', search: '', status: 'open' }], { pages: [], pageParams: [] });
  qc.setQueryData(['chat', 'conversations', 'c1'], {});
  qc.setQueryData(['chat', 'conversations', 'c1', 'history'], { items: [] });
  qc.setQueryData(['chat', 'conversations', 'c2', 'history'], { items: [] });
}
const invalidated = (qc: QueryClient, key: unknown[]) => qc.getQueryState(key)?.isInvalidated;

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
  get.mockReset();
  post.mockReset();
  toastError.mockClear();
});

describe('lista de conversas por situação', () => {
  it('aceite 1: useConversationList manda status=open por padrão e status=resolved; chave com status', async () => {
    get.mockReturnValue(json(emptyPage));
    const open = renderHook(() => useConversationList({ filter: 'all', search: '', status: 'open' }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(open.result.current.isSuccess).toBe(true));
    expect(get.mock.calls[0][0]).toContain('status=open');

    const resolved = renderHook(() => useConversationList({ filter: 'unread', search: 'ana', status: 'resolved' }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(resolved.result.current.isSuccess).toBe(true));
    expect(get.mock.calls[1][0]).toContain('status=resolved');
    expect(chatQueries.conversationList({ filter: 'all', search: '', status: 'resolved', assignee: 'me' }).queryKey).toEqual([
      'chat', 'conversations', { filter: 'all', search: '', status: 'resolved', assignee: 'me' },
    ]);
  });

  it('useConversationList manda status open e o instanceId na URL', async () => {
    get.mockReturnValue(json(emptyPage));
    const params = { filter: 'all', search: '', status: 'open', instanceId: 'inst-1' } as const;
    const { result } = renderHook(() => useConversationList(params), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get.mock.calls[0][0]).toContain('status=open');
    expect(get.mock.calls[0][0]).toContain('instanceId=inst-1');
  });
});

describe('ações de situação', () => {
  it('useAssignConversation manda userId, expectedAssigneeId e note', async () => {
    post.mockResolvedValue({});
    const { result } = renderHook(() => useAssignConversation('c1'), { wrapper: wrapper(qc) });
    await result.current.mutateAsync({ userId: 'u2', expectedAssigneeId: 'u1', note: 'passei o turno' });
    expect(post).toHaveBeenCalledWith('chat/conversations/c1/assign', {
      json: { userId: 'u2', expectedAssigneeId: 'u1', note: 'passei o turno' },
    });
  });

  it('useResolveConversation manda expectedAssigneeId e expectedLastInboundAt; reabrir manda a nota', async () => {
    post.mockResolvedValue({});
    const resolve = renderHook(() => useResolveConversation('c1'), { wrapper: wrapper(qc) });
    const input = { expectedAssigneeId: 'u1', expectedLastInboundAt: '2026-11-21T14:00:00.000Z' };
    await resolve.result.current.mutateAsync(input);
    expect(post).toHaveBeenCalledWith('chat/conversations/c1/resolve', { json: input });
    const reopen = renderHook(() => useReopenConversation('c1'), { wrapper: wrapper(qc) });
    await reopen.result.current.mutateAsync({ note: 'voltou a falar' });
    expect(post).toHaveBeenCalledWith('chat/conversations/c1/reopen', { json: { note: 'voltou a falar' } });
  });

  it('aceite 3: 409 chat.conversation_changed — toast e invalidação da conversa, da lista e do histórico', async () => {
    seed(qc);
    post.mockRejectedValue(httpError({ code: 'chat.conversation_changed' }, 409));
    const { result } = renderHook(() => useAssignConversation('c1'), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync({ userId: 'u2', expectedAssigneeId: 'u1' })).rejects.toBeInstanceOf(HTTPError);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'A conversa mudou enquanto você olhava. Ela foi recarregada; confira e tente de novo.',
    ));
    expect(invalidated(qc, ['chat', 'conversations', 'c1'])).toBe(true);
    expect(invalidated(qc, ['chat', 'conversations', 'c1', 'history'])).toBe(true);
    expect(invalidated(qc, ['chat', 'conversations', { filter: 'all', search: '', status: 'open' }])).toBe(true);
    expect(invalidated(qc, ['chat', 'conversations', 'c2', 'history'])).toBe(false);
  });

  it('403 chat.not_assignee — toast', async () => {
    post.mockRejectedValue(httpError({ code: 'chat.not_assignee' }, 403));
    const { result } = renderHook(() => useResolveConversation('c1'), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync({ expectedAssigneeId: 'u1', expectedLastInboundAt: null })).rejects.toBeInstanceOf(HTTPError);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      'Só quem está atendendo a conversa ou um administrador pode fazer isso.',
    ));
  });
});

describe('envio em conversa de outro atendente', () => {
  it('envio com 409 chat.assigned_to_other — invalida a conversa sem toast (texto e mídia)', async () => {
    const body = { code: 'chat.assigned_to_other', detail: JSON.stringify({ assignee: { id: 'u2', name: 'Bia', active: true } }) };
    post.mockReturnValue({ json: () => Promise.reject(httpError(body, 409)) });
    seed(qc);
    const reply = renderHook(() => useSendReply('c1'), { wrapper: wrapper(qc) });
    await expect(reply.result.current.mutateAsync({ text: 'oi' })).rejects.toBeInstanceOf(HTTPError);
    await waitFor(() => expect(invalidated(qc, ['chat', 'conversations', 'c1'])).toBe(true));

    seed(qc);
    const media = renderHook(() => useSendMedia('c1'), { wrapper: wrapper(qc) });
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await expect(media.result.current.mutateAsync({ file })).rejects.toBeInstanceOf(HTTPError);
    await waitFor(() => expect(invalidated(qc, ['chat', 'conversations', 'c1'])).toBe(true));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('histórico e destinos', () => {
  it('invalidateConversationThread invalida o histórico da conversa', () => {
    seed(qc);
    invalidateConversationThread(qc, 'c1');
    expect(invalidated(qc, ['chat', 'conversations', 'c1', 'history'])).toBe(true);
    expect(invalidated(qc, ['chat', 'conversations', 'c2', 'history'])).toBe(false);
  });

  it('useConversationHistory só consulta habilitado; useChatAssignees lê chat/assignees', async () => {
    get.mockImplementation((url: string) => json(url.endsWith('/history') ? { items: [] } : { items: [{ id: 'u2', name: 'Bia' }] }));
    const closed = renderHook(() => useConversationHistory('c1', false), { wrapper: wrapper(qc) });
    expect(closed.result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
    const open = renderHook(() => useConversationHistory('c1', true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(open.result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('chat/conversations/c1/history');
    const assignees = renderHook(() => useChatAssignees(true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(assignees.result.current.data?.items).toEqual([{ id: 'u2', name: 'Bia' }]));
    expect(get).toHaveBeenCalledWith('chat/assignees');
  });
});

describe('destino recusado (Fix R1)', () => {
  it('404 user.not_found — toast e recarga da lista de destinos', async () => {
    qc.setQueryData(['chat-assignees'], { items: [{ id: 'u3', name: 'Pessoa C' }] });
    post.mockRejectedValue(httpError({ code: 'user.not_found' }, 404));
    const { result } = renderHook(() => useAssignConversation('c1'), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync({ userId: 'u3', expectedAssigneeId: 'u1' })).rejects.toBeInstanceOf(HTTPError);
    await waitFor(() => expect(invalidated(qc, ['chat-assignees'])).toBe(true));
    expect(toastError).toHaveBeenCalledWith('Esta pessoa não pode receber a conversa. Escolha outra.');
  });
});
