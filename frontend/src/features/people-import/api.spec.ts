import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HTTPError } from 'ky';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readApiErrorBody } from '@/lib/api-error';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  saveBlob: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.del },
}));
vi.mock('@/features/people-export/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/people-export/download')>()),
  saveBlob: mocks.saveBlob,
}));

import {
  downloadErrors,
  downloadTemplate,
  useCloseImport,
  useConfirmImport,
  useDiscardImport,
  useImportBatch,
  useImportBatches,
  useImportRows,
  useRemapImport,
  useUploadImport,
  writeBlock,
} from './api';
import type { ColumnMapping } from './schemas';

const mapping: ColumnMapping = {
  registration: 0,
  name: 1,
  phone: null,
  jobTitle: null,
  sector: null,
  shift: null,
  level: null,
  authorization: null,
  authorizationSource: null,
  authorizationNote: null,
  authorizationDate: null,
};
const summary = {
  id: 'b1',
  fileName: 'pessoas.csv',
  fileSize: 1200,
  format: 'csv',
  situation: 'PREVIEW',
  createdAt: '2026-11-19T12:00:00.000Z',
  createdBy: { id: 'u1', name: 'Marina' },
  confirmedAt: null,
  confirmedBy: null,
  finishedAt: null,
  headers: ['Matrícula', 'Nome'],
  mapping,
  mappingProblem: null,
  counts: null,
  progress: null,
  canConfirm: false,
  canContinue: false,
  canClose: false,
  canDiscard: true,
  hasErrorReport: false,
  phoneCheckDeferred: true,
};
const blob = new Blob(['arquivo']);

function respondJson(fn: ReturnType<typeof vi.fn>, body: unknown) {
  fn.mockReturnValue({ json: () => Promise.resolve(body) });
}

