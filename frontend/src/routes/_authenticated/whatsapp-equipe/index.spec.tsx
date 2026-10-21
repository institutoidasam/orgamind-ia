import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useTeamTargets, useTeamDispatches } = vi.hoisted(() => ({
  useTeamTargets: vi.fn(),
  useTeamDispatches: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
}));
vi.mock('@/features/team-whatsapp/api', () => ({
  useTeamTargets: () => useTeamTargets(),
  useTeamDispatches: () => useTeamDispatches(),
}));
vi.mock('@/features/team-whatsapp/components/send-whatsapp-dialog', () => ({
  SendWhatsappDialog: ({ target }: { target: unknown }) => (
    <div role="dialog">Diálogo {JSON.stringify(target)}</div>
  ),
}));

import type { DispatchRecipient } from '@/features/team-whatsapp/schemas';
import { Route } from './index';

const Page = (Route as unknown as { component: ComponentType }).component;

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

type User = ReturnType<typeof userEvent.setup>;

async function pick(user: User, trigger: 'Setor' | 'Turno', option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(screen.getByRole('option', { name: option }));
}

async function openProducao(turno: string) {
  const user = userEvent.setup();
  render(<Page />);
  await pick(user, 'Setor', 'Produção');
  await pick(user, 'Turno', turno);
  return user;
}

const checkboxNames = () => screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
const dialogTarget = () => JSON.parse((screen.getByRole('dialog').textContent ?? '').replace('Diálogo ', ''));
const NEEDS_CHOICE = 'Escolha o setor e o turno';

const member = (id: string, name: string, shift: 'FIRST' | 'SECOND' | null, phone: string | null) => ({
  id, name, email: `${id}@x.test`, phoneE164: phone, isActive: true, shift,
});
const members = [
  member('ana', 'Ana', 'FIRST', '+5592991234567'),
  member('joao', 'João', 'SECOND', '+5592988887777'),
  { ...member('lia', 'Lia', 'SECOND', '+5592977776666'), isActive: false },
  member('maria', 'Maria', 'SECOND', '+5592966665555'),
  member('pedro', 'Pedro', 'SECOND', null),
  member('ze', 'Zé', null, '+5592955554444'),
];
const producao = { id: 's1', name: 'Produção', code: 'PROD', members };
const expedicao = { id: 's2', name: 'Expedição', code: 'EXP', members: [] };
const targets = { channels: [], sectors: [producao, expedicao] };
const dispatches = {
  items: [
    {
      id: 'd1', createdAt: '2026-10-16T12:00:00.000Z',
      author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
      target: { type: 'sector' as const, id: 's1', label: 'Compras', shift: null },
      channel: { id: 'ch1', name: 'GoZap Principal' },
      counts: { queued: 1, sent: 2, failed: 3, skipped: 4 },
      recipients: [],
    },
    {
      id: 'd2', createdAt: '2026-10-15T12:00:00.000Z',
      author: null,
      target: { type: 'user' as const, id: 'u1', label: 'Ana', shift: null },
      channel: null,
      counts: { queued: 0, sent: 1, failed: 0, skipped: 0 },
      recipients: [],
    },
  ],
};

function http403() {
  return new HTTPError(new Response('{}', { status: 403 }), new Request('https://x'), {} as never);
}

beforeEach(() => {
  useTeamTargets.mockReturnValue({ data: targets, isLoading: false, isError: false });
  useTeamDispatches.mockReturnValue({ data: dispatches, isLoading: false, isError: false });
});

