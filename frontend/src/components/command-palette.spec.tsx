import { render, screen, cleanup } from '@testing-library/react';
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

afterEach(cleanup);

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
