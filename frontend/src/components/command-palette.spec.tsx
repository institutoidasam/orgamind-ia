import { useState } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NAV } from '@/lib/nav';

const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: navigateSpy }),
}));

vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ toggle: vi.fn() }),
}));

vi.mock('@/lib/api-client', () => ({
  logoutRemote: vi.fn(),
}));

let activeRole = 'ADMIN';
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (select: (state: { user: { role: string } }) => unknown) => select({ user: { role: activeRole } }),
}));

import { CommandPalette } from './command-palette';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  activeRole = 'ADMIN';
});

function PaletteHarness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir paleta
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('CommandPalette navigation entries', () => {
  it('renders an "Ir para" command for every manifest route', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    for (const item of NAV) {
      expect(screen.getByText(`Ir para ${item.label}`)).toBeInTheDocument();
    }
  });

  it('só oferece ações legadas para ADMIN e OPERATOR', () => {
    activeRole = 'SUPERVISOR';
    const { rerender } = render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.queryByText('Ir para Campanhas')).not.toBeInTheDocument();
    expect(screen.getByText('Ir para Demandas')).toBeInTheDocument();

    activeRole = 'VIEWER';
    rerender(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.queryByText('Ir para Nova comunicação')).not.toBeInTheDocument();
    expect(screen.getByText('Ir para Comunicados')).toBeInTheDocument();
  });

  it('includes the Caixa de entrada/Demandas entries', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText('Ir para Caixa de entrada')).toBeInTheDocument();
    expect(screen.getByText('Ir para Demandas')).toBeInTheDocument();
  });

  it('does not list a Broadcasts entry (absorbed into Campanhas)', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.queryByText('Ir para Broadcasts')).not.toBeInTheDocument();
  });

  it('keeps the system actions and routes to the real new communication flow', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText('Ir para Nova comunicação')).toBeInTheDocument();
    expect(screen.getByText('Mudar tema')).toBeInTheDocument();
    expect(screen.getByText('Sair')).toBeInTheDocument();
  });
});

describe('CommandPalette keyboard behavior', () => {
  it('abre pelo atalho e move o foco para a busca', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);

    await user.keyboard('{Control>}k{/Control}');

    expect(screen.getByRole('dialog', { name: 'Paleta de comandos' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Buscar ou executar...')).toHaveFocus();
  });

  it('filtra comandos pela busca', async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={() => {}} />);

    await user.type(screen.getByPlaceholderText('Buscar ou executar...'), 'demanda');

    expect(screen.getByText('Ir para Demandas')).toBeInTheDocument();
    expect(screen.queryByText('Ir para Nova comunicação')).not.toBeInTheDocument();
  });

  it('fecha com Escape e devolve o foco ao elemento que abriu a paleta', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);
    const trigger = screen.getByRole('button', { name: 'Abrir paleta' });

    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('mantém o foco dentro da paleta ao pressionar Tab', async () => {
    const user = userEvent.setup();
    render(<PaletteHarness />);

    await user.click(screen.getByRole('button', { name: 'Abrir paleta' }));
    await user.tab();

    expect(screen.getByPlaceholderText('Buscar ou executar...')).toHaveFocus();
  });

});

describe('CommandPalette command selection', () => {
  it('executa o comando ativo pela seleção com setas', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(navigateSpy).toHaveBeenCalledWith({ to: NAV[1].to });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