function respondFile(disposition?: string) {
  const headers = new Headers(disposition ? { 'content-disposition': disposition } : {});
  mocks.get.mockResolvedValue({ headers, blob: () => Promise.resolve(blob) });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('linhas da prévia depois de confirmar', () => {
  it('remapear relê as linhas; confirmar não (fora de PREVIEW o GET rows responde 409)', async () => {
    mocks.get.mockReturnValue({ json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 50 }) });
    respondJson(mocks.put, summary);
    respondJson(mocks.post, { ...summary, situation: 'WRITING' });
    const { result } = renderHook(
      () => ({ rows: useImportRows('b1', 1), remap: useRemapImport('b1'), confirm: useConfirmImport('b1') }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.rows.data).toBeDefined());

    await act(() => result.current.remap.mutateAsync(mapping));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await act(() =>
      result.current.confirm.mutateAsync({ createNew: true, updateExisting: true, excludedRows: [], mapping }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});

describe('envio da importação', () => {
  it('useUploadImport envia FormData sem Content-Type e timeout de 120 s', async () => {
    respondJson(mocks.post, summary);
    const file = new File(['Matrícula;Nome'], 'pessoas.csv', {
      type: 'text/csv',
    });
    const { result } = renderHook(() => useUploadImport(), { wrapper });

    const created = await act(() => result.current.mutateAsync(file));

    const [path, options] = mocks.post.mock.calls[0];
    expect(path).toBe('internal/people-import/batches');
    expect(options.timeout).toBe(120_000);
    expect(options.retry).toBe(0);
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('file')).toBe(file);
    expect(options.headers).toBeUndefined();
    expect(created).toEqual(summary);
  });

});

describe('gravação em blocos', () => {
  it('writeBlock usa timeout de 120 s e devolve o resumo', async () => {
    respondJson(mocks.post, { ...summary, situation: 'WRITING' });

    await expect(writeBlock('b1')).resolves.toMatchObject({
      id: 'b1',
      situation: 'WRITING',
    });
    expect(mocks.post).toHaveBeenCalledWith('internal/people-import/batches/b1/write', {
      timeout: 120_000,
      retry: 0,
    });
  });

  it('writeBlock repassa o erro com o corpo em data (409 not_writing)', async () => {
    const body = {
      code: 'import.not_writing',
      title: 'Conflito',
      status: 409,
      detail: 'O lote não está em gravação.',
    };
    const response = new Response(null, { status: 409 });
    const error = Object.assign(
      new HTTPError(response as never, new Request('http://localhost/x') as never, {} as never),
      { data: body },
    );
    mocks.post.mockReturnValue({ json: () => Promise.reject(error) });

    const failure = await writeBlock('b1').catch((e: unknown) => e);

    expect(await readApiErrorBody(failure)).toEqual(body);
  });

});

describe('confirmação', () => {
  it('useConfirmImport envia createNew, updateExisting, excludedRows e o mapeamento da prévia', async () => {
    respondJson(mocks.post, { ...summary, situation: 'WRITING' });
    const { result } = renderHook(() => useConfirmImport('b1'), { wrapper });

    await act(() =>
      result.current.mutateAsync({
        createNew: true,
        updateExisting: false,
        excludedRows: [3, 7],
        mapping,
      }),
    );

    expect(mocks.post).toHaveBeenCalledWith('internal/people-import/batches/b1/confirm', {
      json: { createNew: true, updateExisting: false, excludedRows: [3, 7], mapping },
      timeout: 120_000,
      retry: 0,
    });
  });
});

describe('arquivos da importação', () => {
  it('downloadTemplate e downloadErrors salvam com o nome do Content-Disposition', async () => {
    respondFile('attachment; filename="modelo-pessoas.xlsx"');
    await downloadTemplate('xlsx');
    expect(mocks.get).toHaveBeenLastCalledWith('internal/people-import/template', { searchParams: { format: 'xlsx' } });
    expect(mocks.saveBlob).toHaveBeenLastCalledWith(blob, 'modelo-pessoas.xlsx');

    respondFile('attachment; filename="erros-pessoas.csv"');
    await downloadErrors('b1');
    expect(mocks.get).toHaveBeenLastCalledWith('internal/people-import/batches/b1/errors.csv', undefined);
    expect(mocks.saveBlob).toHaveBeenLastCalledWith(blob, 'erros-pessoas.csv');
  });

  it('sem o header o nome vem da reserva montada no front', async () => {
    respondFile();
    await downloadTemplate('csv');
    expect(mocks.saveBlob).toHaveBeenLastCalledWith(blob, 'modelo-importacao-pessoas.csv');
    await downloadErrors('b1');
    expect(mocks.saveBlob).toHaveBeenLastCalledWith(blob, 'erros-importacao.csv');
  });
});

describe('consultas do lote', () => {
  it('lista, resumo e linhas pedem as rotas do lote e validam a resposta', async () => {
    const page = { total: 0, page: 2, pageSize: 50 };
    mocks.get.mockImplementation((path: string) => {
      const body = path.endsWith('/rows')
        ? { items: [], ...page }
        : path.endsWith('/batches')
          ? { items: [], ...page }
          : summary;
      return { json: () => Promise.resolve(body) };
    });
    const { result } = renderHook(
      () => ({
        list: useImportBatches(2),
        batch: useImportBatch('b1'),
        rows: useImportRows('b1', 2, 'INVALID'),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.rows.data?.page).toBe(2));
    await waitFor(() => expect(result.current.batch.data?.id).toBe('b1'));
    await waitFor(() => expect(result.current.list.data?.items).toEqual([]));
    expect(mocks.get).toHaveBeenCalledWith('internal/people-import/batches', {
      searchParams: { page: 2 },
    });
    expect(mocks.get).toHaveBeenCalledWith('internal/people-import/batches/b1');
    expect(mocks.get).toHaveBeenCalledWith('internal/people-import/batches/b1/rows', {
      searchParams: { page: 2, classification: 'INVALID' },
    });
  });

});

describe('ações do lote', () => {
  it('remapear, encerrar e descartar chamam as rotas do lote', async () => {
    respondJson(mocks.put, summary);
    respondJson(mocks.post, { ...summary, situation: 'CLOSED' });
    mocks.del.mockResolvedValue(new Response(null, { status: 204 }));
    const { result } = renderHook(
      () => ({
        remap: useRemapImport('b1'),
        close: useCloseImport('b1'),
        discard: useDiscardImport('b1'),
      }),
      { wrapper },
    );

    await act(() => result.current.remap.mutateAsync(mapping));
    await act(() => result.current.close.mutateAsync());
    await act(() => result.current.discard.mutateAsync());

    expect(mocks.put).toHaveBeenCalledWith('internal/people-import/batches/b1/mapping', {
      json: { mapping },
      timeout: 120_000,
    });
    expect(mocks.post).toHaveBeenCalledWith('internal/people-import/batches/b1/close', { retry: 0 });
    expect(mocks.del).toHaveBeenCalledWith('internal/people-import/batches/b1');
  });
});
