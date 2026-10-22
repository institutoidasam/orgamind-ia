import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as string,
  people: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts, useParams: () => ({ sectorId: 's1' }) }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (s: { user: { role: string } }) => unknown) => select({ user: { role: mocks.role } }),
}));
vi.mock('@/features/sector-people/api', () => ({
  useSectorPeople: () => mocks.people(),
  useRemoveSectorPerson: () => ({ mutateAsync: mocks.remove, isPending: false }),
}));
vi.mock('@/features/sector-people/components/edit-person-dialog', () => ({ EditPersonDialog: () => null }));
vi.mock('@/features/sector-people/components/add-people-dialog', () => ({
  AddPeopleDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog">Adicionar pessoas (diálogo)</div> : null),
}));
vi.mock('@/features/internal-admin/api', () => ({
  useSector: () => ({ data: { id: 's1', name: 'Produção', isActive: true, description: null, numbers: [{ id: 'n1', name: 'Linha 1', phone: '+5592999990000' }] } }),
  useUpdateSector: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('@/features/internal-admin/components/sector-form', () => ({ SectorForm: () => <button>Salvar setor</button> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: mocks.toastError } }));

import { Route } from './$sectorId';

const route = Route as unknown as { component: ComponentType };

const ana = { id: 'u1', name: 'Ana', phoneE164: null, hasAccess: true, role: 'OPERATOR', level: { id: 'l1', name: 'Líder', isActive: true }, jobTitle: 'Conferente', shift: { id: 'sh1', name: 'Noite' }, editable: 'limited' };
const bia = { id: 'u2', name: 'Bia', phoneE164: '+5592988887777', hasAccess: false, role: null, level: null, jobTitle: null, shift: null, editable: 'full' };
const sector = { id: 's1', name: 'Produção', code: 'PRD', isActive: true, manager: { id: 'm1', name: 'Marta' } };

function loaded(people: unknown[]) {
  mocks.people.mockReturnValue({ data: { sector, people, options: { levels: [], shifts: [] } }, isError: false });
}

function forbidden() {
  const response = new Response(JSON.stringify({ code: 'sector_people.forbidden' }), { status: 403 });
  return new HTTPError(response, new Request('https://x'), {} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.remove.mockResolvedValue(undefined);
  loaded([ana, bia]);
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

  it('gestor: sem Editar setor e sem números; mostra Gestor e pessoas', () => {
    mocks.role = 'SUPERVISOR';
    render(<route.component />);
    expect(screen.getByText('Gestor: Marta')).toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adicionar pessoas' })).toBeInTheDocument();
    expect(screen.queryByText('Editar setor')).toBeNull();
    expect(screen.queryByText('Salvar setor')).toBeNull();
    expect(screen.queryByText(/Números vinculados/)).toBeNull();
  });

  it('ADMIN vê Editar setor e os números vinculados', () => {
    render(<route.component />);
    expect(screen.getByText('Editar setor')).toBeInTheDocument();
    expect(screen.getByText(/Números vinculados/)).toBeInTheDocument();
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
