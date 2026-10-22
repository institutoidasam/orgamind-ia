import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DispatchList } from '../schemas';
import { RecentDispatches } from './recent-dispatches';

type Item = DispatchList['items'][number];

const counts = { queued: 0, sent: 1, failed: 0, skipped: 0, scheduled: 0, cancelled: 0 };
const TI = { id: 's-ti', name: 'TI' };
const OPERACAO = { id: 's-op', name: 'Operação' };

const recipient = (name: string, sectorName: string | null, levelName: string | null) => ({
  userId: `id-${name}`, name, shiftName: 'Noite', status: 'SENT' as const, reason: null, sectorName, levelName,
});
const person = (name: string, sectorName: string | null, levelName: string | null, extra: Partial<Item['off'][number]> = {}) => ({
  userId: `id-${name}`, name, jobTitle: null, shiftName: null, reason: null, sectorName, levelName, ...extra,
});

const base: Item = {
  id: 'd1',
  createdAt: '2026-10-22T12:00:00.000Z',
  author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
  target: { type: 'sector', id: 's-ti', label: 'TI, Operação · Noite · 22/10', shift: null },
  sectors: [TI, OPERACAO],
  channel: { id: 'ch1', name: 'GoZap Principal' },
  counts,
  recipients: [],
  rosterDate: '2026-10-22',
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
  unselected: [],
  off: [],
};

const lines = (name: string) => within(screen.getByRole('list', { name })).getAllByRole('listitem').map((li) => li.textContent);

async function openDetails() {
  await userEvent.click(screen.getByText('Ver destinatários'));
}

describe('RecentDispatches: Ver destinatários', () => {
  it('envio de TI e Operação agrupa os três grupos por setor, com o nível da época ao lado do nome', async () => {
    render(<RecentDispatches items={[{
      ...base,
      recipients: [
        recipient('Bia', 'Operação', 'Analista'),
        recipient('Ana', 'TI', 'Coordenador'),
        recipient('Caio', 'TI', null),
      ],
      unselected: [person('Davi', 'Operação', 'Coordenador', { jobTitle: 'Líder', shiftName: 'Noite' })],
      off: [person('Eva', 'TI', 'Analista', { reason: 'VACATION' })],
    }]} />);
    await openDetails();

    expect(lines('Destinatários · TI')).toEqual(['Ana · Coordenador · Noite — Enviado', 'Caio · Noite — Enviado']);
    expect(lines('Destinatários · Operação')).toEqual(['Bia · Analista · Noite — Enviado']);
    expect(lines('Escalados não marcados · Operação')).toEqual(['Davi · Coordenador · Líder · Noite']);
    expect(lines('De folga · TI')).toEqual(['Eva · Analista · Férias']);
    expect(screen.queryByRole('list', { name: 'Destinatários' })).not.toBeInTheDocument();
    // A ordem dos subgrupos segue a dos setores do envio, não a de chegada dos destinatários.
    const titles = screen.getAllByRole('list', { name: /^Destinatários · / }).map((ul) => ul.getAttribute('aria-label'));
    expect(titles).toEqual(['Destinatários · TI', 'Destinatários · Operação']);
  });
});

describe('RecentDispatches: Ver destinatários', () => {
  it('quem não tem setor gravado vai para "Sem setor" depois dos setores do envio', async () => {
    render(<RecentDispatches items={[{
      ...base,
      recipients: [recipient('Zeca', null, null), recipient('Ana', 'TI', null)],
    }]} />);
    await openDetails();

    expect(lines('Destinatários · Sem setor')).toEqual(['Zeca · Noite — Enviado']);
    const titles = screen.getAllByRole('list').map((ul) => ul.getAttribute('aria-label'));
    expect(titles).toEqual(['Destinatários · TI', 'Destinatários · Sem setor']);
  });

  it('envio de um setor mostra a lista como antes, sem subtítulo de setor', async () => {
    render(<RecentDispatches items={[{
      ...base,
      sectors: [TI],
      recipients: [recipient('Ana', 'TI', 'Coordenador'), recipient('Caio', 'TI', null)],
      off: [person('Eva', 'TI', null, { reason: 'DAY_OFF' })],
    }]} />);
    await openDetails();

    expect(lines('Destinatários')).toEqual(['Ana · Coordenador · Noite — Enviado', 'Caio · Noite — Enviado']);
    expect(lines('De folga')).toEqual(['Eva · Folga']);
    expect(screen.queryByText('TI')).not.toBeInTheDocument();
  });

  it('envio antigo sem nível mostra só o nome', async () => {
    render(<RecentDispatches items={[{
      ...base,
      sectors: [TI],
      recipients: [recipient('Ana', 'TI', null)],
      unselected: [person('Davi', 'TI', null)],
    }]} />);
    await openDetails();

    expect(lines('Destinatários')).toEqual(['Ana · Noite — Enviado']);
    expect(lines('Escalados não marcados')).toEqual(['Davi']);
  });
});

describe('RecentDispatches: autor', () => {
  it('autor sem nome e sem e-mail (pessoa sem acesso) mostra o traço', () => {
    render(<RecentDispatches items={[{ ...base, author: { id: 'a1', name: null, email: null } }]} />);
    expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1]).toHaveTextContent('—');
  });
});
