import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const post = vi.fn(() => ({ json: () => Promise.resolve(null) }));
vi.mock('@/lib/api-client', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

import { useAssignConversation } from './api';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

describe('useAssignConversation', () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
    post.mockClear();
  });

  it('POSTs the assign endpoint with the userId and invalidates chat queries', async () => {
    qc.setQueryData(['chat', 'conversations', 'c1'], { id: 'c1' });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAssignConversation('c1'), { wrapper: wrapper(qc) });
    await result.current.mutateAsync({ userId: 'u9' });
    expect(post).toHaveBeenCalledWith('chat/conversations/c1/assign', { json: { userId: 'u9' } });
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('supports unassigning with userId null', async () => {
    const { result } = renderHook(() => useAssignConversation('c1'), { wrapper: wrapper(qc) });
    await result.current.mutateAsync({ userId: null });
    expect(post).toHaveBeenCalledWith('chat/conversations/c1/assign', { json: { userId: null } });
  });
});
