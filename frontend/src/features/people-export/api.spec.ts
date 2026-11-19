import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), saveBlob: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get } }));
vi.mock('./download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./download')>()),
  saveBlob: mocks.saveBlob,
}));

import { useExportPeople, useExportSchedule } from './api';

const blob = new Blob(['planilha']);

function respond(disposition?: string) {
  const headers = new Headers(disposition ? { 'content-disposition': disposition } : {});
  mocks.get.mockResolvedValue({ headers, blob: () => Promise.resolve(blob) });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

async function exportPeople(params: Parameters<ReturnType<typeof useExportPeople>['mutateAsync']>[0]) {
  const { result } = renderHook(() => useExportPeople(), { wrapper });
  await act(() => result.current.mutateAsync(params));
}

beforeEach(() => {
  vi.clearAllMocks();
  respond('attachment; filename="pessoas-2026-11-19.xlsx"');
});

describe('download sem repetição automática', () => {
  it('as duas chamadas levam retry: 0 (repetir geraria e registraria a exportação duas vezes)', async () => {
    await exportPeople({ format: 'csv', status: 'all', date: '2026-11-19' });
    const { result } = renderHook(() => useExportSchedule(), { wrapper });
    await act(() => result.current.mutateAsync({ format: 'csv', sectorId: 's1', from: '2026-11-16', to: '2026-11-22' }));

    expect(mocks.get).toHaveBeenCalledTimes(2);
    for (const [, options] of mocks.get.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ retry: 0 }));
    }
  });
});

describe('useExportPeople', () => {
  it('chama internal/people-export/people com timeout de 120 s e sem parâmetros vazios', async () => {
    await exportPeople({
      format: 'csv',
      sectorId: undefined,
      shiftId: '',
      status: 'all',
      date: '2026-11-19',
    });

    expect(mocks.get).toHaveBeenCalledWith('internal/people-export/people', {
      searchParams: { format: 'csv', status: 'all', date: '2026-11-19' },
      timeout: 120_000,
      retry: 0,
    });
  });

  it('salva o blob com o nome do Content-Disposition e usa a reserva sem o header', async () => {
    const params = {
      format: 'xlsx',
      sectorId: 's1',
      shiftId: 'manha',
      status: 'active',
      date: '2026-11-19',
    } as const;

    await exportPeople(params);
    expect(mocks.saveBlob).toHaveBeenLastCalledWith(blob, 'pessoas-2026-11-19.xlsx');

    respond();
    await exportPeople(params);
    expect(mocks.saveBlob).toHaveBeenLastCalledWith(blob, 'pessoas.xlsx');
  });
});

describe('useExportSchedule', () => {
  it('chama internal/people-export/schedule com setor e período', async () => {
    respond();
    const { result } = renderHook(() => useExportSchedule(), { wrapper });

    result.current.mutate({
      format: 'csv',
      sectorId: 's1',
      from: '2026-11-16',
      to: '2026-11-22',
    });

    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledWith(blob, 'escala.csv'));
    expect(mocks.get).toHaveBeenCalledWith('internal/people-export/schedule', {
      searchParams: {
        format: 'csv',
        sectorId: 's1',
        from: '2026-11-16',
        to: '2026-11-22',
      },
      timeout: 120_000,
      retry: 0,
    });
  });
});