describe('WhatsApp da equipe: acesso', () => {
  it('mostra o estado vazio quando a API recusa com 403', () => {
    useTeamTargets.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: http403() });
    render(<Page />);
    expect(screen.getByText('Só o administrador e o gestor do setor enviam mensagens para a equipe.')).toBeInTheDocument();
    expect(screen.queryByText('Envios recentes')).not.toBeInTheDocument();
  });

  it('mostra esqueleto enquanto carrega', () => {
    useTeamTargets.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<Page />);
    expect(screen.getByText('WhatsApp da equipe')).toBeInTheDocument();
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });

  it('sem setor ativo, quem pode enviar vê o aviso no lugar dos seletores', () => {
    useTeamTargets.mockReturnValue({ data: { channels: [], sectors: [] }, isLoading: false, isError: false });
    render(<Page />);
    expect(screen.getByText('Nenhum setor ativo para envio. Cadastre setores em Setores.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Setor' })).not.toBeInTheDocument();
    expect(screen.getByText('Envios recentes')).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: seletores', () => {
  it('pede setor e turno até escolher os dois', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pick(user, 'Turno', '2º turno');
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pick(user, 'Setor', 'Produção');
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });

  it('pré-seleciona o setor quando há um só e pede só o turno', async () => {
    useTeamTargets.mockReturnValue({ data: { ...targets, sectors: [producao] }, isLoading: false, isError: false });
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByRole('combobox', { name: 'Setor' })).toHaveTextContent('Produção');
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pick(user, 'Turno', '1º turno');
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });

  it('2º turno lista só os ativos do turno, com a nota de quem está sem turno', async () => {
    await openProducao('2º turno');
    expect(checkboxNames()).toEqual(['João', 'Maria', 'Pedro']);
    expect(screen.getByRole('checkbox', { name: 'Pedro' })).toBeDisabled();
    expect(screen.getByRole('listitem', { name: 'Pedro' })).toHaveTextContent('sem telefone');
    expect(screen.getByRole('listitem', { name: 'João' })).toHaveTextContent('2º turno');
    expect(screen.getByText('1 pessoa(s) deste setor estão sem turno definido — defina em Usuários')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para todos do turno (2)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
  });

  it('Todos os turnos lista quem está sem turno e manda o alvo sem turno', async () => {
    const user = await openProducao('Todos os turnos');
    expect(checkboxNames()).toEqual(['Ana', 'João', 'Maria', 'Pedro', 'Zé']);
    expect(screen.queryByText(/sem turno definido/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enviar para todos do turno (4)' }));
    expect(dialogTarget()).toMatchObject({ shift: null, userIds: null, label: 'Produção · todos os turnos' });
  });
});

describe('WhatsApp da equipe: seleção e envio', () => {
  it('selecionados: userIds na ordem do back, não na do clique', async () => {
    const user = await openProducao('2º turno');
    await user.click(screen.getByRole('checkbox', { name: 'Maria' }));
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await user.click(screen.getByRole('button', { name: 'Enviar para selecionados (2)' }));
    expect(dialogTarget()).toEqual({
      type: 'sector', sectorId: 's1', shift: 'SECOND', userIds: ['joao', 'maria'],
      label: 'Produção · 2º turno · seleção de 2',
      recipients: [{ id: 'joao', name: 'João' }, { id: 'maria', name: 'Maria' }],
      leftOut: [],
    });
  });

  it('todos do turno: sem userIds, e o sem telefone fica de fora', async () => {
    const user = await openProducao('2º turno');
    await user.click(screen.getByRole('button', { name: 'Enviar para todos do turno (2)' }));
    expect(dialogTarget()).toEqual({
      type: 'sector', sectorId: 's1', shift: 'SECOND', userIds: null, label: 'Produção · 2º turno',
      recipients: [{ id: 'joao', name: 'João' }, { id: 'maria', name: 'Maria' }],
      leftOut: [{ id: 'pedro', name: 'Pedro' }],
    });
  });

  it('Marcar todos marca e desmarca só os habilitados', async () => {
    const user = await openProducao('2º turno');
    await user.click(screen.getByRole('button', { name: 'Marcar todos' }));
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (2)' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Pedro' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Marcar todos' }));
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
  });

  it('trocar o turno ou o setor limpa a seleção', async () => {
    const user = await openProducao('2º turno');
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await pick(user, 'Turno', 'Todos os turnos');
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await pick(user, 'Setor', 'Expedição');
    await pick(user, 'Setor', 'Produção');
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
  });
});

describe('WhatsApp da equipe: página', () => {
  it('não tem mais os cards por setor e explica o fluxo novo', () => {
    render(<Page />);
    expect(screen.queryByRole('button', { name: 'Enviar ao setor' })).not.toBeInTheDocument();
    expect(screen.getByText('Escolha o setor e o turno e envie para todos ou só para quem você marcar.')).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: envios recentes', () => {
  it('lista destino, autor, canal e contagens; canal e autor removidos são tratados', () => {
    render(<Page />);
    const first = screen.getByRole('row', { name: /GoZap Principal/ });
    expect(first).toHaveTextContent('Compras');
    expect(first).toHaveTextContent('Ada');
    expect(first).toHaveTextContent('Enfileirados 1 · Enviados 2 · Falhas 3 · Pulados 4');
    const second = screen.getByRole('row', { name: /canal removido/ });
    expect(second).toHaveTextContent('Ana');
    expect(second).toHaveTextContent('—');
  });

  it('mostra o vazio quando não há envios', () => {
    useTeamDispatches.mockReturnValue({ data: { items: [] }, isLoading: false, isError: false });
    render(<Page />);
    expect(screen.getByText('Nenhum envio ainda.')).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: Ver destinatários', () => {
  const recipient = (name: string, shift: 'FIRST' | 'SECOND' | null, status: DispatchRecipient['status'], reason: string | null) => ({
    userId: `id-${name}`, name, shift, status, reason,
  });
  const withRecipients = {
    ...dispatches.items[0],
    target: { type: 'sector' as const, id: 's1', label: 'Produção · 2º turno', shift: 'SECOND' as const },
    recipients: [
      recipient('Ana', 'SECOND', 'SENT', null),
      recipient('Bia', 'SECOND', 'FAILED', 'evolution.session_closed'),
      recipient('Caio', null, 'SKIPPED', 'NO_PHONE'),
      recipient('Davi', 'FIRST', 'QUEUED', null),
    ],
  };

  it('mostra o destino com turno e lista todos os destinatários, sem telefone', async () => {
    useTeamDispatches.mockReturnValue({ data: { items: [withRecipients, dispatches.items[1]] }, isLoading: false, isError: false });
    render(<Page />);
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Produção · 2º turno');
    expect(screen.queryByText('Ver motivos')).not.toBeInTheDocument();
    expect(within(rows[2]).queryByText('Ver destinatários')).not.toBeInTheDocument();
    await userEvent.click(within(rows[1]).getByText('Ver destinatários'));
    expect(within(rows[1]).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Ana · 2º turno — Enviado',
      'Bia · 2º turno — Falhou: Canal desconectado — reconecte em Números e canais',
      'Caio · Sem turno — Pulado: sem telefone',
      'Davi · 1º turno — Na fila',
    ]);
    expect(screen.getByRole('table')).not.toHaveTextContent('+55');
  });
});
