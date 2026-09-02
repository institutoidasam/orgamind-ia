import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

// One Blob per fetch; assert we only download once across mounts.
const fetchedBlob = new Blob(['x'], { type: 'image/jpeg' });
const blobSpy = vi.fn(() => Promise.resolve(fetchedBlob));
vi.mock('@/lib/api-client', () => ({
  api: { get: () => ({ blob: blobSpy }) },
}));

import { useChatMedia } from './use-chat-media';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

describe('useChatMedia', () => {
  let qc: QueryClient;
  let nextId: number;
  const created: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    nextId = 0;
    created.length = 0;
    revoked.length = 0;
    blobSpy.mockClear();
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:fake/${nextId++}`;
      created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  });

  it('returns a live (non-revoked) object URL after a remount within gcTime', async () => {
    // First mount — like opening a conversation.
    const first = renderHook(() => useChatMedia('m1', true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(first.result.current.data).toBeTruthy());

    // Switch away from the conversation: the bubble (and the hook) unmounts.
    first.unmount();

    // Revisit the conversation within gcTime: the hook mounts again with the
    // same mediaId; the query data is still cached.
    const second = renderHook(() => useChatMedia('m1', true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(second.result.current.data).toBeTruthy());

    const url = second.result.current.data!;
    // The URL handed to <img>/<video>/<audio>/<a> must still be alive.
    expect(revoked).not.toContain(url);
  });

  it('does not re-download the media on remount (caches the blob)', async () => {
    const first = renderHook(() => useChatMedia('m1', true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(first.result.current.data).toBeTruthy());
    first.unmount();

    const second = renderHook(() => useChatMedia('m1', true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(second.result.current.data).toBeTruthy());

    expect(blobSpy).toHaveBeenCalledTimes(1);
  });

  it('revokes the URL it created when it unmounts (no leak)', async () => {
    const first = renderHook(() => useChatMedia('m1', true), { wrapper: wrapper(qc) });
    await waitFor(() => expect(first.result.current.data).toBeTruthy());
    const url = first.result.current.data!;
    first.unmount();
    await waitFor(() => expect(revoked).toContain(url));
  });
});
