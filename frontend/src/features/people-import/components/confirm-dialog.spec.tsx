import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmSelection } from '../api';
import { batchSummary } from './preview-test-helpers';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  api: { get: mocks.get, post: mocks.post },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { ConfirmDialog } from './confirm-dialog';

const SELECTION: ConfirmSelection = {
  createNew: true,
  updateExisting: true,
  excludedRows: [4, 9],
  mapping: { ...batchSummary().mapping, name: 0, phone: 1 },
};
const WRITING = batchSummary({ situation: 'WRITING', canConfirm: false });

function setup(toCreate: number, toUpdate: number) {
  const onConfirmed = vi.fn();
  const onOpenChange = vi.fn();
  const onPreviewChanged = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialog
        batchId="b1"
        open
        toCreate={toCreate}
        toUpdate={toUpdate}
        selection={SELECTION}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
        onPreviewChanged={onPreviewChanged}
      />
    </QueryClientProvider>,
  );
  return { onConfirmed, onOpenChange, onPreviewChanged, client };
}

/** O POST da confirmação responde 409 `preview_changed` (outra aba remapeou depois da prévia). */
function previewChangedOnConfirm() {
  const changed = new HTTPError(new Response(null, { status: 409 }), new Request('https://x'), {} as never);
  changed.data = { code: 'people_import.preview_changed' } as HTTPError['data'];
  mocks.get.mockReturnValue({ json: () => Promise.resolve(batchSummary()) });
  mocks.post.mockReturnValue({ json: () => Promise.reject(changed) });
}

describe('ConfirmDialog: preview_changed fecha o diálogo (EX7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewChangedOnConfirm();
  });

  it('após preview_changed o diálogo fecha e onPreviewChanged é chamado', async () => {
    const { onOpenChange, onPreviewChanged, onConfirmed } = setup(1, 0);

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(onPreviewChanged).toHaveBeenCalledOnce());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockReturnValue({ json: () => Promise.resolve(batchSummary()) });
    mocks.post.mockReturnValue({ json: () => Promise.resolve(WRITING) });
  });

  it('mostra Criar 12 e atualizar 30 pessoas e envia a seleção', async () => {
    const { onConfirmed } = setup(12, 30);

    expect(screen.getByRole('alertdialog', { name: 'Confirmar importação' })).toBeInTheDocument();
    expect(screen.getByText('Criar 12 e atualizar 30 pessoas')).toBeInTheDocument();
    expect(
      screen.getByText('Depois de confirmar, a gravação começa e não dá para desfazer pela planilha.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(WRITING));
    expect(mocks.post).toHaveBeenCalledWith(
      'internal/people-import/batches/b1/confirm',
      expect.objectContaining({ json: SELECTION }),
    );
  });

  it('Cancelar fecha sem enviar nada', async () => {
    const { onOpenChange } = setup(1, 0);

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog: 409 com a releitura falhando', () => {
  it('não segue para o andamento com o resumo antigo (ainda em prévia): mostra o erro', async () => {
    const conflict = new HTTPError(new Response(null, { status: 409 }), new Request('https://x'), {} as never);
    conflict.data = { code: 'people_import.already_confirmed' } as HTTPError['data'];
    let offline = false;
    mocks.post.mockImplementation(() => {
      offline = true;
      return { json: () => Promise.reject(conflict) };
    });
    mocks.get.mockImplementation(() => ({
      json: () => (offline ? Promise.reject(new Error('rede')) : Promise.resolve(batchSummary())),
    }));
    const { onConfirmed } = setup(1, 0);

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce());
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog: 409 prévia mudou', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewChangedOnConfirm();
  });

  it('avisa que a prévia mudou, não segue para o andamento e manda recarregar o resumo e as linhas', async () => {
    const { onConfirmed, client } = setup(1, 0);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await userEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('A prévia mudou', {
        description: 'A prévia mudou depois que você a abriu. Confira de novo antes de confirmar.',
      }),
    );
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['people-import', 'batch', 'b1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['people-import', 'rows', 'b1'] });
  });
});
