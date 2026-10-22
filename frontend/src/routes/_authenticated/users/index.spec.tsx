import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, deleteMutate, getState, resetMutate, toastError, toastSuccess, useShifts, useUsers } = vi.hoisted(() => ({
  authState: { user: { id: 'admin-1', role: 'ADMIN' } },
  deleteMutate: vi.fn(),
  getState: vi.fn(),
  resetMutate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  useShifts: vi.fn(() => ({ data: [] })),
  useUsers: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  redirect: (opts: Record<string, unknown>) => ({ __redirect: opts }),
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
}));

vi.mock('@/features/shifts/api', () => ({ useShifts: () => useShifts() }));

vi.mock('@/features/users/components/invite-user-dialog', () => ({
  InviteUserDialog: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => open && <div role="dialog">Convite aberto<button onClick={() => onOpenChange(false)}>Fechar convite</button></div>,
}));
vi.mock('@/features/users/components/edit-user-dialog', () => ({
  EditUserDialog: ({ user, onOpenChange }: { user: { name: string | null }; onOpenChange: (open: boolean) => void }) => <div role="dialog">Editar {user.name}<button onClick={() => onOpenChange(false)}>Cancelar edição</button></div>,
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

const users = [
  { id: 'admin-1', email: 'admin@gbr.test', hasAccess: true, name: 'Ada', phoneE164: '+5592991234567', role: 'ADMIN' as const, sectorId: null, sector: null, isActive: true, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
  { id: 'supervisor-1', email: 'supervisor@gbr.test', hasAccess: true, name: 'Bia', phoneE164: null, role: 'SUPERVISOR' as const, sectorId: 's1', sector: { id: 's1', name: 'Engenharia', code: 'ENG', isActive: true }, isActive: true, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
  { id: 'operator-1', email: 'operator@gbr.test', hasAccess: true, name: 'Caio', phoneE164: null, role: 'OPERATOR' as const, sectorId: 's2', sector: { id: 's2', name: 'Produção', code: 'PROD', isActive: true }, isActive: false, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
  { id: 'viewer-1', email: 'viewer@gbr.test', hasAccess: true, name: 'Dora', phoneE164: null, role: 'VIEWER' as const, sectorId: 's3', sector: { id: 's3', name: 'Qualidade', code: 'QUAL', isActive: true }, isActive: true, lastLoginAt: null, createdAt: '2026-10-10', createdBy: null },
];

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

  it('protege as ações próprias e executa reset e remoção de terceiros', async () => {
    const user = userEvent.setup();
    render(<UsersPage />);

    await openActions(user, /Ada.*admin@gbr\.test/i);
    expect(screen.getByRole('menuitem', { name: 'Resetar senha' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Remover usuário' })).toHaveAttribute('data-disabled');
    await user.keyboard('{Escape}');

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Resetar senha' }));
    await user.click(screen.getByRole('button', { name: 'Resetar' }));
    await waitFor(() => expect(resetMutate).toHaveBeenCalledWith('viewer-1'));
    expect(screen.getByRole('dialog')).toHaveTextContent('Senha temporária:');
    await user.click(screen.getByRole('button', { name: 'Fechar senha' }));

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Remover usuário' }));
    await user.click(screen.getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('viewer-1'));
    expect(toastSuccess).toHaveBeenCalledWith('Usuário viewer@gbr.test removido.');
  });

  it('mantém a lista disponível e informa o erro HTTP de remoção', async () => {
    deleteMutate.mockRejectedValue(new Error('falha remota'));
    const user = userEvent.setup();
    render(<UsersPage />);

    await openActions(user, /Dora.*viewer@gbr\.test/i);
    await user.click(screen.getByRole('menuitem', { name: 'Remover usuário' }));
    await user.click(screen.getByRole('button', { name: 'Remover' }));

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
    expect(cells[1]).toHaveTextContent('—');
    expect(cells[6]).toHaveTextContent('—');
    expect(cells[7]).toHaveTextContent('Sem acesso');

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
    expect(within(screen.getByRole('row', { name: /Bia/ })).getAllByRole('cell')[2]).toHaveTextContent('—');
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
    expect(row(/Bia/).getAllByRole('cell')[5]).toHaveTextContent('—');
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

async function openActions(user: ReturnType<typeof userEvent.setup>, rowName: RegExp) {
  const row = screen.getByRole('row', { name: rowName });
  await user.click(within(row).getByRole('button', { name: 'Ações' }));
}
