import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchSummary, RowView } from '../schemas';
import { batchSummary, counts, rowView } from './preview-test-helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { PreviewStep } from './preview-step';

const ROWS_PATH = 'internal/people-import/batches/b1/rows';
const ROWS: RowView[] = [
  rowView(2, 'CREATE'),
  rowView(3, 'UPDATE'),
  rowView(4, 'INVALID', { reasons: ['Telefone inválido'] }),
];
const DEFERRED_TEXT = 'A conferência de telefones já cadastrados é feita ao gravar.';

type Server = { summary: BatchSummary; total?: number };

/** `get` responde como o ky: linhas filtradas e paginadas em `.../rows`, o resumo no resto. */
function serve(server: Server) {
  mocks.get.mockImplementation(
    (path: string, options?: { searchParams?: { page: number; classification?: string } }) => {
      if (!path.endsWith('/rows')) return { json: () => Promise.resolve(server.summary) };
      const { page = 1, classification } = options?.searchParams ?? {};
      const items = ROWS.filter((r) => !classification || r.classification === classification);
      const body = {
        items: server.total ? [rowView(page * 100, 'CREATE')] : items,
        total: server.total ?? items.length,
        page,
        pageSize: 50,
      };
      return { json: () => Promise.resolve(body) };
    },
  );
}

function setup(summary: BatchSummary, total?: number) {
  const server: Server = { summary, total };
  serve(server);
  const onConfirmed = vi.fn();
  const onBack = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PreviewStep batch={summary} onConfirmed={onConfirmed} onBack={onBack} />
    </QueryClientProvider>,
  );
  return { server, onConfirmed, onBack };
}

beforeEach(() => vi.clearAllMocks());

const SUMMARY = batchSummary({
  counts: counts({ CREATE: 12, UPDATE: 30, INVALID: 1 }),
  mapping: { ...batchSummary().mapping, name: 0, phone: 1 },
});

describe('PreviewStep: a prévia mudou em outra aba (EX7)', () => {
  it('após preview_changed a seleção zera', async () => {
    setup(SUMMARY);
    const changed = new HTTPError(new Response(null, { status: 409 }), new Request('https://x'), {} as never);
    changed.data = { code: 'people_import.preview_changed' } as HTTPError['data'];
    mocks.post.mockReturnValue({ json: () => Promise.reject(changed) });
    const updates = { name: 'Atualizar pessoas existentes (30)' };

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Incluir a linha 2' }));
    await userEvent.click(screen.getByRole('checkbox', updates));
    expect(screen.getByText('Criar 11 pessoas')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar importação' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByText('Criar 12 e atualizar 30 pessoas')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Incluir a linha 2' })).toBeChecked();
    expect(screen.getByRole('checkbox', updates)).toBeChecked();
  });
});

describe('PreviewStep: contadores, filtro e página', () => {
  it('contadores e filtro por classificação', async () => {
    setup(SUMMARY);

    expect(screen.getByRole('button', { name: 'Todas 43' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Criar 12' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sem alteração 0' })).toBeInTheDocument();
    expect(await screen.findByText('Pessoa 2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Atualizar 30' }));

    await waitFor(() => expect(screen.queryByText('Pessoa 2')).not.toBeInTheDocument());
    expect(screen.getByText('Pessoa 3')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(ROWS_PATH, {
      searchParams: { page: 1, classification: 'UPDATE' },
    });
  });

  it('paginação de 50', async () => {
    setup(SUMMARY, 120);
    expect(await screen.findByText('Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Página 2 de 3')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(ROWS_PATH, {
      searchParams: { page: 2 },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Página 3 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
  });
});

describe('PreviewStep: contagem da seleção', () => {
  it('marcadores gerais e caixas por linha mudam as contagens', async () => {
    setup(SUMMARY);
    const confirm = screen.getByRole('button', {
      name: 'Confirmar importação',
    });
    expect(screen.getByText('Criar 12 e atualizar 30 pessoas')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Incluir a linha 2' }));
    expect(screen.getByText('Criar 11 e atualizar 30 pessoas')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Criar pessoas novas (11)' })).toBeChecked();

    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Atualizar pessoas existentes (30)',
      }),
    );
    expect(screen.getByText('Criar 11 pessoas')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Incluir a linha 3' })).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Criar pessoas novas (11)' }));
    expect(screen.getByText('Nenhuma pessoa selecionada')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });
});

describe('PreviewStep: confirmação', () => {
  it('confirma com a seleção feita e entrega o resumo ao andamento', async () => {
    const { onConfirmed } = setup(SUMMARY);
    const writing = batchSummary({ situation: 'WRITING' });
    mocks.post.mockReturnValue({ json: () => Promise.resolve(writing) });

    await userEvent.click(await screen.findByRole('checkbox', { name: 'Incluir a linha 2' }));
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Atualizar pessoas existentes (30)',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar importação' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(writing));
    expect(mocks.post).toHaveBeenCalledWith(
      'internal/people-import/batches/b1/confirm',
      expect.objectContaining({
        json: { createNew: true, updateExisting: false, excludedRows: [2], mapping: SUMMARY.mapping },
      }),
    );
  });
});

describe('PreviewStep: confirmação feita em outra aba', () => {
  it('409 já confirmado leva ao andamento', async () => {
    const { server, onConfirmed } = setup(SUMMARY);
    const writing = batchSummary({ situation: 'WRITING', canConfirm: false });
    const conflict = new HTTPError(new Response(null, { status: 409 }), new Request('https://x'), {} as never);
    conflict.data = {
      code: 'people_import.already_confirmed',
    } as HTTPError['data'];
    mocks.post.mockImplementation(() => {
      server.summary = writing;
      return { json: () => Promise.reject(conflict) };
    });

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar importação' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(writing));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

describe('PreviewStep: aviso dos telefones', () => {
  it('S1-6: aviso fixo da conferência de telefones só com phoneCheckDeferred', async () => {
    setup(batchSummary({ ...SUMMARY, phoneCheckDeferred: true }));
    expect(screen.getByText(DEFERRED_TEXT)).toBeInTheDocument();
  });

  it('S1-6: sem phoneCheckDeferred o aviso não aparece e Voltar às colunas volta', async () => {
    const { onBack } = setup(SUMMARY);
    expect(await screen.findByText('Pessoa 2')).toBeInTheDocument();
    expect(screen.queryByText(DEFERRED_TEXT)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Voltar às colunas' }));

    expect(onBack).toHaveBeenCalledOnce();
  });
});
