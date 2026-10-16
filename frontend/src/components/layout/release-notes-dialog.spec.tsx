import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, onClick }: { children: React.ReactNode; to: string; onClick?: () => void }) => (
    // preventDefault: um <a href> real dispara navegação de verdade no jsdom
    // ("Not implemented: navigation to another Document") — o componente sob
    // teste só quer fechar o diálogo ao clicar em "Ver", não navegar.
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('@/release-notes', () => ({
  RELEASE_NOTES: [
    {
      version: '2026.09.01',
      date: '2026-09-01',
      title: 'Versão nova de teste',
      items: [
        { text: 'Item com link.', where: '/contacts' },
        { text: 'Item sem link.' },
        { text: 'Item da visão geral.', where: '/dashboard' },
      ],
    },
  ],
}));

import { useAuthStore } from '@/stores/auth.store';
import { ReleaseNotesDialog } from './release-notes-dialog';

function signInAs(role: 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER') {
  useAuthStore.setState({ user: { id: 'u1', email: 'u@orgamind.com', name: 'U', role } });
}

beforeEach(() => signInAs('ADMIN'));
afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('ReleaseNotesDialog', () => {
  it('não renderiza nada quando open é false', () => {
    render(<ReleaseNotesDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByText('Versão nova de teste')).not.toBeInTheDocument();
  });

  it('lista o título da versão, a data formatada em pt-BR e os itens', () => {
    render(<ReleaseNotesDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Versão nova de teste')).toBeInTheDocument();
    expect(screen.getByText('01/09/2026')).toBeInTheDocument();
    expect(screen.getByText('Item com link.')).toBeInTheDocument();
    expect(screen.getByText('Item sem link.')).toBeInTheDocument();
  });

  it('mostra "Ver" só nos itens que têm `where`, apontando para a rota', () => {
    render(<ReleaseNotesDialog open onOpenChange={() => {}} />);
    const links = screen.getAllByRole('link', { name: 'Ver' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/contacts', '/dashboard']);
  });

  it('esconde "Ver" de rota que o papel não acessa, mantendo o texto', () => {
    signInAs('VIEWER');
    render(<ReleaseNotesDialog open onOpenChange={() => {}} />);

    expect(screen.getByText(/Item com link\./)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Ver' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/dashboard');
  });

  it('clicar em "Ver" fecha o diálogo', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ReleaseNotesDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getAllByRole('link', { name: 'Ver' })[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('o botão "Fechar" chama onOpenChange(false)', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ReleaseNotesDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
