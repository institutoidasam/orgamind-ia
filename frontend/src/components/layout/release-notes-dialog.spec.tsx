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
        { text: 'Item de setores.', where: '/setores' },
      ],
    },
  ],
}));

import { useAuthStore } from '@/stores/auth.store';
import { ReleaseNotesDialog } from './release-notes-dialog';

type Role = 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER';

function signInAs(role: Role) {
  useAuthStore.setState({ user: { id: 'u1', email: 'u@orgamind.com', name: 'U', role } });
}

function verHrefs() {
  return screen.queryAllByRole('link', { name: /ver/i }).map((l) => l.getAttribute('href'));
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
    expect(verHrefs()).toEqual(['/contacts', '/dashboard', '/setores']);
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

describe('ReleaseNotesDialog — "Ver" por papel', () => {
  it.each([
    ['VIEWER', ['/dashboard']],
    ['OPERATOR', ['/contacts', '/dashboard']],
    ['ADMIN', ['/contacts', '/dashboard', '/setores']],
  ] as const)('%s vê "Ver" apenas das rotas que acessa', (role, hrefs) => {
    signInAs(role);
    render(<ReleaseNotesDialog open onOpenChange={() => {}} />);
    expect(verHrefs()).toEqual(hrefs);
    expect(screen.getByText(/Item com link\./)).toBeInTheDocument();
  });

  it('sem usuário logado nenhum "Ver" aparece, mas o texto continua', () => {
    useAuthStore.setState({ user: null });
    render(<ReleaseNotesDialog open onOpenChange={() => {}} />);
    expect(verHrefs()).toEqual([]);
    expect(screen.getByText(/Item com link\./)).toBeInTheDocument();
  });
});
