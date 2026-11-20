import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PREVIEW_RESPONSE, RULE_VIEW } from '../audience-preview.test-fixtures';
import type { TeamAudiencePreview } from '../schemas';
import { MemberSelection } from './member-selection';

type Included = TeamAudiencePreview['included'][number];
type Excluded = TeamAudiencePreview['excluded'][number];

const base = { sectorId: 's1', sectorName: 'Logística', shiftName: 'Manhã', levelName: null };
const ana: Included = { ...base, userId: 'ana', name: 'Ana', levelName: 'Coordenador', phone: '•••• 0001' };
const bia: Included = { ...base, userId: 'bia', name: 'Bia', phone: '+5592991110002' };
const out = (userId: string, name: string, reason: Excluded['reason']): Excluded => ({ ...base, userId, name, reason });
const preview = (included: Included[], excluded: Excluded[], sectors = RULE_VIEW.sectors): TeamAudiencePreview => ({
  ...PREVIEW_RESPONSE, rule: { ...RULE_VIEW, sectors }, included, excluded,
});

function setup(data: TeamAudiencePreview, extra: { selected?: string[]; isFresh?: boolean } = {}) {
  const handlers = { onToggle: vi.fn(), onToggleAll: vi.fn(), onSendAll: vi.fn(), onSendSelected: vi.fn() };
  render(
    <MemberSelection preview={data} isFresh={extra.isFresh ?? true} selected={new Set(extra.selected ?? [])} {...handlers} />,
  );
  return { user: userEvent.setup(), ...handlers };
}

describe('MemberSelection: Vão receber e Ficam de fora', () => {
  const data = preview([ana, bia], [out('maria', 'Maria', 'vacation'), out('rafa', 'Rafa', 'day_off'), out('pedro', 'Pedro', 'no_phone')]);

  it('mostra Vão receber e Ficam de fora vindos do servidor, agrupados por motivo', () => {
    setup(data);
    expect(screen.getByRole('heading', { name: 'Vão receber (2)' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Ana' })).toHaveTextContent('Ana');
    expect(screen.getByRole('listitem', { name: 'Ana' })).toHaveTextContent('Logística · Manhã · Coordenador');
    expect(screen.getByRole('heading', { name: 'Ficam de fora (3)' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Sem telefone (1)' })).toHaveTextContent('Pedro');
  });

  it('Férias e Folga em grupos separados', () => {
    setup(data);
    expect(within(screen.getByRole('list', { name: 'Férias (1)' })).getByText(/Maria/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Folga (1)' })).getByText(/Rafa/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Folga (1)' })).queryByText(/Maria/)).not.toBeInTheDocument();
  });

  it('só quem está em Vão receber tem caixa de marcar', () => {
    setup(data);
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Ana', 'Bia']);
    expect(within(screen.getByRole('list', { name: 'Folga (1)' })).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('telefone como veio do servidor (mascarado ou não)', () => {
    setup(data);
    expect(screen.getByRole('listitem', { name: 'Ana' })).toHaveTextContent('•••• 0001');
    expect(screen.getByRole('listitem', { name: 'Bia' })).toHaveTextContent('+5592991110002');
  });
});

describe('MemberSelection: áreas', () => {
  const areas = [{ id: 's1', name: 'Logística' }, { id: 's2', name: 'Atendimento' }];
  const rui: Included = { ...base, userId: 'rui', name: 'Rui', sectorId: 's2', sectorName: 'Atendimento', phone: null };

  it('agrupa por área pelo sectorId da prévia; remanejado aparece uma vez', () => {
    setup(preview([ana, rui], [], areas));
    expect(screen.getByRole('heading', { name: 'Atendimento' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Vão receber · Logística' })).getAllByRole('listitem')).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: 'Vão receber · Atendimento' })).getByText('Rui')).toBeInTheDocument();
    expect(screen.getAllByText('Rui')).toHaveLength(1);
  });

  it('área sem ninguém avisa, sem lista', () => {
    setup(preview([ana], [], areas));
    expect(screen.getByText('Ninguém neste setor, data e turno.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Vão receber · Atendimento' })).not.toBeInTheDocument();
  });
});

describe('MemberSelection: seleção e botões', () => {
  const data = preview([ana], [out('bia', 'Bia', 'not_selected'), out('maria', 'Maria', 'vacation')]);

  it('Não selecionado continua marcável e fica fora de Ficam de fora', async () => {
    const { user, onToggle } = setup(data, { selected: ['ana'] });
    expect(screen.getByRole('heading', { name: 'Não selecionado (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ficam de fora (1)' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('list', { name: 'Não selecionado' })).getByRole('checkbox', { name: 'Bia' }));
    expect(onToggle).toHaveBeenCalledWith('bia');
  });

  it('com marcados só Enviar para selecionados vale; sem marcados, só Enviar para todos', async () => {
    const { user, onSendSelected } = setup(data, { selected: ['ana'] });
    expect(screen.getByRole('button', { name: 'Enviar para todos' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Enviar para selecionados (1)' }));
    expect(onSendSelected).toHaveBeenCalledTimes(1);
  });

  it('sem marcados, Enviar para todos leva a contagem da prévia e Marcar todos chama a tela', async () => {
    const { user, onSendAll, onToggleAll } = setup(preview([ana, bia], []));
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Marcar todos' }));
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (2)' }));
    expect([onToggleAll, onSendAll].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
  });

  it('prévia que não é a do corpo atual avisa e trava os dois botões de enviar', () => {
    setup(data, { selected: ['ana'], isFresh: false });
    expect(screen.getByText('Atualizando a lista…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (1)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviar para todos' })).toBeDisabled();
  });
});

describe('MemberSelection: vazio e marcados que ficaram de fora', () => {
  it('sem ninguém em Vão receber mas com Não selecionado, não diz que não há ninguém', () => {
    setup(preview([], [out('bia', 'Bia', 'not_selected')]), { selected: ['ana'] });
    expect(screen.getByRole('heading', { name: 'Não selecionado (1)' })).toBeInTheDocument();
    expect(screen.queryByText('Ninguém neste setor, data e turno.')).not.toBeInTheDocument();
  });

  it('pessoa marcada que ficou de fora (Férias) tem caixa só para desmarcar; as não marcadas, não', async () => {
    const data = preview([ana], [out('maria', 'Maria', 'vacation'), out('rafa', 'Rafa', 'day_off')]);
    const { user, onToggle } = setup(data, { selected: ['ana', 'maria'] });
    const marked = screen.getByRole('list', { name: 'Marcados que ficam de fora' });
    expect(within(marked).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(marked).getByRole('checkbox', { name: 'Maria' })).toBeChecked();
    expect(within(marked).getByRole('listitem', { name: 'Maria' })).toHaveTextContent('Férias');
    expect(within(screen.getByRole('list', { name: 'Folga (1)' })).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(within(marked).getByRole('checkbox', { name: 'Maria' }));
    expect(onToggle).toHaveBeenCalledWith('maria');
  });

  it('sem ninguém marcado entre os de fora, não desenha a lista de marcados', () => {
    setup(preview([ana], [out('maria', 'Maria', 'vacation')]), { selected: ['ana'] });
    expect(screen.queryByRole('list', { name: 'Marcados que ficam de fora' })).not.toBeInTheDocument();
  });
});
