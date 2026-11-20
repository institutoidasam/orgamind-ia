import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  close: vi.fn(),
  discard: vi.fn(),
  downloadErrors: vi.fn(),
  toastError: vi.fn(),
  onOpen: vi.fn(),
  onDiscarded: vi.fn(),
}));

type MutateOptions = { onSuccess: () => void; onError: (error: unknown) => void };

vi.mock('../api', () => ({
  useImportBatches: (page: number) => mocks.list(page),
  useCloseImport: (id: string) => ({
    mutate: (_: unknown, options: MutateOptions) => mocks.close(id, options),
    isPending: false,
  }),
  useDiscardImport: (id: string) => ({
    mutate: (_: unknown, options: MutateOptions) => mocks.discard(id, options),
    isPending: false,
  }),
  downloadErrors: (id: string) => mocks.downloadErrors(id),
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { progress } from '../write-test-helpers';
import type { BatchSummary } from '../schemas';
import { BatchList } from './batch-list';
import { batchSummary, counts } from './preview-test-helpers';

const done = batchSummary({
  id: 'b1',
  fileName: 'pessoas-novembro.xlsx',
  situation: 'COMPLETED',
  counts: counts({ CREATE: 40, UPDATE: 5, INVALID: 2, DUPLICATE: 1 }),
  progress: progress({ toWrite: 45, created: 40, updated: 5, failed: 3 }),
  canConfirm: false,
  canDiscard: false,
  hasErrorReport: true,
});
const inPreview = batchSummary({ id: 'b2', fileName: 'novos.csv', createdBy: { id: 'u2', name: 'Rafael' } });
const writing = batchSummary({
  id: 'b3',
  fileName: 'meio.csv',
  situation: 'WRITING',
  progress: progress({ pending: 10 }),
  canConfirm: false,
  canContinue: true,
  canClose: true,
  canDiscard: false,
});

function listing(items: BatchSummary[], extra: { total?: number; page?: number } = {}) {
  mocks.list.mockReturnValue({
    data: { items, total: extra.total ?? items.length, page: extra.page ?? 1, pageSize: 20 },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
}

function setup(items: BatchSummary[], extra: { total?: number; page?: number } = {}) {
  listing(items, extra);
  render(<BatchList onOpen={mocks.onOpen} onDiscarded={mocks.onDiscarded} />);
  return userEvent.setup();
}

const rowOf = (name: RegExp) => within(screen.getByRole('row', { name }));
const cellTexts = (name: RegExp) =>
  rowOf(name)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('BatchList: tabela', () => {
  it('lista dos lotes com arquivo, autor, data, situação e contagens', () => {
    setup([done, inPreview]);
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Arquivo',
      'Enviado por',
      'Data',
      'Situação',
      'Criadas',
      'Atualizadas',
      'Não entraram',
      'Ações',
    ]);
    expect(cellTexts(/pessoas-novembro/).slice(0, 7)).toEqual([
      'pessoas-novembro.xlsx',
      'Marina',
      '19/11/2026 08:00',
      'Concluída',
      '40',
      '5',
      '6',
    ]);
    expect(cellTexts(/novos\.csv/).slice(0, 7)).toEqual([
      'novos.csv',
      'Rafael',
      '19/11/2026 08:00',
      'Em prévia',
      '—',
      '—',
      '—',
    ]);
  });

  it('a paginação de 20 em 20 pede a página seguinte', async () => {
    const user = setup([done], { total: 45 });
    expect(screen.getByText('Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(mocks.list).toHaveBeenLastCalledWith(2);
  });
});

describe('BatchList: última página esvaziada', () => {
  it('a última página que ficou vazia volta à última página válida, com o pager', async () => {
    const result = (items: BatchSummary[], total: number, page: number) => ({
      data: { items, total, page, pageSize: 20 },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    // 41 lotes = 3 páginas; ao abrir a 3ª, o 41º já foi descartado: ela vem vazia e o total cai para 40.
    let total = 41;
    mocks.list.mockImplementation((page: number) => {
      if (page !== 3) return result([done], total, page);
      total = 40;
      return result([], total, page);
    });
    render(<BatchList onOpen={mocks.onOpen} onDiscarded={mocks.onDiscarded} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await user.click(screen.getByRole('button', { name: 'Próxima' }));

    expect(await screen.findByText('Página 2 de 2')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum lote enviado ainda.')).not.toBeInTheDocument();
  });
});

describe('BatchList: ações', () => {
  it('ações conforme canContinue, canClose e canDiscard', async () => {
    const user = setup([done, inPreview, writing]);
    const buttons = (name: RegExp) =>
      rowOf(name)
        .getAllByRole('button')
        .map((button) => button.textContent);
    expect(buttons(/pessoas-novembro/)).toEqual(['Abrir', 'Relatório']);
    expect(buttons(/novos\.csv/)).toEqual(['Abrir', 'Descartar']);
    expect(buttons(/meio\.csv/)).toEqual(['Abrir', 'Continuar', 'Encerrar']);

    await user.click(rowOf(/novos\.csv/).getByRole('button', { name: 'Abrir' }));
    expect(mocks.onOpen).toHaveBeenLastCalledWith('b2');
    await user.click(rowOf(/meio\.csv/).getByRole('button', { name: 'Continuar' }));
    expect(mocks.onOpen).toHaveBeenLastCalledWith('b3');
    mocks.downloadErrors.mockResolvedValue(undefined);
    await user.click(rowOf(/pessoas-novembro/).getByRole('button', { name: 'Relatório' }));
    expect(mocks.downloadErrors).toHaveBeenCalledWith('b1');
  });

  it('Descartar e Encerrar pedem confirmação; descartar avisa a página', async () => {
    const user = setup([inPreview, writing]);
    mocks.discard.mockImplementation((_id: string, options: MutateOptions) => options.onSuccess());
    await user.click(rowOf(/novos\.csv/).getByRole('button', { name: 'Descartar' }));
    expect(mocks.discard).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Descartar' }));
    expect(mocks.discard).toHaveBeenCalledWith('b2', expect.any(Object));
    expect(mocks.onDiscarded).toHaveBeenCalledWith('b2');

    mocks.close.mockImplementation((_id: string, options: MutateOptions) => options.onSuccess());
    await user.click(rowOf(/meio\.csv/).getByRole('button', { name: 'Encerrar' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Encerrar gravação' }));
    expect(mocks.close).toHaveBeenCalledWith('b3', expect.any(Object));
    expect(mocks.onDiscarded).toHaveBeenCalledTimes(1);
  });
});

describe('BatchList: página ainda carregando', () => {
  it('sem dados da página aberta não volta para a primeira', async () => {
    const page = (items: BatchSummary[], pageNumber: number) => ({
      data: { items, total: 60, page: pageNumber, pageSize: 20 },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.list.mockImplementation((requested: number) =>
      requested === 3 ? { data: undefined, isLoading: true, isError: false, error: null } : page([done], requested),
    );
    render(<BatchList onOpen={mocks.onOpen} onDiscarded={mocks.onDiscarded} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await user.click(screen.getByRole('button', { name: 'Próxima' }));

    expect(mocks.list).toHaveBeenLastCalledWith(3);
    expect(screen.queryByText('Página 1 de 3')).not.toBeInTheDocument();
  });
});
