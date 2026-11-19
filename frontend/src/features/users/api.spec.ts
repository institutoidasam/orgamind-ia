import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { syncAuthStoreOnSelfEdit, useActiveLevels, useSetUserStatus, useUpdateUser, useUsers } from './api';

function invalidateUserList(qc: QueryClient) {
  qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'users' });
}

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  );
const stubJson = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
const requestedUrl = (spy: ReturnType<typeof stubJson>) => new URL((spy.mock.calls[0]![0] as Request).url);
const usersPage = { data: [], total: 0, page: 1, pageSize: 100, authorizationCounts: { unverified: 0, notAuthorized: 0 } };

describe('filtros da ficha', () => {
  afterEach(() => vi.restoreAllMocks());

  it('q, status e authorization vão na query só quando informados', async () => {
    const spy = stubJson(usersPage);
    const { result } = renderHook(() => useUsers(1, 20, { q: 'ab', status: 'active', authorization: 'NOT_AUTHORIZED' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(Object.fromEntries(requestedUrl(spy).searchParams)).toEqual({
      page: '1', pageSize: '20', q: 'ab', status: 'active', authorization: 'NOT_AUTHORIZED',
    });
  });

  it('{ hasAccess: true } continua mandando só hasAccess', async () => {
    const spy = stubJson(usersPage);
    const { result } = renderHook(() => useUsers(1, 100, { hasAccess: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect([...requestedUrl(spy).searchParams.keys()].sort()).toEqual(['hasAccess', 'page', 'pageSize']);
  });

  it('resposta da API atual (sem os campos novos) continua válida', async () => {
    stubJson({ ...usersPage, data: [{ id: 'u1', email: 'a@x.com', hasAccess: true, name: 'Ana', role: 'ADMIN', contactAuthorization: { status: 'NAO_AUTORIZADO', source: null, note: null, date: null, recordedAt: null }, lastLoginAt: null, phoneE164: null, createdAt: '2026-10-10', createdBy: null }] });
    const { result } = renderHook(() => useUsers(1, 100), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.authorizationCounts).toEqual({ unverified: 0, notAuthorized: 0 });
    expect(result.current.data?.data[0]).toMatchObject({ registration: null, contactAuthorization: { status: 'NAO_AUTORIZADO' } });
  });

  it('useSetUserStatus faz PATCH users/:id com isActive e motivo', async () => {
    const sent: { method?: string; path?: string; body?: unknown } = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = input as Request;
      Object.assign(sent, { method: request.method, path: new URL(request.url).pathname, body: await request.json() });
      return new Response(null, { status: 204 });
    });
    const { result } = renderHook(() => useSetUserStatus(), { wrapper });
    await result.current.mutateAsync({ id: 'u9', isActive: false, reason: 'saiu da empresa' });
    expect(sent).toMatchObject({ method: 'PATCH', body: { isActive: false, reason: 'saiu da empresa' } });
    expect(sent.path).toMatch(/\/users\/u9$/);
  });
});

describe('users cache invalidation', () => {
  it('predicate invalidates users queries regardless of extra params', () => {
    const qc = new QueryClient();
    qc.setQueryData(['users', { page: 1, pageSize: 20 }], { data: [], total: 0 });
    qc.setQueryData(['users', { page: 2, pageSize: 20 }], { data: [], total: 0 });
    invalidateUserList(qc);
    const states = qc
      .getQueryCache()
      .findAll({ queryKey: ['users'] })
      .map((q) => q.state.isInvalidated);
    expect(states).toEqual([true, true]);
  });
});

describe('syncAuthStoreOnSelfEdit', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'tok',
      user: { id: 'me', email: 'me@x.com', name: 'Old Name', role: 'ADMIN' },
      mustChangePassword: false,
    });
  });

  it('updates the current user name when editing own id', () => {
    syncAuthStoreOnSelfEdit('me', { name: 'New Name' });
    const u = useAuthStore.getState().user;
    expect(u?.name).toBe('New Name');
    // token must be preserved
    expect(useAuthStore.getState().accessToken).toBe('tok');
  });

  it('does nothing when editing another user', () => {
    syncAuthStoreOnSelfEdit('someone-else', { name: 'New Name' });
    expect(useAuthStore.getState().user?.name).toBe('Old Name');
  });

  it('does nothing when no user is in the store', () => {
    useAuthStore.setState({ accessToken: null, user: null, mustChangePassword: false });
    expect(() => syncAuthStoreOnSelfEdit('me', { name: 'X' })).not.toThrow();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('leaves the name untouched when the edit has no name', () => {
    syncAuthStoreOnSelfEdit('me', { role: 'OPERATOR' });
    expect(useAuthStore.getState().user?.name).toBe('Old Name');
  });
});

describe('useUpdateUser — empty 204 body must not throw (regression)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves on an empty 204 PATCH response and invalidates the users list', async () => {
    // The endpoint responds 204 No Content. The pre-fix mutationFn called
    // .json() on this empty body -> JSON.parse('') -> "Unexpected end of JSON
    // input", which rejected the mutation (red toast, stale UI). Dropping
    // .json() makes it resolve so onSuccess runs and refetches the list.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const qc = new QueryClient();
    qc.setQueryData(['users', { page: 1, pageSize: 20 }], { data: [], total: 0 });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);

    const { result } = renderHook(() => useUpdateUser(), { wrapper });

    // Pre-fix this rejected; post-fix it resolves.
    await result.current.mutateAsync({ id: 'u2', data: { role: 'ADMIN' } });

    await waitFor(() => {
      const states = qc
        .getQueryCache()
        .findAll({ queryKey: ['users'] })
        .map((q) => q.state.isInvalidated);
      expect(states).toEqual([true]);
    });
  });
});

describe('useUsers e useActiveLevels (leitura)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('com { hasAccess: true } a query tem hasAccess=true', async () => {
    const spy = stubJson(usersPage);
    const { result } = renderHook(() => useUsers(1, 100, { hasAccess: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrl(spy).searchParams.get('hasAccess')).toBe('true');
  });

  it('sem filtro, a query é a de hoje (só page e pageSize)', async () => {
    const spy = stubJson(usersPage);
    const { result } = renderHook(() => useUsers(1, 20), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect([...requestedUrl(spy).searchParams.keys()].sort()).toEqual(['page', 'pageSize']);
  });

  it('useActiveLevels devolve só os níveis ativos de GET /internal/levels', async () => {
    const level = { sortOrder: 0, userCount: 0 };
    const spy = stubJson({
      items: [
        { id: 'l1', name: 'Líder', isActive: true, ...level },
        { id: 'l2', name: 'Antigo', isActive: false, ...level },
      ],
    });
    const { result } = renderHook(() => useActiveLevels(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedUrl(spy).pathname).toMatch(/internal\/levels$/);
    expect(result.current.data?.map((l) => l.name)).toEqual(['Líder']);
  });
});
