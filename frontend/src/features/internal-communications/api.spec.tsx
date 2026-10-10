import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const useSectors = vi.fn();

vi.mock('@/lib/api-client', () => ({ api: { get: (...args: unknown[]) => get(...args), post: (...args: unknown[]) => post(...args), patch: (...args: unknown[]) => patch(...args) } }));
vi.mock('@/features/internal-admin/api', () => ({ useSectors: (...args: unknown[]) => useSectors(...args) }));

import { useActiveSectors, useComment, useCommunication, useCommunications, useCreateCommunication, useEligibleMembers, useInbox, useInternalDashboard, useMarkCommunicationRead, useUpdateDemand } from './api';

const communication = { id: 'c1', reference: 'DEM-1', kind: 'DEMAND', subject: 'Assunto', message: 'Mensagem', originSector: { id: 'a', name: 'Origem', code: 'ORG' }, destinationSector: { id: 'b', name: 'Destino', code: 'DST' }, ccSectors: [], author: null, assignee: null, priority: 'NORMAL', dueDate: null, status: 'OPEN', version: 2, notifyTeam: true, notifyAssignee: true, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', completedAt: null, isUnread: false, events: [] };
const page = { items: [communication], total: 26, page: 2, pageSize: 25 };
const dashboard = { needsAction: 1, nearDeadline: 0, waitingOthers: 0, unassigned: 0, completedThisWeek: 0, priorities: [], recentUpdates: [], sector: null };

function response(value: unknown) { return { json: () => Promise.resolve(value) }; }
function client() { return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); }
function wrapper(queryClient: QueryClient) { return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>; }

beforeEach(() => { vi.clearAllMocks(); useSectors.mockReturnValue({ data: { items: [{ id: 's1', name: 'Produção', code: 'PRD' }] } }); });

describe('consultas internas', () => {
  it('serializa filtros paginados e mantém listas de inbox em chaves distintas', async () => {
    get.mockReturnValue(response(page)); const qc = client();
    const { result } = renderHook(() => ({ list: useCommunications({ q: 'lote', kind: 'DEMAND', page: 2 }), inbox: useInbox({ unassigned: true, page: 2 }) }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.isSuccess && result.current.inbox.isSuccess).toBe(true));
    expect(get).toHaveBeenNthCalledWith(1, 'internal/communications', { searchParams: { page: 2, pageSize: 25, q: 'lote', kind: 'DEMAND' } });
    expect(get).toHaveBeenNthCalledWith(2, 'internal/inbox', { searchParams: { page: 2, pageSize: 25, unassigned: true } });
    expect(result.current.list.data?.total).toBe(26);
  });

  it('valida o detalhe da comunicação', async () => {
    get.mockReturnValue(response(communication));
    const { result } = renderHook(() => useCommunication('c1'), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('valida o dashboard interno', async () => {
    get.mockReturnValue(response(dashboard));
    const { result } = renderHook(() => useInternalDashboard(), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('rejeita resposta inválida da API sem declarar sucesso', async () => {
    get.mockReturnValue(response({ items: [{}], total: 1, page: 1, pageSize: 25 }));
    const { result } = renderHook(() => useCommunications(), { wrapper: wrapper(client()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isSuccess).toBe(false);
  });

  it('não consulta detalhe ou membros sem identificador e mantém o contrato de array dos setores ativos', () => {
    const qc = client(); const { result } = renderHook(() => ({ detail: useCommunication(''), members: useEligibleMembers(), sectors: useActiveSectors() }), { wrapper: wrapper(qc) });
    expect(get).not.toHaveBeenCalled();
    expect(useSectors).toHaveBeenCalledWith(true);
    expect(result.current.sectors.data).toEqual([{ id: 's1', name: 'Produção', code: 'PRD' }]);
  });
});

describe('mutações internas', () => {
  it('envia payloads CAS/leitura/comentário/criação e invalida a família após sucesso', async () => {
    post.mockReturnValue(response(communication)); patch.mockReturnValue(response(communication)); const qc = client(); const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => ({ create: useCreateCommunication(), update: useUpdateDemand('c1'), comment: useComment('c1'), read: useMarkCommunicationRead('c1') }), { wrapper: wrapper(qc) });
    const create = { kind: 'DEMAND', subject: 'Assunto', message: 'Mensagem', originSectorId: 'a', destinationSectorId: 'b', ccSectorIds: [], notifyTeam: true, notifyAssignee: true, clientRequestId: '00000000-0000-4000-8000-000000000001' } as const;
    await result.current.create.mutateAsync(create);
    await result.current.update.mutateAsync({ expectedVersion: 2, status: 'COMPLETED' });
    await result.current.comment.mutateAsync('Atualização');
    await result.current.read.mutateAsync();
    expect(post).toHaveBeenNthCalledWith(1, 'internal/communications', { json: create });
    expect(patch).toHaveBeenCalledWith('internal/communications/c1/demand', { json: { expectedVersion: 2, status: 'COMPLETED' } });
    expect(post).toHaveBeenNthCalledWith(2, 'internal/communications/c1/comments', { json: { message: 'Atualização' } });
    expect(post).toHaveBeenNthCalledWith(3, 'internal/communications/c1/read');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['internal-communications'] });
  });

  it('propaga 401 e 409 sem sucesso falso ou invalidação', async () => {
    const unauthorized = new Error('401'); const conflict = new Error('409'); post.mockReturnValueOnce({ json: () => Promise.reject(unauthorized) }).mockReturnValueOnce({ json: () => Promise.reject(conflict) });
    const qc = client(); const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => ({ create: useCreateCommunication(), read: useMarkCommunicationRead('c1') }), { wrapper: wrapper(qc) });
    await expect(result.current.create.mutateAsync({} as never)).rejects.toBe(unauthorized);
    await expect(result.current.read.mutateAsync()).rejects.toBe(conflict);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
