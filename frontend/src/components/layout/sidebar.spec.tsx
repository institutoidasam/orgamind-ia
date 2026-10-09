import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let currentPath = '/dashboard';

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => ({ location: { pathname: currentPath } }),
  Link: ({ children, to, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock('@/features/chat/api', () => ({
  useConversations: () => ({ data: { items: [{ unreadCount: 3 }] } }),
}));

import { Sidebar } from './sidebar';

afterEach(cleanup);

describe('Sidebar', () => {
  it('marca a rota atual para navegação assistiva', () => {
    currentPath = '/dashboard';
    render(<Sidebar collapsed={false} user={{ email: 'ana@orgamind.com', name: 'Ana' }} />);

    expect(screen.getByRole('link', { name: 'Início' })).toHaveAttribute('aria-current', 'page');
    const inboxLink = screen.getByText('Inbox').closest('a') as HTMLAnchorElement;
    expect(inboxLink).not.toHaveAttribute('aria-current');
  });

  it('mantém texto navy legível nos acentos laranja pequenos', () => {
    currentPath = '/inbox';
    render(<Sidebar collapsed={false} user={{ email: 'ana@orgamind.com', name: 'Ana' }} />);

    expect(screen.getByText('AN')).toHaveStyle({ color: 'var(--brand-navy)' });
    expect(screen.getByText('3')).toHaveStyle({ color: 'var(--brand-navy)' });
  });
});
