import userEvent from '@testing-library/user-event';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { forwardRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NAV } from '@/lib/nav';

// --- Router mock: drive the breadcrumb off a settable pathname --------------
let currentPath = '/dashboard';
const themeSet = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => ({ location: { pathname: currentPath } }),
  Link: forwardRef<HTMLAnchorElement, { children: React.ReactNode; to?: string }>(({ children, to }, ref) => <a ref={ref} href={to}>{children}</a>),
}));

vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ theme: 'light', toggle: vi.fn(), set: themeSet }),
}));

// Avoid pulling the whatsapp data layer into the topbar render.
vi.mock('./whatsapp-status-indicator', () => ({
  WhatsappStatusIndicator: () => <div data-testid="whatsapp-status-stub" />,
}));

// Avoid pulling the release-notes hook (localStorage + real RELEASE_NOTES)
// into the topbar render — its own behaviour is covered by
// release-notes-button.spec.tsx.
vi.mock('./release-notes-button', () => ({
  ReleaseNotesButton: () => <div data-testid="release-notes-button-stub" />,
}));

// Same — the provider scope selector needs TanStack Query + its context
// provider; that wiring is covered by provider-scope.spec.tsx instead.
vi.mock('@/features/whatsapp/provider-scope', () => ({
  ProviderScopeSelector: () => <div data-testid="provider-scope-stub" />,
}));

import { Topbar } from './topbar';

const noop = () => {};
const props = {
  collapsed: false,
  onToggleCollapsed: noop,
  onMobileOpen: noop,
  onCmdOpen: noop,
  onLogout: noop,
  user: { email: 'a@b.com', name: 'Ana', role: 'ADMIN' },
};

afterEach(cleanup);

describe('Topbar breadcrumb', () => {
  it('resolves a real label for every manifest route (never "—")', () => {
    for (const item of NAV) {
      currentPath = item.to;
      const { unmount } = render(<Topbar {...props} />);
      // The breadcrumb <strong> holds the page name.
      expect(screen.getByText(item.label)).toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows "Campanha" (singular) on a campaign detail page', () => {
    currentPath = '/campaigns/clabc123';
    render(<Topbar {...props} />);
    expect(screen.getByText('Campanha')).toBeInTheDocument();
  });

  it('identifica o workspace GBR e apresenta o papel do perfil em português', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} />);

    expect(screen.getByText('GBR')).toBeInTheDocument();
    expect(screen.getByText('Comunicação entre Setores')).toBeInTheDocument();
    expect(screen.getByLabelText('Menu do perfil: Ana (Administrador)')).toBeInTheDocument();
  });

  it('apresenta OPERATOR como Operador no perfil', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} user={{ email: 'op@b.com', name: 'Bia', role: 'OPERATOR' }} />);

    expect(screen.getByLabelText('Menu do perfil: Bia (Operador)')).toBeInTheDocument();
  });

  it('mostra setor e não consulta controles legados para VIEWER', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} user={{ email: 'viewer@b.com', name: 'Vera', role: 'VIEWER', sector: { id: 's1', name: 'Engenharia', code: 'ENG', isActive: true } }} />);

    expect(screen.getByLabelText('Menu do perfil: Vera (Leitura)')).toBeInTheDocument();
    expect(screen.queryByTestId('whatsapp-status-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('provider-scope-stub')).not.toBeInTheDocument();
  });

  it('mantém controles legados para ADMIN e OPERATOR', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} />);

    expect(screen.getByTestId('whatsapp-status-stub')).toBeInTheDocument();
    expect(screen.getByTestId('provider-scope-stub')).toBeInTheDocument();
  });

  it('resolves a label for nested Inbox externo/Segmentos/Imports paths', () => {
    for (const [path, label] of [
      ['/inbox/conv-1', 'Inbox externo'],
      ['/segments/seg-1', 'Segmentos'],
      ['/imports/new', 'Imports'],
    ] as const) {
      currentPath = path;
      const { unmount } = render(<Topbar {...props} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('Topbar theme toggle', () => {
  it('renders the light/dark segmented control with the active theme pressed', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} />);
    const light = screen.getByLabelText('Tema claro');
    const dark = screen.getByLabelText('Tema escuro');
    // useTheme mock returns theme: 'light'.
    expect(light).toHaveAttribute('aria-pressed', 'true');
    expect(dark).toHaveAttribute('aria-pressed', 'false');
  });

  it('exposes both theme buttons as clickable controls', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} />);
    expect(screen.getByLabelText('Tema claro')).toHaveAttribute('type', 'button');
    expect(screen.getByLabelText('Tema escuro')).toHaveAttribute('type', 'button');
  });
});

describe('Topbar profile menu', () => {
  it('opens with click and exposes password and logout actions', async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    render(<Topbar {...props} onLogout={onLogout} />);

    await user.click(screen.getByRole('button', { name: 'Menu do perfil: Ana (Administrador)' }));

    expect(screen.getByRole('link', { name: 'Trocar senha' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Sair' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('opens from the keyboard and toggles the mobile theme action', async () => {
    const user = userEvent.setup();
    themeSet.mockClear();
    render(<Topbar {...props} />);

    const trigger = screen.getByRole('button', { name: 'Menu do perfil: Ana (Administrador)' });
    trigger.focus();
    await user.keyboard('{Enter}');

    const themeItem = screen.getByRole('menuitem', { name: 'Tema escuro' });
    expect(themeItem).toBeInTheDocument();
    await user.click(themeItem);
    expect(themeSet).toHaveBeenCalledWith('dark');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('renders the change password link in the opened menu', async () => {
    const user = userEvent.setup();
    render(<Topbar {...props} />);

    await user.click(screen.getByRole('button', { name: 'Menu do perfil: Ana (Administrador)' }));
    expect(screen.getByRole('link', { name: 'Trocar senha' })).toHaveAttribute('href', '/change-password');
  });
});

describe('Topbar — controle de Novidades', () => {
  it('renderiza o controle de Novidades na barra superior', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} />);
    expect(screen.getByTestId('release-notes-button-stub')).toBeInTheDocument();
  });
});
