import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AppShell } from './app-shell';

describe('AppShell — slot de rodapé', () => {
  it('expõe a navegação principal como um landmark nomeado', () => {
    render(
      <AppShell sidebar={<div>sidebar</div>} topbar={<div>topbar</div>}>
        <div>conteúdo</div>
      </AppShell>,
    );

    expect(screen.getByRole('complementary', { name: 'Navegação principal' })).toBeInTheDocument();
  });

  it('renderiza o conteúdo passado em `footer`', () => {
    render(
      <AppShell
        sidebar={<div>sidebar</div>}
        topbar={<div>topbar</div>}
        footer={<div>rodapé de teste</div>}
      >
        <div>conteúdo</div>
      </AppShell>,
    );
    expect(screen.getByText('rodapé de teste')).toBeInTheDocument();
  });

  it('funciona normalmente sem `footer` (prop opcional)', () => {
    render(
      <AppShell sidebar={<div>sidebar</div>} topbar={<div>topbar</div>}>
        <div>conteúdo</div>
      </AppShell>,
    );
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
  });

  it('usa 210px aberta e 64px recolhida na navegação desktop', () => {
    const { rerender } = render(
      <AppShell sidebar={<div>sidebar</div>} topbar={<div>topbar</div>}>
        <div>conteúdo</div>
      </AppShell>,
    );

    expect(screen.getByRole('complementary')).toHaveStyle({ '--sidebar-w': '210px' });

    rerender(
      <AppShell collapsed sidebar={<div>sidebar</div>} topbar={<div>topbar</div>}>
        <div>conteúdo</div>
      </AppShell>,
    );
    expect(screen.getByRole('complementary')).toHaveStyle({ '--sidebar-w': '64px' });
  });

  it('fecha o drawer móvel pelo overlay acessível', () => {
    const onMobileClose = vi.fn();
    render(
      <AppShell
        mobileOpen
        onMobileClose={onMobileClose}
        sidebar={<div>sidebar</div>}
        topbar={<div>topbar</div>}
      >
        <div>conteúdo</div>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fechar menu' }));
    expect(onMobileClose).toHaveBeenCalledOnce();
  });
});
