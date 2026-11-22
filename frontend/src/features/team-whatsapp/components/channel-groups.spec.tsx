import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

import { buildChannelGroups, type RosterSectorView } from '../channel-groups';
import type { TeamSectorChannel } from '../schemas';
import { ChannelGroups } from './channel-groups';

// 14:05 no relógio de quem abre a tela, seja qual for o fuso do teste.
const CHECKED_AT = new Date(2026, 10, 10, 14, 5).toISOString();

const channel = (
  id: string, phoneE164: string | null, state: TeamSectorChannel['live']['state'] = 'open',
): TeamSectorChannel => ({
  id, name: `Canal ${id}`, phoneE164, provider: 'GOZAP', live: { state, checkedAt: CHECKED_AT },
});
const sector = (sectorId: string, name: string, ch: TeamSectorChannel | null): RosterSectorView => ({ sectorId, name, channel: ch });

function renderGroups(sectors: RosterSectorView[], isAdmin = true, onRecheck = vi.fn()) {
  const counts = new Map([['log', 12], ['exp', 8]]);
  render(<ChannelGroups view={buildChannelGroups(sectors, counts)} isAdmin={isAdmin} onRecheck={onRecheck} />);
  return { onRecheck };
}

describe('ChannelGroups', () => {
  it('mostra setor, pessoas e número de cada grupo, com a hora da conferência', () => {
    renderGroups([
      sector('log', 'Logística', channel('1', '+5592991111111')),
      sector('exp', 'Expedição', channel('1', '+5592991111111')),
    ]);
    expect(screen.getByText('Logística, 12 pessoas; Expedição, 8 pessoas, pelo +5592991111111')).toBeInTheDocument();
    expect(screen.getByText('conferido às 14:05')).toBeInTheDocument();
  });

  it('sem telefone mostra o nome do canal no lugar do número', () => {
    renderGroups([sector('log', 'Logística', channel('9', null))]);
    expect(screen.getByText('Logística, 12 pessoas, pelo Canal 9')).toBeInTheDocument();
  });

  it('área sem número: aviso com o nome e o link Conexões só para o ADMIN', () => {
    const sectors = [sector('log', 'Logística', channel('1', '+5592991111111')), sector('exp', 'Expedição', null)];
    const { unmount } = render(<ChannelGroups view={buildChannelGroups(sectors, new Map())} isAdmin onRecheck={vi.fn()} />);
    expect(screen.getByText('Áreas sem número: Expedição')).toBeInTheDocument();
    expect(screen.getByText(/Associe um número a esta área em/).closest('p')).toHaveTextContent('Associe um número a esta área em Conexões');
    expect(screen.getByRole('link', { name: 'Conexões' })).toHaveAttribute('href', '/connect');
    unmount();

    render(<ChannelGroups view={buildChannelGroups(sectors, new Map())} isAdmin={false} onRecheck={vi.fn()} />);
    expect(screen.getByText('Associe um número a esta área em Conexões')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('número desconectado: diz o número e as áreas', () => {
    renderGroups([
      sector('log', 'Logística', channel('1', '+5592991111111', 'close')),
      sector('exp', 'Expedição', channel('1', '+5592991111111', 'close')),
    ]);
    expect(screen.getByText('O número +5592991111111 está desconectado. Áreas: Logística, Expedição.')).toBeInTheDocument();
  });

  it('sem resposta do provedor: Conferir de novo refaz a consulta', async () => {
    const { onRecheck } = renderGroups([sector('log', 'Logística', channel('1', '+5592991111111', 'unknown'))]);
    expect(screen.getByText('Não foi possível conferir o número. Tente de novo')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Conferir de novo' }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('com tudo certo não mostra aviso nem botão', () => {
    renderGroups([sector('log', 'Logística', channel('1', '+5592991111111'))]);
    expect(screen.queryByText(/Áreas sem número/)).not.toBeInTheDocument();
    expect(screen.queryByText(/está desconectado/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
