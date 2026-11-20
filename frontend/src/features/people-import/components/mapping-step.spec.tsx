import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  del: vi.fn(),
  toastError: vi.fn(),
  onReady: vi.fn(),
  onDiscarded: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ api: { put: mocks.put, delete: mocks.del } }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

import type { BatchSummary, ColumnMapping } from '../schemas';
import { MappingStep } from './mapping-step';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const mapping: ColumnMapping = {
  registration: 0,
  name: 1,
  phone: 2,
  jobTitle: 3,
  sector: null,
  shift: null,
  level: null,
  authorization: null,
  authorizationSource: null,
  authorizationNote: null,
  authorizationDate: null,
};
const batch: BatchSummary = {
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
  headers: ['Matrícula', 'Nome', 'celular', 'cargo', 'Observação'],
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
const NAME_PROBLEM = 'Escolha a coluna de Nome e pelo menos uma entre Telefone e Matrícula.';
const SECTOR_PROBLEM =
  'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.';

type User = ReturnType<typeof userEvent.setup>;

function ky2Error(status: number, data: unknown) {
  const error = new HTTPError(new Response(null, { status }), new Request('http://localhost/x'), {} as never);
  error.data = data as HTTPError['data'];
  return error;
}

function setup(props: { batch?: BatchSummary; role?: AuthUser['role'] } = {}) {
  useAuthStore.setState({
    accessToken: 'tok',
    user: { id: 'u1', email: 'a@b.com', name: 'Ana', role: props.role ?? 'ADMIN' },
    mustChangePassword: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MappingStep batch={props.batch ?? batch} onReady={mocks.onReady} onDiscarded={mocks.onDiscarded} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const columnSelect = (header: string) => screen.getByRole('combobox', { name: `Campo da coluna ${header}` });
const previewButton = () => screen.getByRole('button', { name: 'Ver prévia' });

async function choose(user: User, header: string, option: string) {
  await user.click(columnSelect(header));
  await user.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MappingStep: colunas', () => {
  it('mostra as colunas com o campo sugerido e Não usar', () => {
    setup();

    expect(screen.getByRole('columnheader', { name: 'Coluna do arquivo' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Campo' })).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'MatrículaMatrícula',
      'NomeNome',
      'celularTelefone',
      'cargoFunção',
      'ObservaçãoNão usar',
    ]);
  });

  it('campo já usado fica indisponível nas outras colunas', async () => {
    const user = setup();

    await user.click(columnSelect('Observação'));
    expect(await screen.findByRole('option', { name: 'Nome' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Turno' })).not.toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');

    await user.click(columnSelect('Nome'));
    expect(await screen.findByRole('option', { name: 'Nome' })).not.toHaveAttribute('aria-disabled', 'true');
  });
});

describe('MappingStep: Ver prévia', () => {
  it('aceite 13: Ver prévia envia o mapeamento quando mudou', async () => {
    const remapped = { ...batch, mapping: { ...mapping, shift: 4 } };
    mocks.put.mockReturnValue({ json: () => Promise.resolve(remapped) });
    const user = setup();

    await choose(user, 'Observação', 'Turno');
    await user.click(previewButton());

    await waitFor(() => expect(mocks.onReady).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' })));
    expect(mocks.put).toHaveBeenCalledWith('internal/people-import/batches/b1/mapping', {
      json: { mapping: { ...mapping, shift: 4 } },
      timeout: 120_000,
    });
  });

  it('Ver prévia sem mudança segue sem remapear', async () => {
    const user = setup();

    await user.click(previewButton());

    expect(mocks.onReady).toHaveBeenCalledWith(batch);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('erro ao refazer a prévia mostra o texto da API e não segue', async () => {
    mocks.put.mockReturnValue({
      json: () => Promise.reject(ky2Error(409, { detail: 'Este lote não está mais em prévia.' })),
    });
    const user = setup();

    await choose(user, 'Observação', 'Turno');
    await user.click(previewButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Este lote não está mais em prévia.'));
    expect(mocks.onReady).not.toHaveBeenCalled();
  });
});

describe('MappingStep: mapeamento incompleto', () => {
  it('mapeamento incompleto mostra o aviso e desabilita Ver prévia', async () => {
    const user = setup();

    await choose(user, 'Nome', 'Não usar');

    expect(screen.getByRole('alert')).toHaveTextContent(NAME_PROBLEM);
    expect(previewButton()).toBeDisabled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('aviso do resumo (mappingProblem) aparece e desabilita Ver prévia até mudar o mapeamento', async () => {
    const incomplete = { ...batch, mapping: { ...mapping, name: null }, mappingProblem: NAME_PROBLEM };
    const user = setup({ batch: incomplete });

    expect(screen.getByRole('alert')).toHaveTextContent(NAME_PROBLEM);
    expect(previewButton()).toBeDisabled();

    await choose(user, 'Nome', 'Nome');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
  });

  it('quem não é administrador precisa da coluna Setor; o administrador não', async () => {
    const user = setup({ role: 'SUPERVISOR' });

    expect(screen.getByRole('alert')).toHaveTextContent(SECTOR_PROBLEM);
    expect(previewButton()).toBeDisabled();

    await choose(user, 'Observação', 'Setor');
    expect(previewButton()).toBeEnabled();
  });
});

describe('MappingStep: acessibilidade do aviso', () => {
  it('o aviso de mapeamento incompleto descreve o botão Ver prévia', async () => {
    const user = setup();
    expect(previewButton()).not.toHaveAccessibleDescription();

    await choose(user, 'Nome', 'Não usar');

    expect(previewButton()).toHaveAccessibleDescription(NAME_PROBLEM);
  });
});

describe('MappingStep: descartar', () => {
  it('Descartar lote pede confirmação', async () => {
    mocks.del.mockResolvedValue(new Response(null, { status: 204 }));
    const user = setup();

    await user.click(screen.getByRole('button', { name: 'Descartar lote' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Descartar este lote?')).toBeInTheDocument();
    expect(mocks.del).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mocks.del).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Descartar lote' }));
    await user.click(await screen.findByRole('button', { name: 'Descartar' }));

    await waitFor(() => expect(mocks.onDiscarded).toHaveBeenCalledTimes(1));
    expect(mocks.del).toHaveBeenCalledWith('internal/people-import/batches/b1');
  });

  it('erro ao descartar mostra o texto da API e mantém o lote', async () => {
    mocks.del.mockRejectedValue(ky2Error(403, { detail: 'Só quem enviou pode descartar o lote.' }));
    const user = setup();

    await user.click(screen.getByRole('button', { name: 'Descartar lote' }));
    await user.click(await screen.findByRole('button', { name: 'Descartar' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Só quem enviou pode descartar o lote.'));
    expect(mocks.onDiscarded).not.toHaveBeenCalled();
  });
});
