import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ api: { get: mocks.get } }));
// A seção Vínculos tem spec próprio e faz outra consulta; aqui fica um marcador vazio, sem GET.
vi.mock('./person-assignments', () => ({ PersonAssignments: () => <div data-testid="person-assignments" /> }));

import { PersonHistoryDialog } from './person-history-dialog';

const maria = { id: 'u2', name: 'Maria Souza' };
const joao = { id: 'u3', name: 'João Lima' };

const phoneChange = {
  id: 'a1',
  createdAt: '2026-11-19T14:30:00.000Z',
  action: 'user.profile_updated',
  category: 'PERSON',
  actor: { id: 'u1', name: 'Ana Admin' },
  subject: { id: 'u2', name: 'Maria Souza', registration: '1234' },
  reason: 'Troca de número',
  changes: [
    { field: 'phone', before: '•••• 1234', after: '•••• 5678' },
    { field: 'contactAuthorization', before: 'NAO_AUTORIZADO', after: 'AUTORIZADO' },
  ],
};

function pageOf(items: unknown[], extra: { total?: number; page?: number } = {}) {
  return { items, total: extra.total ?? items.length, page: extra.page ?? 1, pageSize: 20 };
}

function respondWith(body: unknown) {
  mocks.get.mockReturnValue({ json: () => Promise.resolve(body) });
}

function failWith(status: number, body: Record<string, unknown>) {
  const response = new Response(JSON.stringify(body), { status });
  const error = new HTTPError(response, new Request('https://x'), {} as never);
  mocks.get.mockReturnValue({ json: () => Promise.reject(error) });
}

function Harness({ person = maria, open = true }: { person?: { id: string; name: string }; open?: boolean }) {
  return <PersonHistoryDialog person={person} open={open} onOpenChange={vi.fn()} />;
}

function renderDialog(props: Parameters<typeof Harness>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (next: Parameters<typeof Harness>[0]) => (
    <QueryClientProvider client={client}><Harness {...next} /></QueryClientProvider>
  );
  const view = render(wrap(props));
  return { rerender: (next: Parameters<typeof Harness>[0]) => view.rerender(wrap(next)) };
}

function lastSearchParams() {
  return mocks.get.mock.lastCall?.[1].searchParams;
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWith(pageOf([phoneChange]));
});

describe('Histórico da pessoa: seção Vínculos', () => {
  it('o Histórico mostra a seção Vínculos acima das alterações', async () => {
    renderDialog();
    const section = screen.getByTestId('person-assignments');
    const table = await screen.findByRole('table');
    expect(section.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Histórico da pessoa: lista', () => {
  it('mostra motivo e o antes e depois por extenso, sem a coluna Pessoa e sem enum cru', async () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'Histórico de Maria Souza' })).toBeInTheDocument();
    const row = within(await screen.findByRole('row', { name: /Ana Admin/ }));
    expect(row.getByText('Troca de número')).toBeInTheDocument();
    expect(row.getByText('Telefone: •••• 1234 → •••• 5678')).toBeInTheDocument();
    expect(row.getByText('Autorização de contato: Sem autorização → Autorizado')).toBeInTheDocument();
    expect(screen.queryByText(/NAO_AUTORIZADO/)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Pessoa' })).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('audit-trail/people/u2', { searchParams: { page: 1, pageSize: 20 } });
  });

  it('pessoa sem alterações mostra o aviso', async () => {
    respondWith(pageOf([]));
    renderDialog();
    expect(await screen.findByText('Nenhuma alteração registrada para esta pessoa.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('fechado, não consulta a API', () => {
    renderDialog({ open: false });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('Histórico da pessoa: páginas', () => {
  it('Próxima pede a página 2 e Anterior volta à 1', async () => {
    mocks.get.mockImplementation((_path: string, options: { searchParams: { page: number } }) => ({
      json: () => Promise.resolve(pageOf([phoneChange], { total: 45, page: options.searchParams.page })),
    }));
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByText('Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Página 2 de 3')).toBeInTheDocument();
    expect(lastSearchParams()).toEqual({ page: 2, pageSize: 20 });

    await user.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(await screen.findByText('Página 1 de 3')).toBeInTheDocument();
  });
});

describe('Histórico da pessoa: falhas e troca de pessoa', () => {
  const FORBIDDEN = 'Você não pode ver o histórico desta pessoa.';

  it.each([
    ['403 com o texto da API', 403, { code: 'audit_trail.forbidden', detail: FORBIDDEN }, FORBIDDEN],
    ['403 sem detalhe no corpo', 403, { code: 'audit_trail.forbidden' }, FORBIDDEN],
    ['falha de servidor', 500, { code: 'internal', detail: 'stack interno' }, 'Não foi possível carregar o histórico. Tente de novo.'],
  ])('%s mostra a mensagem em pt-BR no lugar da tabela', async (_name, status, body, text) => {
    failWith(status, body);
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText('stack interno')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('trocar de pessoa mostra o carregamento, nunca o histórico da anterior', async () => {
    const { rerender } = renderDialog();
    expect(await screen.findByText('Troca de número')).toBeInTheDocument();

    mocks.get.mockReturnValue({ json: () => new Promise(() => undefined) });
    rerender({ person: joao });
    expect(screen.getByRole('heading', { name: 'Histórico de João Lima' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Carregando histórico' })).toBeInTheDocument();
    expect(screen.queryByText('Troca de número')).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith('audit-trail/people/u3', { searchParams: { page: 1, pageSize: 20 } });
  });
});
