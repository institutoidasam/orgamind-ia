import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { syncAuthStoreOnSelfEdit, useUpdateUser } from './api';

function invalidateUserList(qc: QueryClient) {
  qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'users' });
}

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
