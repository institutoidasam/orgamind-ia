import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./recipient-table', () => ({
  RecipientTable: ({ dispatchId, failedCount }: { dispatchId: string; failedCount: number }) => (
    <div>Tabela de {dispatchId} com {failedCount} falhas</div>
  ),
}));

import type { DispatchDetail, LeftOutRosterPerson } from '../schemas';
import { DispatchResult } from './dispatch-result';

const counts = {
  queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, uncertain: 0, skipped: 0, scheduled: 0, cancelled: 0,
};

const base: DispatchDetail = {
  id: 'd1', targetLabel: 'TI, Operação · Noite · 22/10', text: 'Reunião às 8h', state: 'DISPATCHED',
  createdAt: '2026-10-22T12:00:00.000Z', scheduledFor: null, firedAt: null, author: { id: 'a1', name: 'Ada' },
  sectors: [{ id: 's1', name: 'TI' }, { id: 's2', name: 'Operação' }],
  channels: [{ name: 'GoZap Principal', phoneE164: '+5592999990000', count: 4 }],
  counts: { ...counts, queued: 1, sent: 3, read: 2, failed: 2, uncertain: 1 },
  leftOut: { unselected: [], off: [] },
};

const person = (name: string, extra: Partial<LeftOutRosterPerson> = {}): LeftOutRosterPerson => ({
  userId: null, name, jobTitle: null, shiftName: null, reason: null, sectorName: null, levelName: null, ...extra,
});
const lines = (title: string) =>
  within(screen.getByRole('list', { name: title })).getAllByRole('listitem').map((li) => li.textContent);

describe('DispatchResult', () => {
  it('mostra o título, o destino, o texto e as contagens com os rótulos da GC11, só as não zero', () => {
    render(<DispatchResult dispatch={base} />);
    expect(screen.getByRole('heading', { name: 'Resultado do envio' })).toBeInTheDocument();
    expect(screen.getByText('TI, Operação · Noite · 22/10')).toBeInTheDocument();
    expect(screen.getByText('Reunião às 8h')).toBeInTheDocument();
    expect(screen.getByText('Ada', { exact: false })).toBeInTheDocument();
    const list = within(screen.getByRole('list', { name: 'Contagens por situação' }));
    expect(list.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Na fila 1', 'Aceito pelo WhatsApp 3', 'Lido 2', 'Falhou 2', 'Situação incerta 1',
    ]);
  });

  it('o número usado aparece; vários números trazem quantas pessoas cada um; a tabela recebe o envio e as falhas', () => {
    render(<DispatchResult dispatch={{
      ...base,
      channels: [
        { name: 'GoZap Principal', phoneE164: '+5592999990000', count: 3 },
        { name: 'Comercial', phoneE164: null, count: 1 },
      ],
    }} />);
    expect(screen.getByText('+5592999990000 (3)')).toBeInTheDocument();
    expect(screen.getByText('Comercial (1)')).toBeInTheDocument();
    expect(screen.getByText('Tabela de d1 com 2 falhas')).toBeInTheDocument();
  });
});

describe('DispatchResult', () => {
  it('quem ficou de fora aparece com o motivo (folga, férias ou só folga), e some quando não há ninguém', () => {
    const { rerender } = render(<DispatchResult dispatch={{
      ...base,
      leftOut: {
        unselected: [person('Ana'), person('Bia')],
        off: [person('Caio', { reason: 'VACATION' }), person('Duda', { reason: 'DAY_OFF' }), person('Eli')],
      },
    }} />);
    expect(lines('Ficaram de fora (5)')).toEqual([
      'Ana · não selecionado', 'Bia · não selecionado', 'Caio · Férias', 'Duda · Folga', 'Eli · de folga',
    ]);
    rerender(<DispatchResult dispatch={base} />);
    expect(screen.queryByText(/Ficaram de fora/)).not.toBeInTheDocument();
  });

  it('homônimos com o mesmo motivo viram duas linhas, sem chave repetida; com vários setores a linha traz o setor', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const twins = [person('Ana', { sectorName: 'TI' }), person('Ana', { sectorName: 'Operação' })];
    const { rerender } = render(<DispatchResult dispatch={{ ...base, leftOut: { unselected: twins, off: [] } }} />);
    expect(lines('Ficaram de fora (2)')).toEqual(['Ana · TI · não selecionado', 'Ana · Operação · não selecionado']);
    rerender(<DispatchResult dispatch={{
      ...base, sectors: [{ id: 's1', name: 'TI' }], leftOut: { unselected: [person('Ana'), person('Ana')], off: [] },
    }} />);
    expect(lines('Ficaram de fora (2)')).toEqual(['Ana · não selecionado', 'Ana · não selecionado']);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
