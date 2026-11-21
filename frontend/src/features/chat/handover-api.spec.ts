import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { HTTPError } from 'ky';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

import { handoverSkipText, useHandoverConversations, useShiftHandover, type HandoverSkipReason } from './handover-api';

/** HTTPError no formato do ky 2: corpo já lido em `data`. */
function httpError(body: unknown, status: number): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.assign(err, { name: 'HTTPError', message: `status ${status}`, data: body, response: { status } });
  return err;
}

const json = (value: unknown) => ({ json: () => Promise.resolve(value) });
const input = { toUserId: 'u2', fromUserId: 'u1', note: 'fim do turno', conversationIds: ['c1', 'c2'] };

let qc: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: qc }, children);
const invalidated = (key: unknown[]) => qc.getQueryState(key)?.isInvalidated;

beforeEach(() => {
  qc = new QueryClient();
  get.mockReset();
  post.mockReset();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe('useHandoverConversations', () => {
  it('lista pede status=open, assignee={from}, pageSize=100', async () => {
    get.mockReturnValue(json({ items: [], total: 120, page: 1, pageSize: 100 }));
    const closed = renderHook(() => useHandoverConversations('u1', false), { wrapper });
    expect(closed.result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
    const open = renderHook(() => useHandoverConversations('u1', true), { wrapper });
    await waitFor(() => expect(open.result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('chat/conversations?status=open&assignee=u1&pageSize=100');
    expect(open.result.current.data?.total).toBe(120);
    expect(qc.getQueryState(['chat', 'handover-list', 'u1'])?.status).toBe('success');
  });
});

describe('useShiftHandover', () => {
  it('passagem: sucesso — toast singular/plural e invalidateChat', async () => {
    qc.setQueryData(['chat', 'conversations', { filter: 'all', search: '', status: 'open' }], { pages: [], pageParams: [] });
    qc.setQueryData(['chat', 'handover-list', 'u1'], { items: [] });
    post.mockReturnValueOnce(json({ transferred: [{ id: 'c1' }], skipped: [{ id: 'c2', reason: 'resolved' }] }));
    const { result } = renderHook(() => useShiftHandover(), { wrapper });
    const one = await result.current.mutateAsync({ input, targetName: 'Bia' });
    expect(post).toHaveBeenCalledWith('chat/handover', { json: input });
    expect(one.skipped).toEqual([{ id: 'c2', reason: 'resolved' }]);
    expect(toastSuccess).toHaveBeenLastCalledWith('1 conversa passada para Bia.');
    expect(invalidated(['chat', 'conversations', { filter: 'all', search: '', status: 'open' }])).toBe(true);
    expect(invalidated(['chat', 'handover-list', 'u1'])).toBe(true);

    post.mockReturnValueOnce(json({ transferred: [{ id: 'c1' }, { id: 'c2' }], skipped: [] }));
    await result.current.mutateAsync({ input, targetName: 'Bia' });
    expect(toastSuccess).toHaveBeenLastCalledWith('2 conversas passadas para Bia.');

    // Tudo pulado: o diálogo mostra os motivos; nenhum toast de sucesso.
    toastSuccess.mockClear();
    post.mockReturnValueOnce(json({ transferred: [], skipped: [{ id: 'c1', reason: 'unassigned' }] }));
    await result.current.mutateAsync({ input, targetName: 'Bia' });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('erros user.not_found e chat.not_assignee — textos de DT9', async () => {
    qc.setQueryData(['chat-assignees'], { items: [] });
    const { result } = renderHook(() => useShiftHandover(), { wrapper });
    const cases: [unknown, string][] = [
      [httpError({ code: 'user.not_found' }, 404), 'Esta pessoa não pode receber as conversas. Escolha outra.'],
      [httpError({ code: 'chat.not_assignee' }, 403), 'Só um administrador pode passar as conversas de outra pessoa.'],
      [httpError({ code: 'validation.failed' }, 400), 'Não foi possível passar o turno. Tente de novo.'],
      [new Error('rede'), 'Não foi possível passar o turno. Tente de novo.'],
    ];
    for (const [error, text] of cases) {
      post.mockReturnValueOnce({ json: () => Promise.reject(error) });
      await expect(result.current.mutateAsync({ input, targetName: 'Bia' })).rejects.toBe(error);
      await waitFor(() => expect(toastError).toHaveBeenLastCalledWith(text));
    }
    expect(toastSuccess).not.toHaveBeenCalled();
    // Destino recusado: a lista de destinos recarrega para ele sair.
    expect(invalidated(['chat-assignees'])).toBe(true);
  });
});

describe('handoverSkipText', () => {
  it('handoverSkipText — os cinco motivos', () => {
    const reasons: HandoverSkipReason[] = ['resolved', 'other_assignee', 'unassigned', 'already_with_target', 'not_found'];
    expect(reasons.map((reason) => handoverSkipText(reason, 'Bia'))).toEqual([
      'já resolvida',
      'já com outro atendente',
      'já sem atendente',
      'já estava com Bia',
      'não encontrada',
    ]);
    // Motivo que o servidor passe a mandar e a tela não conhece: texto neutro, sem quebrar.
    expect(handoverSkipText('novo' as HandoverSkipReason, 'Bia')).toBe('não foi passada');
  });
});
