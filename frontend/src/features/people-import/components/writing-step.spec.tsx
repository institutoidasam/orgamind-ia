import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchSummary } from '../schemas';
import { progress, writingBatch } from '../write-test-helpers';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  toastError: vi.fn(),
  useWriteLoop: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ api: { post: mocks.post } }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('../use-write-loop', () => ({ useWriteLoop: mocks.useWriteLoop }));

import { WritingStep } from './writing-step';

const start = vi.fn();

type LoopState = {
  running: boolean;
  summary: BatchSummary;
  error: string | null;
};

function setup(state: Partial<LoopState> = {}, props: { isAdmin?: boolean; autoStart?: boolean } = {}) {
  const loop: LoopState = {
    running: false,
    summary: writingBatch(),
    error: null,
    ...state,
  };
  mocks.useWriteLoop.mockReturnValue({ ...loop, start });
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WritingStep batch={loop.summary} isAdmin={props.isAdmin ?? false} autoStart={props.autoStart} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockReturnValue({
    json: () => Promise.resolve(writingBatch({ situation: 'CLOSED' })),
  });
});

describe('WritingStep: andamento', () => {
  it('mostra Gravando X de Y', () => {
    const done = progress({
      created: 80,
      updated: 20,
      unchanged: 10,
      failed: 5,
      notWritten: 5,
      pending: 180,
    });
    setup({ running: true, summary: writingBatch({ progress: done }) });

    expect(screen.getByText('Gravando 120 de 300')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '120');
    expect(screen.queryByRole('button', { name: 'Continuar gravação' })).not.toBeInTheDocument();
  });

  it('só começa sozinho com autoStart (logo depois da confirmação)', () => {
    setup({ running: false }, { autoStart: true });
    expect(start).toHaveBeenCalledOnce();
  });

  it('ao abrir o lote não começa sozinho', () => {
    setup({ running: false });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('WritingStep: início automático', () => {
  it('um laço parado (ex.: 403) não reinicia sozinho quando o start da tela muda', () => {
    const state = { running: false, summary: writingBatch(), error: null };
    mocks.useWriteLoop.mockReturnValue({ ...state, start });
    const client = new QueryClient();
    const tree = () => (
      <QueryClientProvider client={client}>
        <WritingStep batch={state.summary} isAdmin={false} autoStart />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    expect(start).toHaveBeenCalledOnce();

    const restarted = vi.fn();
    mocks.useWriteLoop.mockReturnValue({ ...state, error: 'Sem permissão.', start: restarted });
    rerender(tree());

    expect(restarted).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });
});

describe('WritingStep: interrompida', () => {
  it('Continuar gravação só para quem confirmou', async () => {
    setup({ summary: writingBatch({ situation: 'INTERRUPTED' }) });

    expect(screen.getByText('Gravação interrompida')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continuar gravação' }));
    expect(start).toHaveBeenCalledOnce();
  });

  it('quem não confirmou vê o motivo e nenhum botão de continuar', () => {
    setup({
      summary: writingBatch({ situation: 'INTERRUPTED', canContinue: false }),
    });

    expect(screen.queryByRole('button', { name: 'Continuar gravação' })).not.toBeInTheDocument();
    expect(screen.getByText(/Só quem confirmou a importação pode continuar/)).toBeInTheDocument();
  });

  it('mostra o aviso da API, como o de permissão perdida', () => {
    setup({
      error: 'Você não tem permissão para importar planilhas de pessoas.',
    });

    expect(screen.getByText('Gravação interrompida')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Você não tem permissão para importar planilhas de pessoas.');
  });
});

describe('WritingStep: Encerrar gravação', () => {
  it('não aparece para quem não é ADMIN', () => {
    setup({}, { isAdmin: false });
    expect(screen.queryByRole('button', { name: 'Encerrar gravação' })).not.toBeInTheDocument();
  });

  it('ADMIN confirma no diálogo e o lote é encerrado', async () => {
    setup({}, { isAdmin: true });

    await userEvent.click(screen.getByRole('button', { name: 'Encerrar gravação' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/ficarão como 'Não gravada: gravação encerrada'/)).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Encerrar gravação' }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('internal/people-import/batches/b1/close', { retry: 0 }));
  });
});
