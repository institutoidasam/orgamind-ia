import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./recipient-table', () => ({
  RecipientTable: ({ dispatchId, failedCount }: { dispatchId: string; failedCount: number }) => (
    <div>Tabela de {dispatchId} com {failedCount} falhas</div>
  ),
}));

import { RULE_VIEW } from '../audience-preview.test-fixtures';
import type { DispatchDetail, LeftOutRosterPerson, TeamExcludedPerson } from '../schemas';
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
  purpose: null, base: null, rule: null, excluded: [],
};

const person = (name: string, extra: Partial<LeftOutRosterPerson> = {}): LeftOutRosterPerson => ({
  userId: null, name, jobTitle: null, shiftName: null, reason: null, sectorName: null, levelName: null, ...extra,
});
const lines = (title: string) =>
  within(screen.getByRole('list', { name: title })).getAllByRole('listitem').map((li) => li.textContent);
const excludedPerson = (name: string, reason: TeamExcludedPerson['reason']): TeamExcludedPerson => ({
  userId: `u-${name}`, name, sectorId: 's1', sectorName: 'Logística', shiftName: 'Manhã', levelName: null, reason,
});
const withRule = (excluded: TeamExcludedPerson[]): DispatchDetail => ({
  ...base,
  purpose: 'meeting',
  base: 'assigned',
  rule: { ...RULE_VIEW, purpose: 'meeting', base: 'assigned', includeOff: true },
  excluded,
  leftOut: { unselected: [person('Zé')], off: [] },
});

describe('DispatchResult: envio a uma pessoa', () => {
  it('I1: alvo pessoa (sem setores) não mostra finalidade, base nem regra anterior; setor antigo mostra', () => {
    const { rerender } = render(<DispatchResult dispatch={{ ...base, targetLabel: 'Ana Souza', sectors: [] }} />);
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(screen.queryByText(/Finalidade/)).not.toBeInTheDocument();
    expect(screen.queryByText(/regra anterior/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Regra do público' })).not.toBeInTheDocument();
    rerender(<DispatchResult dispatch={base} />);
    expect(screen.getByText('Finalidade: — · Base: equipe em serviço (regra anterior)')).toBeInTheDocument();
  });
});

describe('DispatchResult: ninguém conta duas vezes', () => {
  it('m1: o pulado por telefone aparece só em "De fora" e "No público" é quem foi para a fila', () => {
    const dispatch: DispatchDetail = {
      ...withRule([excludedPerson('Caio', 'no_phone')]),
      counts: { ...counts, queued: 2, skipped: 1 },
    };
    render(<DispatchResult dispatch={dispatch} />);
    const panel = within(screen.getByRole('region', { name: 'Regra do público' }));
    expect(panel.getByText('No público (2) · De fora (1)')).toBeInTheDocument();
    expect(lines('Sem telefone (1)')).toEqual(['Caio · Logística · Manhã']);
    expect(screen.getAllByText(/Caio/)).toHaveLength(1);
  });

  it.each(['suppressed', 'not_authorized'] as const)('m1: %s também sai do "No público"', (reason) => {
    render(<DispatchResult dispatch={{
      ...withRule([excludedPerson('Caio', reason), excludedPerson('Duda', 'day_off')]),
      counts: { ...counts, sent: 3, skipped: 1 },
    }} />);
    expect(screen.getByText('No público (3) · De fora (2)')).toBeInTheDocument();
  });
});

describe('DispatchResult: finalidade e regra', () => {
  it('aceite 13: detalhe antigo mostra base equipe em serviço (regra anterior)', () => {
    render(<DispatchResult dispatch={base} />);
    expect(screen.getByText('Finalidade: — · Base: equipe em serviço (regra anterior)')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Regra do público' })).not.toBeInTheDocument();
  });

  it('aceite 12: detalhe mostra o painel e os excluídos agrupados por motivo', () => {
    render(<DispatchResult dispatch={withRule([excludedPerson('Ana', 'not_selected'), excludedPerson('Bia', 'other_sector')])} />);
    const panel = within(screen.getByRole('region', { name: 'Regra do público' }));
    expect(panel.getByText('Reunião')).toBeInTheDocument();
    expect(panel.getByText('No público (9) · De fora (2)')).toBeInTheDocument();
    expect(lines('Não selecionado (1)')).toEqual(['Ana · Logística · Manhã']);
    expect(lines('Em outro setor nesta data (1)')).toEqual(['Bia · Logística · Manhã']);
    expect(screen.queryByText(/Finalidade: —/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Zé/)).not.toBeInTheDocument();
  });

  it('Férias e Folga separados no detalhe', () => {
    render(<DispatchResult dispatch={withRule([excludedPerson('Caio', 'vacation'), excludedPerson('Duda', 'day_off')])} />);
    expect(lines('Folga (1)')).toEqual(['Duda · Logística · Manhã']);
    expect(lines('Férias (1)')).toEqual(['Caio · Logística · Manhã']);
  });
});

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
