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

import { CommandPalette } from './command-palette';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

  it('includes the Inbox/Segmentos entries', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText('Ir para Inbox')).toBeInTheDocument();
    expect(screen.getByText('Ir para Segmentos')).toBeInTheDocument();
  });

  it('does not list a Broadcasts entry (absorbed into Campanhas)', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.queryByText('Ir para Broadcasts')).not.toBeInTheDocument();
  });

  it('keeps the create + system actions', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText('Nova campanha')).toBeInTheDocument();
    expect(screen.getByText('Importar planilha')).toBeInTheDocument();
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

    await user.type(screen.getByPlaceholderText('Buscar ou executar...'), 'planilha');

    expect(screen.getByText('Importar planilha')).toBeInTheDocument();
    expect(screen.queryByText('Nova campanha')).not.toBeInTheDocument();
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
