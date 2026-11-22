import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string,
  permissions: undefined as string[] | undefined,
  useSector: vi.fn(),
  people: vi.fn(),
  remove: vi.fn(),
  setStatus: vi.fn(),
  invalidate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useParams: () => ({ sectorId: 's1' }) }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (s: { user: { role: string } }) => unknown) => select({ user: { role: mocks.role, permissions: mocks.permissions } }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock('@/features/sector-people/api', () => ({
  useSectorPeople: (sectorId: string, opts: unknown) => mocks.people(sectorId, opts),
  useRemoveSectorPerson: () => ({ mutateAsync: mocks.remove, isPending: false }),
  useSetSectorPersonStatus: () => ({ mutateAsync: mocks.setStatus, isPending: false }),
}));
vi.mock('@/features/sector-people/components/edit-person-dialog', () => ({
  EditPersonDialog: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => <button onClick={() => onOpenChange(false)}>Fechar edição</button>,
}));
vi.mock('@/features/sector-people/components/add-people-dialog', () => ({
  AddPeopleDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? (
      <div role="dialog">
        Adicionar pessoas (diálogo)
        <button onClick={() => onOpenChange(false)}>Fechar adição</button>
      </div>
    ) : null,
}));
vi.mock('@/features/audit-trail/components/person-history-dialog', () => ({
  PersonHistoryDialog: ({ person, open }: { person: { id: string; name: string }; open: boolean }) =>
    open ? <div role="dialog">{`Histórico de ${person.name} (${person.id})`}</div> : null,
}));
vi.mock('@/features/internal-admin/api', () => ({
  useSector: (id: string | undefined) => {
    mocks.useSector(id);
    return { data: { id: 's1', name: 'Produção', code: 'PRD', isActive: true, description: null, manager: { id: 'm1', name: 'Marta', email: null }, channel: null } };
  },
  useUpdateSector: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('@/features/internal-admin/components/sector-form', () => ({ SectorForm: () => <button>Salvar setor</button> }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { Route } from './$sectorId';

const route = Route as unknown as { component: ComponentType };

const authorization = (status: string, source: string | null) => ({ status, source, note: null, date: source === 'TERMO_ASSINADO' ? '2026-10-01' : null, recordedAt: null });
const ana = { id: 'u1', name: 'Ana', phoneE164: null, hasAccess: true, role: 'OPERATOR', level: { id: 'l1', name: 'Líder', isActive: true }, jobTitle: 'Conferente', shift: { id: 'sh1', name: 'Noite' }, editable: 'limited', registration: 'M-100', isActive: true, contactAuthorization: authorization('AUTORIZADO', 'TERMO_ASSINADO') };
const bia = { id: 'u2', name: 'Bia', phoneE164: '+5592988887777', hasAccess: false, role: null, level: null, jobTitle: null, shift: null, editable: 'full', registration: null, isActive: true, contactAuthorization: authorization('AUTORIZADO', 'CADASTRO_ANTERIOR') };
const cris = { ...bia, id: 'u3', name: 'Cris', registration: 'M-300', contactAuthorization: authorization('NAO_AUTORIZADO', null) };
const dora = { ...bia, id: 'u4', name: 'Dora', registration: 'M-400', isActive: false, contactAuthorization: authorization('AUTORIZADO', 'TERMO_ASSINADO') };
const sector = { id: 's1', name: 'Produção', code: 'PRD', isActive: true, manager: { id: 'm1', name: 'Marta' }, channel: null };

function loaded(people: unknown[]) {
  mocks.people.mockReturnValue(result(people));
}

const result = (people: unknown[]) => ({ data: { sector, people, options: { levels: [], shifts: [] } }, isError: false });
const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
const buttonIn = (el: HTMLElement, name: string) => within(el).getByRole('button', { name });

function forbidden() {
  const response = new Response(JSON.stringify({ code: 'sector_people.forbidden' }), { status: 403 });
  return new HTTPError(response, new Request('https://x'), {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.permissions = undefined;
  mocks.remove.mockResolvedValue(undefined);
  mocks.setStatus.mockResolvedValue(undefined);
  loaded([ana, bia]);
});

describe('/setores/$sectorId: estrutura por estrutura.manter', () => {
  beforeEach(() => {
    mocks.role = 'SUPERVISOR';
    mocks.permissions = ['estrutura.manter', 'pessoas.editar'];
  });

  it('SUPERVISOR com a chave vê o painel do setor que gerencia, com o formulário', () => {
    render(<route.component />);
    expect(screen.getByText('Editar setor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar setor' })).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });

  it('em setor que não gerencia (pessoas 403) vê cabeçalho, edita o setor e vê o aviso no lugar da lista', () => {
    mocks.people.mockReturnValue({ data: undefined, isError: true, error: forbidden() });
    render(<route.component />);
    expect(screen.getByRole('heading', { name: 'Produção.' })).toBeInTheDocument();
    expect(screen.getByText('Gestor: Marta')).toBeInTheDocument();
    expect(screen.getByText('Editar setor')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Você não gerencia este setor.');
    expect(screen.queryByText(/Número:/)).toBeNull();
    expect(screen.queryByText('Pessoas (2)')).toBeNull();
  });

  it('sem a chave a página fica como hoje: sem painel, sem consultar o setor, 403 só com o aviso', () => {
    mocks.permissions = ['pessoas.editar'];
    const { unmount } = render(<route.component />);
    expect(screen.queryByText('Editar setor')).toBeNull();
    expect(screen.getByText('Gestor: Marta')).toBeInTheDocument();
    unmount();
    mocks.people.mockReturnValue({ data: undefined, isError: true, error: forbidden() });
    render(<route.component />);
    expect(screen.getByText('Você não gerencia este setor.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Produção.' })).toBeNull();
    expect(screen.queryByText('Editar setor')).toBeNull();
    expect(mocks.useSector).not.toHaveBeenCalledWith('s1');
  });
});

describe('/setores/$sectorId: adicionar pessoas só com pessoas.editar', () => {
  beforeEach(() => {
    mocks.role = 'SUPERVISOR';
    mocks.permissions = ['trilha.consultar'];
  });

  it.each([
    ['com pessoas', () => loaded([ana, bia])],
    ['vazio', () => loaded([])],
  ])('sem a chave não há "Adicionar pessoas" (setor %s)', (_label, load) => {
    load();
    render(<route.component />);
    expect(screen.queryByRole('button', { name: 'Adicionar pessoas' })).toBeNull();
    expect(screen.getByText(/Pessoas \(|Ninguém neste setor ainda\./)).toBeInTheDocument();
  });
});

describe('/setores/$sectorId: matrícula, selo, busca e filtros', () => {
  it('mostra matrícula e selo; contador conta origem não verificada e sem autorização', () => {
    loaded([ana, bia, cris]);
    render(<route.component />);
    expect(within(row('Ana')).getByText('M-100')).toBeInTheDocument();
    expect(within(row('Ana')).queryByText(/Origem não verificada|Sem autorização/)).toBeNull();
    expect(within(row('Bia')).getByText('Origem não verificada')).toBeInTheDocument();
    expect(within(row('Cris')).getByText('Sem autorização')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Origem não verificada (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sem autorização (1)' })).toBeInTheDocument();
  });

  it('busca local por matrícula filtra a lista', async () => {
    loaded([ana, bia, cris]);
    render(<route.component />);
    await userEvent.setup().type(screen.getByRole('searchbox', { name: 'Buscar por nome ou matrícula' }), 'm-300');
    expect(screen.getByText('Cris')).toBeInTheDocument();
    expect(screen.queryByText('Ana')).toBeNull();
    expect(screen.queryByText('Bia')).toBeNull();
  });

  it('filtro "Sem autorização" mostra só quem tem esse selo; clicar de novo limpa', async () => {
    loaded([ana, bia, cris]);
    render(<route.component />);
    const filter = screen.getByRole('button', { name: 'Sem autorização (1)' });
    await userEvent.setup().click(filter);
    expect(screen.getByText('Cris')).toBeInTheDocument();
    expect(screen.queryByText('Ana')).toBeNull();
    await userEvent.setup().click(filter);
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });

  it('Mostrar inativos recarrega com includeInactive', async () => {
    const active = result([ana, bia]);
    const all = result([ana, bia, dora]);
    mocks.people.mockImplementation((_id: string, opts: { includeInactive?: boolean }) => (opts?.includeInactive ? all : active));
    render(<route.component />);
    expect(mocks.people).toHaveBeenLastCalledWith('s1', { includeInactive: false });
    expect(screen.queryByText('Dora')).toBeNull();
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Mostrar inativos' }));
    expect(mocks.people).toHaveBeenLastCalledWith('s1', { includeInactive: true });
    expect(within(row('Dora')).getByText('Inativo')).toBeInTheDocument();
  });
});

describe('/setores/$sectorId: inativar, reativar e histórico', () => {
  it('SUPERVISOR vê Inativar em pessoa sem login e não vê em pessoa com login', () => {
    mocks.role = 'SUPERVISOR';
    render(<route.component />);
    expect(screen.getAllByRole('button', { name: 'Inativar' })).toHaveLength(1);
    expect(within(row('Bia')).getByRole('button', { name: 'Inativar' })).toBeInTheDocument();
    expect(within(row('Ana')).queryByRole('button', { name: 'Inativar' })).toBeNull();
  });

  it('OPERATOR não vê Inativar nem Histórico', () => {
    mocks.role = 'OPERATOR';
    loaded([ana, bia, dora]);
    render(<route.component />);
    for (const name of ['Inativar', 'Reativar', 'Histórico']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Editar' })).toHaveLength(3);
  });

  it.each([
    ['Inativar', ana, false, 'Cadastro de Ana inativado.'],
    ['Reativar', dora, true, 'Cadastro de Dora reativado.'],
  ])('ADMIN: %s pede o motivo, chama o POST e atualiza a trilha', async (verb, person, isActive, message) => {
    loaded([ana, dora]);
    render(<route.component />);
    const ui = userEvent.setup();
    await ui.click(buttonIn(row(person.name), verb));
    await ui.type(screen.getByLabelText('Motivo da alteração'), 'Pedido da gestão');
    await ui.click(buttonIn(screen.getByRole('dialog'), verb));
    await vi.waitFor(() => expect(mocks.setStatus).toHaveBeenCalledWith({ userId: person.id, isActive, reason: 'Pedido da gestão' }));
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['audit-trail'] });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(message);
  });

  it.each(['ADMIN', 'SUPERVISOR'])('%s abre o Histórico da pessoa', async (role) => {
    mocks.role = role;
    render(<route.component />);
    await userEvent.setup().click(buttonIn(row('Ana'), 'Histórico'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Histórico de Ana (u1)');
  });
});

describe('/setores/$sectorId: trilha atualizada depois da escrita', () => {
  it('tirar do setor invalida a trilha', async () => {
    render(<route.component />);
    await userEvent.setup().click(buttonIn(row('Bia'), 'Tirar do setor'));
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['audit-trail'] }));
  });

  it.each([
    ['edição', () => userEvent.setup().click(buttonIn(row('Ana'), 'Editar')), 'Fechar edição'],
    ['adição (mover)', () => userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar pessoas' })), 'Fechar adição'],
  ])('fechar o diálogo de %s invalida a trilha', async (_label, open, closeName) => {
    render(<route.component />);
    await open();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('button', { name: closeName }));
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['audit-trail'] });
  });
});

describe('/setores/$sectorId', () => {
  it('lista nome, nível, função, turno e "Sem acesso"/"Com acesso"', () => {
    render(<route.component />);
    const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
    for (const text of ['Ana', 'Líder', 'Conferente', 'Noite', 'Com acesso']) expect(within(row('Ana')).getByText(text)).toBeInTheDocument();
    for (const text of ['Bia', 'Sem nível', 'Sem turno', 'Sem acesso']) expect(within(row('Bia')).getByText(text)).toBeInTheDocument();
  });

  it('"Tirar do setor" só em quem não tem acesso e chama DELETE', async () => {
    render(<route.component />);
    expect(screen.getAllByRole('button', { name: 'Tirar do setor' })).toHaveLength(1);
    await userEvent.setup().click(within(screen.getByRole('row', { name: /Bia/ })).getByRole('button', { name: 'Tirar do setor' }));
    expect(mocks.remove).toHaveBeenCalledWith('u2');
  });

  it('erro ao tirar mostra a mensagem do código (422 sector_people.has_access)', async () => {
    const response = new Response(JSON.stringify({ code: 'sector_people.has_access' }), { status: 422 });
    mocks.remove.mockRejectedValue(new HTTPError(response, new Request('https://x'), {} as never));
    render(<route.component />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tirar do setor' }));
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Quem tem acesso muda de setor pelo cadastro em Usuários.'));
  });
});

describe('/setores/$sectorId', () => {
  it('setor vazio mostra "Ninguém neste setor ainda." e "Adicionar pessoas"', () => {
    loaded([]);
    render(<route.component />);
    expect(screen.getByText('Ninguém neste setor ainda.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adicionar pessoas' })).toBeInTheDocument();
  });

  it('gestor: sem Editar setor; mostra Gestor e pessoas', () => {
    mocks.role = 'SUPERVISOR';
    render(<route.component />);
    expect(screen.getByText('Gestor: Marta')).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adicionar pessoas' })).toBeInTheDocument();
    expect(screen.queryByText('Editar setor')).toBeNull();
    expect(screen.queryByText('Salvar setor')).toBeNull();
  });

  it('ADMIN vê Editar setor', () => {
    render(<route.component />);
    expect(screen.getByText('Editar setor')).toBeInTheDocument();
  });

  it('cabeçalho mostra "Sem número" sem número e o número quando há', () => {
    const { unmount } = render(<route.component />);
    expect(screen.getByText('Sem número')).toBeInTheDocument();
    unmount();
    mocks.people.mockReturnValue({ data: { sector: { ...sector, channel: { id: 'c1', name: 'Loja 1', phoneE164: '+5592911111111' } }, people: [ana], options: { levels: [], shifts: [] } }, isError: false });
    render(<route.component />);
    expect(screen.getByText('+5592911111111')).toBeInTheDocument();
    expect(screen.queryByText('Sem número')).toBeNull();
  });

  it('403 mostra "Você não gerencia este setor."', () => {
    mocks.people.mockReturnValue({ data: undefined, isError: true, error: forbidden() });
    render(<route.component />);
    expect(screen.getByText('Você não gerencia este setor.')).toBeInTheDocument();
  });
});

describe('/setores/$sectorId: adicionar pessoas', () => {
  it.each([
    ['com pessoas', () => loaded([ana, bia])],
    ['vazio', () => loaded([])],
  ])('"Adicionar pessoas" abre o diálogo (setor %s)', async (_label, load) => {
    load();
    render(<route.component />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Adicionar pessoas' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
