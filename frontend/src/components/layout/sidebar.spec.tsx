import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let currentPath = '/dashboard';

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => ({ location: { pathname: currentPath } }),
  Link: ({ children, to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock('@/lib/internal-unread', () => ({
  useInternalUnreadCount: () => ({ data: { count: 4 } }),
}));

// O contador de pendências (K2) tem spec próprio (sidebar.pendencies.spec.tsx); aqui o item fica escondido.
vi.mock('@/features/team-pendencies/api', () => ({
  usePendencyCount: () => ({ data: undefined }),
}));

import { useAuthStore } from '@/stores/auth.store';
import { Sidebar } from './sidebar';

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('Sidebar: itens por permissão', () => {
  const operator = { id: 'u1', email: 'bia@orgamind.com', name: 'Bia', role: 'OPERATOR' } as const;

  it('OPERATOR com estrutura.manter vê Turnos e Níveis; sem a chave (padrão do papel), não', () => {
    currentPath = '/dashboard';
    useAuthStore.setState({ user: { ...operator, permissions: ['estrutura.manter'] } });
    const { unmount } = render(<Sidebar collapsed={false} user={operator} />);
    expect(screen.getByRole('link', { name: 'Turnos' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Níveis' })).toBeInTheDocument();
    unmount();

    useAuthStore.setState({ user: operator });
    render(<Sidebar collapsed={false} user={operator} />);
    expect(screen.queryByRole('link', { name: 'Turnos' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Níveis' })).not.toBeInTheDocument();
  });
});

describe('Sidebar', () => {
  it('marca a rota atual para navegação assistiva', () => {
    currentPath = '/dashboard';
    render(<Sidebar collapsed={false} user={{ email: 'ana@orgamind.com', name: 'Ana', role: 'ADMIN' }} />);

    expect(screen.getByRole('link', { name: 'Visão geral' })).toHaveAttribute('aria-current', 'page');
    const inboxLink = screen.getByText('Caixa de entrada').closest('a') as HTMLAnchorElement;
    expect(inboxLink).not.toHaveAttribute('aria-current');
  });

  it('mantém texto navy legível nos acentos laranja pequenos', () => {
    currentPath = '/caixa-de-entrada';
    render(<Sidebar collapsed={false} user={{ email: 'ana@orgamind.com', name: 'Ana', role: 'ADMIN' }} />);

    expect(screen.getByText('AN')).toHaveStyle({ color: 'var(--brand-navy)' });
    expect(screen.getByText('4')).toHaveStyle({ color: 'var(--brand-navy)' });
  });

  it('preserva ADMIN, badge e fechamento do menu ao navegar', () => {
    currentPath = '/caixa-de-entrada';
    const onNavigate = vi.fn();
    render(
      <Sidebar
        collapsed={false}
        user={{ email: 'ana@orgamind.com', name: 'Ana', role: 'ADMIN' }}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('Administração')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Caixa de entrada/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Usuários' }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it('mostra operações e acompanhamento para quatro papéis, sem criação para VIEWER e sem administração fora de ADMIN', () => {
    currentPath = '/demandas/dm-1';
    for (const [role, canCreate] of [['ADMIN', true], ['SUPERVISOR', true], ['OPERATOR', true], ['VIEWER', false]] as const) {
      const { unmount } = render(<Sidebar collapsed={false} user={{ email: `${role}@orgamind.com`, name: role, role }} />);
      expect(screen.getByRole('link', { name: 'Demandas' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: 'Comunicados' })).not.toHaveAttribute('aria-current');
      expect(screen.queryByRole('link', { name: 'Nova comunicação' })).toBe(canCreate ? screen.getByRole('link', { name: 'Nova comunicação' }) : null);
      expect(screen.queryByRole('link', { name: 'Setores' })).toBe(role === 'VIEWER' ? null : screen.getByRole('link', { name: 'Setores' }));
      if (role === 'ADMIN') expect(screen.getByRole('link', { name: 'Usuários' })).toBeInTheDocument();
      else expect(screen.queryByRole('link', { name: 'Usuários' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('mantém títulos como tooltip quando a barra está recolhida', () => {
    currentPath = '/dashboard';
    render(<Sidebar collapsed user={{ email: 'ana@orgamind.com', name: 'Ana', role: 'ADMIN' }} />);

    expect(screen.getByRole('link', { name: 'Visão geral' })).toHaveAttribute('title', 'Visão geral');
    expect(screen.getByRole('link', { name: 'Visão geral' })).toHaveAttribute('aria-current', 'page');
  });
});
