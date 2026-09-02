import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      ],
    },
  ],
}));

import { ReleaseNotesDialog } from './release-notes-dialog';

afterEach(cleanup);

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

  it('mostra "Ver" só no item que tem `where`, apontando para a rota', () => {
    render(<ReleaseNotesDialog open onOpenChange={() => {}} />);
    const links = screen.getAllByText('Ver');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/contacts');
  });

  it('clicar em "Ver" fecha o diálogo', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ReleaseNotesDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByText('Ver'));
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
