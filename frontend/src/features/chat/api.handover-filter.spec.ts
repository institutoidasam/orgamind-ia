import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));

import { useConversationList, type ConversationListParams } from './api';

const emptyPage = { items: [], total: 0, page: 1, pageSize: 30 };

async function requestedQuery(params: ConversationListParams): Promise<URLSearchParams> {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(() => useConversationList(params), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return new URLSearchParams((get.mock.calls[0][0] as string).split('?')[1]);
}

describe('aba Recebidas na passagem de turno (DT3)', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockReturnValue({ json: () => Promise.resolve(emptyPage) });
  });

  it('aceite 27: assignee handover vira assignee=me&handover=true', async () => {
    const query = await requestedQuery({ filter: 'all', search: '', status: 'open', assignee: 'handover' });
    expect(query.get('assignee')).toBe('me');
    expect(query.get('handover')).toBe('true');
    expect(query.get('status')).toBe('open');
  });

  it('as outras abas não mandam handover', async () => {
    const query = await requestedQuery({ filter: 'all', search: '', status: 'open', assignee: 'me' });
    expect(query.get('assignee')).toBe('me');
    expect(query.has('handover')).toBe(false);
  });
});
