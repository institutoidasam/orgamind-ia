import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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
});
