import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FilterBuilder } from './filter-builder';
import { excludeInvalidGroup } from '../exclude-invalid';
import type { FilterGroup } from '../schemas';

describe('FilterBuilder — field set', () => {
  it('renders the whatsappValid field (the supported one) without error', () => {
    render(
      <FilterBuilder
        value={{
          combinator: 'and',
          rules: [{ field: 'whatsappValid', op: 'eq', value: 'true' }],
        }}
        onChange={() => {}}
      />,
    );
    // The Radix Select trigger reflects the selected field value.
    expect(screen.getByText('whatsappValid')).toBeInTheDocument();
  });

  it('does not expose the invalid optedOut field anywhere', () => {
    render(
      <FilterBuilder
        value={{ combinator: 'and', rules: [{ field: 'city', op: 'eq', value: '' }] }}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByText('optedOut')).not.toBeInTheDocument();
  });
});

describe('FilterBuilder — in/notIn array values', () => {
  it('emits in/notIn values as an array, splitting on commas', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={{ combinator: 'and', rules: [{ field: 'tags', op: 'in', value: [] }] }}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'a, b ,c' } });

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0] as FilterGroup;
    const rule = last.rules[0] as { value: unknown };
    expect(rule.value).toEqual(['a', 'b', 'c']);
  });

  it('keeps a plain string value for scalar ops like eq', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={{ combinator: 'and', rules: [{ field: 'city', op: 'eq', value: '' }] }}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Manaus' } });

    const last = onChange.mock.calls.at(-1)![0] as FilterGroup;
    const rule = last.rules[0] as { value: unknown };
    expect(rule.value).toBe('Manaus');
  });

  it('renders an array value joined back into the input for editing', () => {
    render(
      <FilterBuilder
        value={{
          combinator: 'and',
          rules: [{ field: 'tags', op: 'in', value: ['x', 'y'] }],
        }}
        onChange={() => {}}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('x, y');
  });
});

