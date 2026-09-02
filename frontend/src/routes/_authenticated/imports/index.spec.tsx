import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// --- Router mock ----------------------------------------------------------
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
  }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// --- Feature API mock -----------------------------------------------------
const useImportsMock = vi.fn();
vi.mock('@/features/imports/api', () => ({
  useImports: () => useImportsMock(),
}));

import { Route } from './index';

const ImportsPage = (Route as unknown as { component: React.ComponentType })
  .component;

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useImportsMock.mockReset();
});

describe('ImportsPage — error state (schema drift / fetch failure)', () => {
  it('renders the error fallback with a retry button when the query fails', async () => {
    const refetch = vi.fn();
    useImportsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('parse boom'),
      refetch,
    });

    wrap(<ImportsPage />);

    // QueryErrorFallback renders a "Tentar novamente" retry button.
    expect(
      await screen.findByRole('button', { name: /Tentar novamente/i }),
    ).toBeInTheDocument();

    // The table header must NOT be shown on error (no empty table).
    expect(screen.queryByText('Arquivo')).not.toBeInTheDocument();
  });

  it('renders the table when the query succeeds', () => {
    useImportsMock.mockReturnValue({
      data: [
        {
          id: 'b1',
          filename: 'contatos.xlsx',
          totalRows: 10,
          importedRows: 9,
          status: 'COMPLETED',
          summary: null,
          errors: null,
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<ImportsPage />);

    expect(screen.getByText('Arquivo')).toBeInTheDocument();
    expect(screen.getByText('contatos.xlsx')).toBeInTheDocument();
  });

  it('shows a per-batch status label (header + each batch row)', () => {
    useImportsMock.mockReturnValue({
      data: [
        {
          id: 'b-done',
          filename: 'done.xlsx',
          totalRows: 5,
          importedRows: 5,
          status: 'COMPLETED',
          summary: null,
          errors: null,
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
        {
          id: 'b-running',
          filename: 'running.xlsx',
          totalRows: 0,
          importedRows: 0,
          status: 'PROCESSING',
          summary: null,
          errors: null,
          createdAt: new Date('2026-06-02T00:00:00Z'),
        },
        {
          id: 'b-failed',
          filename: 'failed.xlsx',
          totalRows: 0,
          importedRows: 0,
          status: 'FAILED',
          summary: null,
          errors: { message: 'boom' },
          createdAt: new Date('2026-06-03T00:00:00Z'),
        },
        {
          id: 'b-pending',
          filename: 'pending.xlsx',
          totalRows: 0,
          importedRows: 0,
          status: 'PENDING',
          summary: null,
          errors: null,
          createdAt: new Date('2026-06-04T00:00:00Z'),
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    wrap(<ImportsPage />);

    // Column header.
    expect(screen.getByText('Status')).toBeInTheDocument();
    // Human-readable status per row (PT-BR labels).
    expect(screen.getByText(/conclu/i)).toBeInTheDocument(); // COMPLETED
    expect(screen.getByText(/processand/i)).toBeInTheDocument(); // PROCESSING
    expect(screen.getByText(/falh/i)).toBeInTheDocument(); // FAILED
    expect(screen.getByText(/aguard|pendente|fila/i)).toBeInTheDocument(); // PENDING
  });

  it('falls back gracefully for an unknown status value (no crash)', () => {
    useImportsMock.mockReturnValue({
      data: [
        {
          id: 'b-weird',
          filename: 'weird.xlsx',
          totalRows: 0,
          importedRows: 0,
          status: 'SOMETHING_NEW',
          summary: null,
          errors: null,
          createdAt: new Date('2026-06-05T00:00:00Z'),
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });

    // Must not throw (global ErrorBoundary would otherwise full-page crash).
    expect(() => wrap(<ImportsPage />)).not.toThrow();
    expect(screen.getByText('weird.xlsx')).toBeInTheDocument();
  });
});
