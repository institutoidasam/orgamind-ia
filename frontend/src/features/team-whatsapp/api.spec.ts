import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const post = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

import { dispatchPollInterval, POLL_WINDOW_MS, useCreateTeamDispatch } from './api';
import type { DispatchList } from './schemas';

const NOW = Date.parse('2026-10-16T12:00:00Z');

function list(queued: number, ageMs: number): DispatchList {
  return {
    items: [{
      id: 'd1',
      createdAt: new Date(NOW - ageMs).toISOString(),
      author: null,
      target: { type: 'sector', id: 's1', label: 'Compras' },
      channel: null,
      counts: { queued, sent: 0, failed: 0, skipped: 0 },
      issues: [],
    }],
  };
}

describe('dispatchPollInterval', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it('consulta a cada 10 s enquanto há QUEUED com menos de 60 min', () => {
    expect(dispatchPollInterval(list(2, 5 * 60_000))).toBe(10_000);
  });

  it('para de consultar quando o QUEUED tem mais de 60 min', () => {
    expect(dispatchPollInterval(list(2, POLL_WINDOW_MS + 1))).toBe(false);
  });

  it('não consulta sem QUEUED nem sem dados', () => {
    expect(dispatchPollInterval(list(0, 1_000))).toBe(false);
    expect(dispatchPollInterval(undefined)).toBe(false);
  });
});

describe('useCreateTeamDispatch', () => {
  it('após o POST com sucesso invalida a lista de envios', async () => {
    post.mockReturnValue({
      json: () => Promise.resolve({ dispatchId: 'd1', queued: 1, skipped: [] }),
    });
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useCreateTeamDispatch(), { wrapper });
    const input = { channelId: 'ch1', text: 'Oi', target: { type: 'user' as const, userId: 'u1' } };
    await result.current.mutateAsync(input);
    expect(post).toHaveBeenCalledWith('internal/team-whatsapp/dispatches', { json: input });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'dispatches'] }),
    );
  });
});