describe('FilterBuilder — whatsappValid boolean + "only valid" shortcut', () => {
  it('renders a Válido/Inválido select (not a text input) for whatsappValid', () => {
    render(
      <FilterBuilder
        value={{
          combinator: 'and',
          rules: [{ field: 'whatsappValid', op: 'eq', value: true }],
        }}
        onChange={() => {}}
      />,
    );
    // No free-text value input for this boolean field.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Válido')).toBeInTheDocument();
  });

  it('o toggle "Excluir inválidos confirmados" emite as 4 REGRAS null-safe, não `whatsappValid eq true`', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={{ combinator: 'and', rules: [] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Excluir inválidos confirmados'));
    const last = onChange.mock.calls.at(-1)![0] as FilterGroup;
    expect(last.rules).toEqual([excludeInvalidGroup()]);
  });

  it('desmarcar remove o grupo e preserva as regras do operador', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={{
          combinator: 'and',
          rules: [
            { field: 'city', op: 'eq', value: 'Manaus' },
            excludeInvalidGroup(),
          ],
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText('Excluir inválidos confirmados'));
    const last = onChange.mock.calls.at(-1)![0] as FilterGroup;
    expect(last.rules).toEqual([{ field: 'city', op: 'eq', value: 'Manaus' }]);
  });

  // As 4 regras não podem virar 4 linhas de formulário: o operador ligou UM
  // interruptor, e é isso que ele tem de ver.
  it('o grupo aparece como chip read-only, e não como quatro linhas de regra', () => {
    render(
      <FilterBuilder
        value={{ combinator: 'and', rules: [excludeInvalidGroup()] }}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByTestId('exclude-invalid-chip'),
    ).toHaveTextContent(/Inválidos confirmados excluídos/i);
    expect(screen.queryByTestId('rule-row')).not.toBeInTheDocument();
  });

  it('avisa quando o filtro legado `whatsappValid eq true` está presente', () => {
    render(
      <FilterBuilder
        value={{
          combinator: 'and',
          rules: [{ field: 'whatsappValid', op: 'eq', value: true }],
        }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('legacy-valid-only-warning')).toHaveTextContent(
      /não validados/i,
    );
  });
});

// Bug de produção: dentro de um dialog estreito (ver bulk-grant-dialog), a
// linha da regra (campo | operador | valor | remover) transbordava — os dois
// selects de largura fixa (campo/operador) não cediam espaço, o input de
// valor era espremido/cortado e o container acabava rolando horizontalmente.
describe('FilterBuilder — a linha da regra não transborda em container estreito', () => {
  it('renderiza campo, operador e valor juntos, com o valor sempre editável', () => {
    const onChange = vi.fn();
    render(
      <FilterBuilder
        value={{ combinator: 'and', rules: [{ field: 'city', op: 'eq', value: '' }] }}
        onChange={onChange}
      />,
    );

    // combinador do grupo + campo + operador = pelo menos 3 comboboxes
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes.length).toBeGreaterThanOrEqual(3);

    // o valor é um input de texto, presente, habilitado e editável
    const valueInput = screen.getByRole('textbox');
    expect(valueInput).toBeInTheDocument();
    expect(valueInput).toBeEnabled();

    fireEvent.change(valueInput, { target: { value: 'Manaus' } });
    const last = onChange.mock.calls.at(-1)![0] as FilterGroup;
    const rule = last.rules[0] as { value: unknown };
    expect(rule.value).toBe('Manaus');
  });

  it('a linha da regra pode quebrar linha e encolher em vez de transbordar', () => {
    render(
      <FilterBuilder
        value={{ combinator: 'and', rules: [{ field: 'city', op: 'eq', value: '' }] }}
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId('rule-row');
    // Sem `flex-wrap` + `min-w-0`, os selects de campo/operador (largura fixa)
    // não cedem espaço e o input de valor é espremido/cortado, ou a linha
    // inteira transborda e força rolagem horizontal no dialog que a contém.
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(row.className).toMatch(/\bmin-w-0\b/);
  });
});

// F1 review fix — um nó `{kind:'history', ...}` (F1 T6, materializado por
// history-exclusion.ts) não é uma Rule: não tem field/op/value. Antes deste
// fix o builder o tratava como RuleNode e renderizava uma linha "fantasma"
// (selects de field/op vazios); pior, editar/apagar via stripIds reescrevia o
// nó em `{field:undefined,op:undefined,value:undefined}`, destruindo a
// exclusão em silêncio (nenhum erro, nenhum aviso). Repro real: salvar
// Segmento de exclusão → nova campanha → "Carregar de um segmento" força modo
// avançado → builder mostrava a linha fantasma.
describe('FilterBuilder — nó history (F1 T6) vira chip read-only, não uma RuleRow', () => {
  const historyGroup: FilterGroup = {
    combinator: 'and',
    rules: [
      {
        kind: 'history',
        event: 'received',
        negate: true,
        campaignIds: ['c1'],
      },
    ],
  };

  it('renderiza um chip legível (não uma RuleRow vazia) com as contagens de campanhas/templates', () => {
    render(<FilterBuilder value={historyGroup} onChange={() => {}} />);

    expect(screen.getByTestId('history-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('rule-row')).not.toBeInTheDocument();
    expect(
      screen.getByText('Excluir quem já recebeu: 1 campanha(s), 0 template(s)'),
    ).toBeInTheDocument();
  });

  it('round-trip attachIds→stripIds é identidade para o nó history (nenhum campo é perdido/corrompido)', () => {
    const onChange = vi.fn();
    render(<FilterBuilder value={historyGroup} onChange={onChange} />);

    // Força um round-trip attachIds→stripIds sem tocar no nó history:
    // alterna o toggle "Excluir inválidos confirmados" (adiciona um grupo) e
    // depois desfaz, o que reemite a árvore inteira via stripIds.
    fireEvent.click(screen.getByLabelText('Excluir inválidos confirmados'));
    fireEvent.click(screen.getByLabelText('Excluir inválidos confirmados'));

    const last = onChange.mock.calls.at(-1)![0] as FilterGroup;
    expect(last).toEqual(historyGroup);
  });

  it('o botão de lixeira remove o nó history (remoção deliberada, não uma "regra vazia")', () => {
    const onChange = vi.fn();
    render(<FilterBuilder value={historyGroup} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Remover exclusão de histórico'));

    const last = onChange.mock.calls.at(-1)![0] as FilterGroup;
    expect(last.rules).toHaveLength(0);
  });
});
