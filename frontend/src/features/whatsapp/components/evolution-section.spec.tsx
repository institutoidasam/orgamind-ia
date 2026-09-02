import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Action } from './instances-list';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock('@/lib/api-error', () => ({
  extractApiError: vi.fn(async (err: unknown) => ({
    title: 'Erro',
    message: err instanceof Error ? err.message : 'falhou',
  })),
}));

const delMutateAsync = vi.fn();
const setDefaultMutateAsync = vi.fn();
const restartMutateAsync = vi.fn();
const instancesRefetch = vi.fn();
const instancesState = {
  data: [{ id: 'inst1', name: 'Principal', lastConnectionState: 'open' }],
  isError: false,
  error: null as unknown,
  refetch: instancesRefetch,
};

vi.mock('../api', () => ({
  useInstances: () => instancesState,
  useDeleteInstance: () => ({ mutateAsync: delMutateAsync, isPending: false }),
  useSetDefaultInstance: () => ({ mutateAsync: setDefaultMutateAsync, isPending: false }),
  useRestartInstance: () => ({ mutateAsync: restartMutateAsync, isPending: false }),
}));

// Stub InstancesList to drive onAction directly; stub the heavy dialogs.
vi.mock('./instances-list', () => ({
  InstancesList: ({ onAction }: { onAction: (a: Action) => void }) => (
    <div>
      <button onClick={() => onAction({ kind: 'remove', id: 'inst1' })}>remover</button>
      <button onClick={() => onAction({ kind: 'setDefault', id: 'inst1' })}>padrao</button>
      <button onClick={() => onAction({ kind: 'restart', id: 'inst1' })}>reiniciar</button>
    </div>
  ),
}));
vi.mock('./create-instance-dialog', () => ({ CreateInstanceDialog: () => null }));
vi.mock('./connect-instance-dialog', () => ({ ConnectInstanceDialog: () => null }));
vi.mock('./instance-config-drawer', () => ({ InstanceConfigDrawer: () => null }));

import { EvolutionSection } from './evolution-section';

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
  delMutateAsync.mockReset();
  setDefaultMutateAsync.mockReset();
  restartMutateAsync.mockReset();
  instancesRefetch.mockReset();
  instancesState.data = [{ id: 'inst1', name: 'Principal', lastConnectionState: 'open' }];
  instancesState.isError = false;
  instancesState.error = null;
});

describe('EvolutionSection — remove handling', () => {
  it('shows toast.error and no success toast when remove rejects', async () => {
    delMutateAsync.mockRejectedValue(new Error('remove boom'));
    wrap(<EvolutionSection role="ADMIN" />);
    fireEvent.click(screen.getByRole('button', { name: /remover/i }));

    await waitFor(() => expect(delMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('shows success toast when remove resolves', async () => {
    delMutateAsync.mockResolvedValue(undefined);
    wrap(<EvolutionSection role="ADMIN" />);
    fireEvent.click(screen.getByRole('button', { name: /remover/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Conexão removida'));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('EvolutionSection — setDefault handling', () => {
  it('shows toast.error and no success toast when setDefault rejects', async () => {
    setDefaultMutateAsync.mockRejectedValue(new Error('default boom'));
    wrap(<EvolutionSection role="ADMIN" />);
    fireEvent.click(screen.getByRole('button', { name: /padrao/i }));

    await waitFor(() => expect(setDefaultMutateAsync).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('shows success toast when setDefault resolves', async () => {
    setDefaultMutateAsync.mockResolvedValue(undefined);
    wrap(<EvolutionSection role="ADMIN" />);
    fireEvent.click(screen.getByRole('button', { name: /padrao/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Padrão atualizado'));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('EvolutionSection — query error', () => {
  it('renders the error fallback with retry when the instances query errors', async () => {
    instancesState.isError = true;
    instancesState.error = new Error('instances boom');
    wrap(<EvolutionSection role="ADMIN" />);
    expect(
      await screen.findByRole('button', { name: /Tentar novamente/i }),
    ).toBeInTheDocument();
  });
});
