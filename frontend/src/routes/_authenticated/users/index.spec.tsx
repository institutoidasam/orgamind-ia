import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, deleteMutate, getState, invalidateQueries, resetMutate, statusMutate, toastError, toastSuccess, useShifts, useUsers } = vi.hoisted(() => ({
  authState: { user: { id: 'admin-1', role: 'ADMIN' } },
  deleteMutate: vi.fn(),
  getState: vi.fn(),
  invalidateQueries: vi.fn(),
  resetMutate: vi.fn(),
  statusMutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useShifts: vi.fn(() => ({ data: [] })),
  useUsers: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: (opts: Record<string, unknown>) => ({ __redirect: opts }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState },
  ),
}));

vi.mock('@/features/users/api', () => ({
  useUsers: (...args: unknown[]) => useUsers(...args),
  useDeleteUser: () => ({ mutateAsync: deleteMutate, isPending: false }),
  useResetUserPassword: () => ({ mutateAsync: resetMutate, isPending: false }),
  useSetUserStatus: () => ({ mutateAsync: statusMutate, isPending: false }),
}));

vi.mock('@/features/shifts/api', () => ({ useShifts: () => useShifts() }));

vi.mock('@/features/users/components/invite-user-dialog', () => ({
  InviteUserDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => open && <div role="dialog">Convite aberto<button onClick={() => onOpenChange(false)}>Fechar convite</button></div>,
}));
vi.mock('@/features/users/components/edit-user-dialog', async () => {
  const { useState } = await import('react');
  function EditUserDialogMock({ user, onOpenChange }: { user: { name: string | null }; onOpenChange: (open: boolean) => void }) {
    const [reason, setReason] = useState('');
    return <div role="dialog">Editar {user.name}<label>Motivo da alteração<input value={reason} onChange={(event) => setReason(event.target.value)} /></label><button onClick={() => onOpenChange(false)}>Cancelar edição</button></div>;
  }
  return { EditUserDialog: EditUserDialogMock };
});
vi.mock('@/features/audit-trail/components/person-history-dialog', () => ({
  PersonHistoryDialog: ({ person, onOpenChange }: { person: { id: string; name: string }; onOpenChange: (open: boolean) => void }) => <div role="dialog">Histórico de {person.name} ({person.id})<button onClick={() => onOpenChange(false)}>Fechar histórico</button></div>,
}));
vi.mock('@/features/users/components/grant-access-dialog', () => ({
  GrantAccessDialog: ({ user, onClose }: { user: { name: string | null } | null; onClose: () => void }) => user && <div role="dialog">Dar acesso a {user.name}<button onClick={onClose}>Fechar acesso</button></div>,
}));
vi.mock('@/features/users/components/temporary-password-modal', () => ({
  TemporaryPasswordModal: ({ password, onClose }: { password: string; onClose: () => void }) => <div role="dialog">Senha temporária: {password}<button onClick={onClose}>Fechar senha</button></div>,
}));
vi.mock('@/features/team-whatsapp/components/send-whatsapp-dialog', () => ({
  SendWhatsappDialog: ({ target }: { target: unknown }) => <div role="dialog">Diálogo {JSON.stringify(target)}</div>,
}));
vi.mock('@/lib/api-error', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-error')>()),
  extractApiError: vi.fn().mockResolvedValue({ title: 'Erro HTTP', message: 'Tente novamente.' }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { Route } from './index';

const UsersPage = (Route as unknown as { component: ComponentType }).component;

const AUTHORIZED = { status: 'AUTORIZADO' as const, source: 'TERMO_ASSINADO' as const, note: null, date: '2026-10-01', recordedAt: null };
const PRIOR = { ...AUTHORIZED, source: 'CADASTRO_ANTERIOR' as const, date: null };

const users = [
  { id: 'admin-1', email: 'admin@gbr.test', hasAccess: true, name: 'Ada', phoneE164: '+5592991234567', role: 'ADMIN' as const, sectorId: null, sector: null, isActive: true, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
  { id: 'supervisor-1', email: 'supervisor@gbr.test', hasAccess: true, name: 'Bia', phoneE164: null, role: 'SUPERVISOR' as const, sectorId: 's1', sector: { id: 's1', name: 'Engenharia', code: 'ENG', isActive: true }, isActive: true, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
  { id: 'operator-1', email: 'operator@gbr.test', hasAccess: true, name: 'Caio', phoneE164: null, role: 'OPERATOR' as const, sectorId: 's2', sector: { id: 's2', name: 'Produção', code: 'PROD', isActive: true }, isActive: false, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
  { id: 'viewer-1', email: 'viewer@gbr.test', hasAccess: true, name: 'Dora', phoneE164: null, role: 'VIEWER' as const, sectorId: 's3', sector: { id: 's3', name: 'Qualidade', code: 'QUAL', isActive: true }, isActive: true, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
].map((person) => ({ ...person, registration: null as string | null, contactAuthorization: AUTHORIZED }));

describe('UsersPage matrícula, selo e filtros', () => {
  const eva = { ...users[3], id: 'ant-1', name: 'Eva', email: 'eva@gbr.test', registration: 'M-100', contactAuthorization: PRIOR };

  beforeEach(() => listing([eva, users[3]], { unverified: 7, notAuthorized: 2 }));

  it('mostra matrícula e selo "Origem não verificada"', () => {
    render(<UsersPage />);
    const row = within(screen.getByRole('row', { name: /Eva/ }));
    expect(screen.getByRole('columnheader', { name: 'Matrícula' })).toBeInTheDocument();
    expect(row.getByText('M-100')).toBeInTheDocument();
    expect(row.getByText('Origem não verificada')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Dora/ })).queryByText(/Origem não verificada|Sem autorização/)).not.toBeInTheDocument();
  });

  it('busca envia q e "Mostrar inativos" envia status all', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    expect(lastFilters()).toEqual({ q: '', status: 'active' });

    await user.type(screen.getByRole('searchbox', { name: 'Buscar por nome ou matrícula' }), 'M-100');
    await waitFor(() => expect(lastFilters()).toEqual({ q: 'M-100', status: 'active' }));
    await user.click(screen.getByRole('checkbox', { name: 'Mostrar inativos' }));
    expect(lastFilters()).toEqual({ q: 'M-100', status: 'all' });
  });

  it('filtro "Sem autorização" envia authorization NOT_AUTHORIZED; contador mostra os números', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    expect(screen.getByRole('button', { name: 'Origem não verificada (7)' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Sem autorização (2)' }));
    expect(lastFilters()).toEqual({ q: '', status: 'active', authorization: 'NOT_AUTHORIZED' });
    expect(screen.getByRole('button', { name: 'Sem autorização (2)' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Sem autorização (2)' }));
    expect(lastFilters()).toEqual({ q: '', status: 'active' });
  });

  it('sem resultado avisa e mantém a busca na tela', () => {
    listing([]);
    render(<UsersPage />);
    expect(screen.getByText('Nenhuma pessoa encontrada.')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar por nome ou matrícula' })).toBeInTheDocument();
  });
});

describe('UsersPage inativar e reativar', () => {
  const rita = { ...users[3], id: 'sem-1', name: 'Rita', email: null, hasAccess: false };
  const leo = { ...users[2], id: 'sem-2', name: 'Leo', email: null, hasAccess: false };
  const dialog = () => within(screen.getByRole('dialog'));

  beforeEach(() => {
    statusMutate.mockReset();
    statusMutate.mockResolvedValue(undefined);
    resetCommonMocks();
    listing([users[3], rita, leo]);
  });

  it('Inativar pede motivo e chama PATCH com isActive false; linha inativa oferece Reativar', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Rita/);
    await user.click(screen.getByRole('menuitem', { name: 'Inativar' }));

    await user.click(dialog().getByRole('button', { name: 'Inativar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe o motivo');
    expect(statusMutate).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('Motivo da alteração'), 'Saiu da empresa');
    await user.click(dialog().getByRole('button', { name: 'Inativar' }));

    await waitFor(() => expect(statusMutate).toHaveBeenCalledWith({ id: 'sem-1', isActive: false, reason: 'Saiu da empresa' }));
    expect(toastSuccess).toHaveBeenCalledWith('Cadastro de Rita inativado.');
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['audit-trail'] });
    expect(within(screen.getByRole('row', { name: /Leo/ })).getByText('Inativo')).toBeInTheDocument();
    await openActions(user, /Leo/);
    expect(screen.getByRole('menuitem', { name: 'Reativar' })).toBeInTheDocument();
  });

  it('Inativar pessoa com login avisa que o acesso é encerrado antes de pedir o motivo', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Inativar' }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent('o acesso é encerrado');
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Inativar Dora?');
    expect(screen.getByLabelText('Motivo da alteração')).toBeInTheDocument();
  });
});

describe('UsersPage excluir cadastro', () => {
  beforeEach(() => {
    resetCommonMocks();
    listing(users);
  });

  it('Excluir cadastro recusado mostra a mensagem de histórico', async () => {
    deleteMutate.mockRejectedValue(new HTTPError(new Response(JSON.stringify({ code: 'user.has_history' }), { status: 409 }), new Request('https://x'), {} as never));
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Excluir cadastro' }));
    await user.click(screen.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro.'));
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('Excluir cadastro sem histórico invalida a trilha para o Histórico não mostrar dado velho', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Excluir cadastro' }));
    await user.click(screen.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['audit-trail'] }));
  });
});

describe('UsersPage política de papel', () => {
  const rita = { ...users[3], id: 'sem-1', name: 'Rita', email: null, hasAccess: false };

  beforeEach(() => listing([users[0], users[3], rita]));
  afterEach(() => { authState.user = { id: 'admin-1', role: 'ADMIN' }; });

  it('SUPERVISOR só inativa quem não tem login e mantém o Histórico', async () => {
    authState.user = { id: 'admin-1', role: 'SUPERVISOR' };
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Dora.*viewer@gbr\.test/i);
    expect(screen.queryByRole('menuitem', { name: 'Inativar' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Histórico' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await openActions(user, /Rita/);
    expect(screen.getByRole('menuitem', { name: 'Inativar' })).toBeInTheDocument();
  });

  it('ninguém inativa a si mesmo', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Ada.*admin@gbr\.test/i);
    expect(screen.getByRole('menuitem', { name: 'Inativar' })).toHaveAttribute('data-disabled');
  });
});

describe('UsersPage histórico e edição', () => {
  beforeEach(() => {
    resetCommonMocks();
    listing(users);
  });

  it('Histórico abre o diálogo da pessoa da linha', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Histórico' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Histórico de Dora (viewer-1)');
    await user.click(screen.getByRole('button', { name: 'Fechar histórico' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('fechar a edição invalida a trilha; reabrir não traz o motivo da vez anterior', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Editar' }));
    await user.type(screen.getByLabelText('Motivo da alteração'), 'Corrigi o telefone');
    await user.click(screen.getByRole('button', { name: 'Cancelar edição' }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['audit-trail'] });

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Editar' }));
    expect(screen.getByLabelText('Motivo da alteração')).toHaveValue('');
  });

  it('fechar a concessão de acesso também invalida a trilha', async () => {
    listing([{ ...users[3], id: 'sem-1', name: 'Rita', email: null, hasAccess: false }]);
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Rita/);
    await user.click(screen.getByRole('menuitem', { name: 'Dar acesso' }));
    await user.click(screen.getByRole('button', { name: 'Fechar acesso' }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['audit-trail'] });
  });
});

describe('UsersPage', () => {
  beforeEach(() => {
    deleteMutate.mockReset();
    deleteMutate.mockResolvedValue(undefined);
    getState.mockReturnValue(authState);
    resetMutate.mockReset();
    resetMutate.mockResolvedValue({ temporaryPassword: crypto.randomUUID() });
    toastError.mockReset();
    toastSuccess.mockReset();
    useUsers.mockReturnValue({
      data: { data: users, total: users.length }, isLoading: false, isError: false,
      error: null, refetch: vi.fn(),
    });
  });

  it('exibe os quatro papéis, o setor e o estado de acesso reais', () => {
    render(<UsersPage />);

    for (const role of ['Administrador', 'Supervisor', 'Operador', 'Leitura']) {
      expect(screen.getByText(role)).toBeInTheDocument();
    }
    expect(screen.getByText('Engenharia')).toBeInTheDocument();
    expect(screen.getByText('Produção')).toBeInTheDocument();
    expect(screen.getByText('Qualidade')).toBeInTheDocument();
    expect(screen.getAllByText('Ativo')).toHaveLength(3);
    expect(screen.getByText('Inativo')).toBeInTheDocument();
  });

  it('abre permissões derivadas do papel da pessoa selecionada', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    const row = screen.getByRole('row', { name: /Dora.*viewer@gbr\.test/i });

    await user.click(within(row).getByRole('button', { name: 'Ações' }));
    await user.click(screen.getByRole('menuitem', { name: 'Ver permissões' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Permissões de Dora');
    expect(screen.getByRole('dialog')).toHaveTextContent('Consulta comunicações autorizadas');
    expect(screen.getByRole('dialog')).toHaveTextContent('Qualidade');
  });

  it('abre e fecha convite e edição para uma pessoa selecionada', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);

    await user.click(screen.getByRole('button', { name: 'Cadastrar usuário' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Convite aberto');
    await user.click(screen.getByRole('button', { name: 'Fechar convite' }));
    expect(screen.queryByText('Convite aberto')).not.toBeInTheDocument();

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Editar' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Editar Dora');
    await user.click(screen.getByRole('button', { name: 'Cancelar edição' }));
    expect(screen.queryByText('Editar Dora')).not.toBeInTheDocument();
  });

  it('protege as ações próprias e executa reset e exclusão de terceiros', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);

    await openActions(user, /Ada.*admin@gbr\.test/i);
    expect(screen.getByRole('menuitem', { name: 'Resetar senha' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Excluir cadastro' })).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Resetar senha' }));
    await user.click(screen.getByRole('button', { name: 'Resetar' }));
    await waitFor(() => expect(resetMutate).toHaveBeenCalledWith('viewer-1'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Senha temporária:');
    await user.click(screen.getByRole('button', { name: 'Fechar senha' }));

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Excluir cadastro' }));
    await user.click(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('viewer-1'));
    expect(toastSuccess).toHaveBeenCalledWith('Cadastro de viewer@gbr.test excluído.');
  });

  it('mantém a lista disponível e informa o erro HTTP de exclusão', async () => {
    deleteMutate.mockRejectedValue(new Error('falha remota'));
    const user = userEvent.setup();
    render(<UsersPage />);

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Excluir cadastro' }));
    await user.click(screen.getByRole('button', { name: 'Excluir' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Erro HTTP', { description: 'Tente novamente.' }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('UsersPage pessoa sem acesso', () => {
  const noAccess = { ...users[1], id: 'sem-1', name: 'Rita', email: null, hasAccess: false, role: 'VIEWER' as const, sector: null, sectorId: null };

  beforeEach(() => {
    getState.mockReturnValue(authState);
    useUsers.mockReturnValue({
      data: { data: [users[0], users[3], noAccess], total: 3 }, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
  });

  it('Email —, Perfil —, Acesso "Sem acesso", sem Resetar senha e com Dar acesso', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    const cells = within(screen.getByRole('row', { name: /Rita/ })).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('—');
    expect(cells[7]).toHaveTextContent('—');
    expect(cells[8]).toHaveTextContent('Sem acesso');

    await openActions(user, /Rita/);
    expect(screen.queryByRole('menuitem', { name: /(Resetar|Redefinir) senha/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Ver permissões' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Dar acesso' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Dar acesso a Rita');
  });

  it('quem tem acesso mantém Resetar senha e não ganha Dar acesso', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Ada.*admin@gbr\.test/i);
    expect(screen.getByRole('menuitem', { name: 'Resetar senha' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Dar acesso' })).not.toBeInTheDocument();
  });

  it('users.no_access ao resetar (lista velha) mostra a mensagem em pt-BR', async () => {
    resetMutate.mockRejectedValue(new HTTPError(new Response(JSON.stringify({ code: 'users.no_access' }), { status: 422 }), new Request('https://x'), {} as never));
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Resetar senha' }));
    await user.click(screen.getByRole('button', { name: 'Resetar' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Esta pessoa não tem acesso ao sistema.'));
  });
});

describe('UsersPage coluna Telefone', () => {
  it('mostra o número formatado ou traço quando não há número', () => {
    getState.mockReturnValue(authState);
    useUsers.mockReturnValue({
      data: { data: users, total: users.length }, isLoading: false, isError: false,
      error: null, refetch: vi.fn(),
    });
    render(<UsersPage />);
    expect(screen.getByRole('columnheader', { name: 'Telefone' })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Ada/ })).getByText('(92) 99123-4567')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Bia/ })).getAllByRole('cell')[3]).toHaveTextContent('—');
  });
});

describe('UsersPage colunas Turno e Função', () => {
  const shiftList = [
    { id: 'sh1', name: 'Manhã', startTime: '06:00', endTime: '14:00', isActive: true, sortOrder: 0, crossesMidnight: false, inUse: [] },
    { id: 'sh2', name: 'Madrugada', startTime: '22:00', endTime: '06:00', isActive: false, sortOrder: 1, crossesMidnight: true, inUse: [] },
  ];
  const renderPage = () => {
    getState.mockReturnValue(authState);
    useShifts.mockReturnValue({ data: shiftList });
    useUsers.mockReturnValue({
      data: {
        data: [
          { ...users[0], shiftId: 'sh1', jobTitle: 'Operador de empilhadeira' },
          { ...users[1], shiftId: 'sh2', jobTitle: null },
          { ...users[2], shiftId: null, jobTitle: null },
        ],
        total: 3,
      },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    render(<UsersPage />);
  };
  const row = (name: RegExp) => within(screen.getByRole('row', { name }));

  it('Turno mostra o nome vindo de useShifts, inclusive de turno inativo, e "Sem turno"', () => {
    renderPage();
    expect(screen.getByRole('columnheader', { name: 'Turno' })).toBeInTheDocument();
    expect(row(/Ada/).getByText('Manhã')).toBeInTheDocument();
    expect(row(/Bia/).getByText('Madrugada')).toBeInTheDocument();
    expect(row(/Caio/).getByText('Sem turno')).toBeInTheDocument();
  });

  it('Função mostra o texto ou traço', () => {
    renderPage();
    expect(screen.getByRole('columnheader', { name: 'Função' })).toBeInTheDocument();
    expect(row(/Ada/).getByText('Operador de empilhadeira')).toBeInTheDocument();
    expect(row(/Bia/).getAllByRole('cell')[6]).toHaveTextContent('—');
  });
});

describe('UsersPage Enviar WhatsApp', () => {
  beforeEach(() => {
    getState.mockReturnValue(authState);
    useUsers.mockReturnValue({
      data: { data: users, total: users.length }, isLoading: false, isError: false,
      error: null, refetch: vi.fn(),
    });
  });

  it('desabilita com dica para quem não tem telefone ou está inativo', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);

    await openActions(user, /Bia.*supervisor@gbr\.test/i);
    const noPhone = screen.getByRole('menuitem', { name: 'Enviar WhatsApp' });
    expect(noPhone).toHaveAttribute('data-disabled');
    expect(noPhone).toHaveAttribute('title', 'Usuário sem telefone');
    await user.keyboard('{Escape}');

    await openActions(user, /Caio.*operator@gbr\.test/i);
    expect(screen.getByRole('menuitem', { name: 'Enviar WhatsApp' })).toHaveAttribute('data-disabled');
  });

  it('avisa que o usuário com telefone está inativo', async () => {
    const inactive = { ...users[0], id: 'inativo-1', email: 'off@gbr.test', name: 'Eva', isActive: false };
    useUsers.mockReturnValue({
      data: { data: [inactive], total: 1 }, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    });
    const user = userEvent.setup();
    render(<UsersPage />);
    await openActions(user, /Eva/);
    expect(screen.getByRole('menuitem', { name: 'Enviar WhatsApp' })).toHaveAttribute('title', 'Usuário inativo');
  });

  it('habilitado abre o diálogo com o usuário como destino', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);

    await openActions(user, /Ada.*admin@gbr\.test/i);
    const item = screen.getByRole('menuitem', { name: 'Enviar WhatsApp' });
    expect(item).not.toHaveAttribute('data-disabled');
    await user.click(item);
    expect(screen.getByRole('dialog')).toHaveTextContent('{"type":"user","userId":"admin-1","label":"Ada"}');
  });
});

describe('UsersPage botão Exportar', () => {
  const asUser = (permissions: string[]) => {
    authState.user = { id: 'admin-1', role: 'ADMIN', permissions } as typeof authState.user;
  };

  beforeEach(() => listing([users[0]]));
  afterEach(() => { authState.user = { id: 'admin-1', role: 'ADMIN' }; });

  it('Exportar aparece no cabeçalho para quem tem pessoas.exportar', () => {
    asUser(['pessoas.exportar']);
    render(<UsersPage />);
    const exportar = screen.getByRole('button', { name: 'Exportar' });
    expect(exportar.parentElement).toBe(screen.getByRole('button', { name: /Cadastrar usuário/ }).parentElement);
  });

  it('Exportar não aparece sem pessoas.exportar', () => {
    asUser([]);
    render(<UsersPage />);
    expect(screen.getByRole('button', { name: /Cadastrar usuário/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exportar' })).not.toBeInTheDocument();
  });
});

async function openActions(user: ReturnType<typeof userEvent.setup>, rowName: RegExp) {
  const row = screen.getByRole('row', { name: rowName });
  await user.click(within(row).getByRole('button', { name: 'Ações' }));
}

function listing(data: unknown[], authorizationCounts = { unverified: 0, notAuthorized: 0 }) {
  useUsers.mockReturnValue({
    data: { data, total: data.length, authorizationCounts }, isLoading: false, isError: false,
    error: null, refetch: vi.fn(),
  });
}

function lastFilters() {
  return useUsers.mock.lastCall?.[2] as Record<string, unknown>;
}

function resetCommonMocks() {
  for (const mock of [deleteMutate, invalidateQueries, toastError, toastSuccess]) mock.mockReset();
  deleteMutate.mockResolvedValue(undefined);
}
