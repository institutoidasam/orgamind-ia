import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params: { sectorId: string } }) => (
    <a href={to.replace('$sectorId', params.sectorId)}>{children}</a>
  ),
}));

import type { RosterMember } from '../schemas';
import { MemberSelection } from './member-selection';

const ana: RosterMember = {
  id: 'ana', name: 'Ana', email: null, phoneE164: '+5592991234567', isActive: true, jobTitle: null,
  fromOtherSector: false, situation: { kind: 'WORK', sectorId: 'ti', shiftId: 'noite', source: 'CYCLE' },
  level: { id: 'l1', name: 'Coordenador' },
};
const bia: RosterMember = { ...ana, id: 'bia', name: 'Bia', level: null };
const group = (sectorId: string, name: string, visible: RosterMember[], empty = false) => ({
  sectorId, name, empty, visible, off: [], noSchedule: 0,
});

function setup(groups: ReturnType<typeof group>[]) {
  render(
    <MemberSelection
      choice="noite" groups={groups} includeOff={false} shiftNames={new Map()} selected={new Set()}
      onToggle={vi.fn()} onToggleOff={vi.fn()} onToggleAll={vi.fn()} onSendAll={vi.fn()} onSendSelected={vi.fn()}
    />,
  );
}

describe('MemberSelection', () => {
  it('agrupa por setor com o nível ao lado do nome ("Ana · Coordenador"); sem nível mostra só o nome', () => {
    setup([group('ti', 'TI', [ana]), group('op', 'Operação', [bia])]);
    const ti = within(screen.getByRole('list', { name: 'Escalados · TI' }));
    expect(ti.getByText('Ana · Coordenador')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Operação' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Escalados · Operação' })).getByText('Bia')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para todos (2)' })).toBeEnabled();
  });

  it('setor vazio mostra "Ninguém neste setor ainda." com link para /setores/<id>', () => {
    setup([group('ti', 'TI', [ana]), group('op', 'Operação', [], true)]);
    expect(screen.getByText('Ninguém neste setor ainda.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Adicionar pessoas' })).toHaveAttribute('href', '/setores/op');
  });

  it('um setor só: sem título de setor e com a lista "Escalados" de sempre', () => {
    setup([group('ti', 'TI', [ana])]);
    expect(screen.queryByRole('heading', { name: 'TI' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Escalados' })).toBeInTheDocument();
  });
});
