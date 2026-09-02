import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NAV } from '@/lib/nav';

// --- Router mock: drive the breadcrumb off a settable pathname --------------
let currentPath = '/dashboard';
vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => ({ location: { pathname: currentPath } }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ theme: 'light', toggle: vi.fn(), set: vi.fn() }),
}));

// Avoid pulling the whatsapp data layer into the topbar render.
vi.mock('./whatsapp-status-indicator', () => ({
  WhatsappStatusIndicator: () => null,
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
  ProviderScopeSelector: () => null,
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

  it('resolves a label for nested Inbox/Segmentos/Imports paths', () => {
    for (const [path, label] of [
      ['/inbox/conv-1', 'Inbox'],
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

describe('Topbar — controle de Novidades', () => {
  it('renderiza o controle de Novidades na barra superior', () => {
    currentPath = '/dashboard';
    render(<Topbar {...props} />);
    expect(screen.getByTestId('release-notes-button-stub')).toBeInTheDocument();
  });
});
