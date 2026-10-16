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

import { Route } from './index';

const Page = (Route as unknown as { component: ComponentType }).component;

const members = [
  { id: 'u1', name: 'Ana', email: 'ana@x.test', phoneE164: '+5592991234567', isActive: true },
  { id: 'u2', name: 'Bruno', email: 'bruno@x.test', phoneE164: null, isActive: true },
  { id: 'u3', name: 'Carla', email: 'carla@x.test', phoneE164: '+5592988887777', isActive: false },
];
const targets = {
  channels: [],
  sectors: [{ id: 's1', name: 'Compras', code: 'COMP', members }],
};
const dispatches = {
  items: [
    {
      id: 'd1', createdAt: '2026-10-16T12:00:00.000Z',
      author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
      target: { type: 'sector' as const, id: 's1', label: 'Compras' },
      channel: { id: 'ch1', name: 'GoZap Principal' },
      counts: { queued: 1, sent: 2, failed: 3, skipped: 4 },
    },
    {
      id: 'd2', createdAt: '2026-10-15T12:00:00.000Z',
      author: null,
      target: { type: 'user' as const, id: 'u1', label: 'Ana' },
      channel: null,
      counts: { queued: 0, sent: 1, failed: 0, skipped: 0 },
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
    expect(screen.queryByRole('heading', { name: 'Compras' })).not.toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: setores e membros', () => {
  it('lista membros com telefone, sem telefone e inativo', () => {
    render(<Page />);
    expect(screen.getByRole('heading', { name: 'Compras' })).toBeInTheDocument();
    expect(screen.getByText('(92) 99123-4567')).toBeInTheDocument();
    expect(screen.getByText('sem telefone')).toBeInTheDocument();
    expect(screen.getByText('Inativo')).toBeInTheDocument();
  });

  it('desabilita Enviar para quem não tem telefone ou está inativo', () => {
    render(<Page />);
    const enviar = (name: RegExp) => within(screen.getByRole('listitem', { name })).getByRole('button', { name: 'Enviar' });
    expect(enviar(/Ana/)).toBeEnabled();
    expect(enviar(/Bruno/)).toBeDisabled();
    expect(enviar(/Carla/)).toBeDisabled();
  });

  it('Enviar ao setor abre o diálogo com os membros ativos com telefone', async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole('button', { name: 'Enviar ao setor' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '{"type":"sector","sectorId":"s1","label":"Compras","recipientCount":1}',
    );
  });

  it('Enviar para uma pessoa abre o diálogo com o usuário', async () => {
    render(<Page />);
    const row = screen.getByRole('listitem', { name: /Ana/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Enviar' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('{"type":"user","userId":"u1","label":"Ana"}');
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
