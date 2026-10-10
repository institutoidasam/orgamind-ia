import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getState, mutateAsync, navigate, search } = vi.hoisted(() => ({
  getState: vi.fn(),
  mutateAsync: vi.fn(),
  navigate: vi.fn(),
  search: { redirect: undefined as string | undefined },
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    ...opts,
    useSearch: () => search,
  }),
  redirect: (opts: Record<string, unknown>) => ({ __redirect: opts }),
  useNavigate: () => navigate,
}));

vi.mock('@/features/auth/api', () => ({
  useLogin: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: Object.assign(vi.fn(), { getState }),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { Route } from './login';

const LoginPage = (Route as unknown as { component: ComponentType }).component;

function createTestCredentials() {
  return { email: 'admin@gbr.test', password: crypto.randomUUID() };
}

describe('/login — acesso', () => {
  beforeEach(() => {
    getState.mockReturnValue({ accessToken: null, mustChangePassword: false });
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue(undefined);
    navigate.mockReset();
    search.redirect = undefined;
  });

  it('redireciona uma sessão existente para a visão geral', () => {
    getState.mockReturnValue({ accessToken: 'session-token', mustChangePassword: false });
    const route = Route as unknown as { beforeLoad: () => void };

    expect(() => route.beforeLoad()).toThrow({ __redirect: { to: '/dashboard' } });
  });

  it('mostra a identidade interna no desktop e no cartão móvel', () => {
    render(<LoginPage />);

    expect(screen.getAllByText('OrgaMind').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('GBR Componentes').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('heading', { name: 'Comunicação entre setores' })).toBeInTheDocument();
    expect(screen.getByText('Ambiente interno')).toBeInTheDocument();
  });

  it('submete as credenciais e descarta redirect externo', async () => {
    search.redirect = '//externo.example';
    const credentials = createTestCredentials();
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), credentials.email);
    await user.type(screen.getByLabelText('Senha'), credentials.password);
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(credentials));
    expect(navigate).toHaveBeenCalledWith({ to: '/dashboard' });
  });

  it('preserva a troca obrigatória de senha depois do login', async () => {
    getState.mockReturnValue({ accessToken: null, mustChangePassword: true });
    search.redirect = '/users';
    const credentials = createTestCredentials();
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), credentials.email);
    await user.type(screen.getByLabelText('Senha'), credentials.password);
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({
      to: '/change-password', search: { redirect: '/users' },
    }));
  });
});
