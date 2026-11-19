import { cleanup, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params: { sectorId: string } }) => (
    <a href={to.replace('$sectorId', params.sectorId)}>{children}</a>
  ),
}));

import type { RosterMember } from '../schemas';
import { MemberSelection } from './member-selection';

const ana: RosterMember = {
  id: 'ana', name: 'Ana', email: null, phoneE164: '+5592991234567', hasPhone: true, phoneMasked: '•••• 4567',
  isActive: true, jobTitle: null,
  fromOtherSector: false, situation: { kind: 'WORK', sectorId: 'ti', shiftId: 'noite', source: 'CYCLE' },
  level: { id: 'l1', name: 'Coordenador' },
};
const bia: RosterMember = { ...ana, id: 'bia', name: 'Bia', level: null };
const group = (sectorId: string, name: string, visible: RosterMember[], empty = false) => ({
  sectorId, name, empty, visible, off: [], noSchedule: 0,
});

function setup(groups: ReturnType<typeof group>[], shiftIds: string[] = ['noite'], selected: string[] = []) {
  render(
    <MemberSelection
      shiftIds={shiftIds} groups={groups} includeOff={false} shiftNames={new Map()} selected={new Set(selected)}
      onToggle={vi.fn()} onToggleOff={vi.fn()} onToggleAll={vi.fn()} onSendAll={vi.fn()} onSendSelected={vi.fn()}
    />,
  );
}

describe('MemberSelection: telefone (DB8)', () => {
  const dora: RosterMember = { ...ana, id: 'dora', name: 'Dora', level: null, phoneE164: null, phoneMasked: '•••• 7777' };

  it('membro sem phoneE164 mas com hasPhone não cai em Sem telefone e mostra •••• 7777', () => {
    setup([group('ti', 'TI', [dora])]);
    expect(screen.queryByRole('list', { name: 'Sem telefone' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Escalados' })).getByText('•••• 7777')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para todos (1)' })).toBeEnabled();
  });

  it('membro sem telefone cai em Sem telefone', () => {
    const eva: RosterMember = { ...dora, id: 'eva', name: 'Eva', hasPhone: false, phoneMasked: null };
    setup([group('ti', 'TI', [eva])]);
    expect(within(screen.getByRole('list', { name: 'Sem telefone' })).getByText('Eva')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para todos (0)' })).toBeDisabled();
  });

  it('com a chave mostra o telefone formatado', () => {
    setup([group('ti', 'TI', [ana])]);
    expect(screen.getByText('(92) 99123-4567')).toBeInTheDocument();
  });
});

const bloqueado: RosterMember = { ...ana, id: 'caio', name: 'Caio', level: null, contactAuthorization: 'NAO_AUTORIZADO' };
const antigo = (id: string, name: string): RosterMember => ({
  ...ana, id, name, level: null, contactAuthorization: 'AUTORIZADO', authorizationUnverified: true,
});

describe('MemberSelection: contato não autorizado', () => {
  it('quem tem telefone e está NAO_AUTORIZADO aparece pelo nome em "Contato não autorizado", sem caixa de seleção e fora de "Escalados"', () => {
    setup([group('ti', 'TI', [ana, bloqueado])]);
    const bloqueados = within(screen.getByRole('list', { name: 'Contato não autorizado' }));
    expect(bloqueados.getByText('Caio')).toBeInTheDocument();
    expect(bloqueados.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Escalados' })).queryByText('Caio')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Sem telefone' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para todos (1)' })).toBeEnabled();
  });
});

describe('MemberSelection: origem não verificada', () => {
  const line = (n: string) => `${n} com origem de autorização não verificada (cadastro anterior)`;

  it('com marcados, conta só os marcados; a linha não bloqueia o envio', () => {
    setup([group('ti', 'TI', [antigo('d1', 'Dani'), antigo('e1', 'Edu'), antigo('f1', 'Fabi'), ana])], ['noite'], ['d1', 'e1']);
    expect(screen.getByText(line('2 destinatários'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (2)' })).toBeEnabled();
  });

  it('sem ninguém de cadastro anterior, a linha não aparece', () => {
    setup([group('ti', 'TI', [ana, bia])], ['noite'], ['ana', 'bia']);
    expect(screen.queryByText(/origem de autorização não verificada/)).not.toBeInTheDocument();
  });
});

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

  it('incluir quem está de folga só aparece em Todos os turnos (sem turnos marcados)', () => {
    setup([group('ti', 'TI', [ana])], []);
    expect(screen.getByRole('checkbox', { name: 'incluir quem está de folga' })).toBeInTheDocument();
    cleanup();
    setup([group('ti', 'TI', [ana])], ['dia', 'noite']);
    expect(screen.queryByRole('checkbox', { name: 'incluir quem está de folga' })).not.toBeInTheDocument();
  });
});
