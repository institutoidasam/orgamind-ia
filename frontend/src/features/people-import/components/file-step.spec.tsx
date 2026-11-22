import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  saveBlob: vi.fn(),
  toastError: vi.fn(),
  onUploaded: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@/features/people-export/download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/people-export/download')>()),
  saveBlob: mocks.saveBlob,
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import { IMPORT_MAX_BYTES } from '../api';
import { FileStep } from './file-step';

const fullMapping = {
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
  mapping: fullMapping,
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
const TOO_BIG_TEXT = 'O arquivo passa de 5 MB. Divida a planilha e envie em partes.';
const sheet = () => new File(['Matrícula;Nome'], 'pessoas.csv', { type: 'text/csv' });

function ky2Error(status: number, data: unknown) {
  const error = new HTTPError(new Response(null, { status }), new Request('http://localhost/x'), {} as never);
  error.data = data as HTTPError['data'];
  return error;
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FileStep onUploaded={mocks.onUploaded} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const fileInput = () => screen.getByLabelText('Planilha (.csv ou .xlsx, até 5 MB)');
const sendButton = () => screen.getByRole('button', { name: 'Enviar planilha' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FileStep: modelo', () => {
  it('baixar modelo CSV e XLSX', async () => {
    mocks.get.mockResolvedValue({ headers: new Headers(), blob: () => Promise.resolve(new Blob(['modelo'])) });
    const user = setup();

    await user.click(screen.getByRole('button', { name: 'Baixar modelo CSV' }));
    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Baixar modelo XLSX' }));
    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledTimes(2));

    expect(mocks.get).toHaveBeenNthCalledWith(1, 'internal/people-import/template', { searchParams: { format: 'csv' } });
    expect(mocks.get).toHaveBeenNthCalledWith(2, 'internal/people-import/template', {
      searchParams: { format: 'xlsx' },
    });
    expect(mocks.saveBlob.mock.calls.map((call) => call[1])).toEqual([
      'modelo-importacao-pessoas.csv',
      'modelo-importacao-pessoas.xlsx',
    ]);
  });

  it('falha ao baixar o modelo mostra o texto da API', async () => {
    mocks.get.mockRejectedValue(ky2Error(403, { detail: 'Sem permissão para importar.' }));
    const user = setup();

    await user.click(screen.getByRole('button', { name: 'Baixar modelo CSV' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Sem permissão para importar.'));
    expect(mocks.saveBlob).not.toHaveBeenCalled();
  });
});

describe('FileStep: envio', () => {
  it('sem arquivo escolhido, Enviar planilha fica desabilitado', () => {
    setup();
    expect(sendButton()).toBeDisabled();
  });

  it('arquivo acima de 5 MB avisa sem enviar', async () => {
    const user = setup();
    const big = new File([new Uint8Array(IMPORT_MAX_BYTES + 1)], 'grande.csv', { type: 'text/csv' });

    await user.upload(fileInput(), big);

    expect(screen.getByText(TOO_BIG_TEXT)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('FileStep: acessibilidade', () => {
  it('o aviso de arquivo grande descreve o campo e o botão para leitor de tela', async () => {
    const user = setup();
    const big = new File([new Uint8Array(IMPORT_MAX_BYTES + 1)], 'grande.csv', { type: 'text/csv' });
    expect(fileInput()).not.toHaveAccessibleDescription();

    await user.upload(fileInput(), big);

    expect(fileInput()).toHaveAccessibleDescription(TOO_BIG_TEXT);
    expect(sendButton()).toHaveAccessibleDescription(TOO_BIG_TEXT);
  });
});

describe('FileStep: resposta do envio', () => {
  it('envio com erro mostra o texto da API', async () => {
    mocks.post.mockReturnValue({
      json: () => Promise.reject(ky2Error(422, { detail: 'Formato não aceito: envie .csv ou .xlsx.' })),
    });
    const user = setup();

    await user.upload(fileInput(), sheet());
    await user.click(sendButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Formato não aceito: envie .csv ou .xlsx.'));
    expect(mocks.onUploaded).not.toHaveBeenCalled();
  });

  it('envio com erro sem texto da API mostra a mensagem de reserva', async () => {
    mocks.post.mockReturnValue({ json: () => Promise.reject(new Error('rede')) });
    const user = setup();

    await user.upload(fileInput(), sheet());
    await user.click(sendButton());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Não foi possível enviar a planilha. Tente de novo.'),
    );
  });

  it('envio com sucesso chama onUploaded', async () => {
    mocks.post.mockReturnValue({ json: () => Promise.resolve(summary) });
    const user = setup();

    await user.upload(fileInput(), sheet());
    await user.click(sendButton());

    await waitFor(() => expect(mocks.onUploaded).toHaveBeenCalledTimes(1));
    expect(mocks.onUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1', fileName: 'pessoas.csv' }));
    const [path, options] = mocks.post.mock.calls[0];
    expect(path).toBe('internal/people-import/batches');
    expect((options.body as FormData).get('file')).toBeInstanceOf(File);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
