import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ROW_CLASSES, type RowView } from '../schemas';
import { PreviewTable, type RowGeneral } from './preview-table';
import { rowView as row } from './preview-test-helpers';

const GENERAL: RowGeneral = { createNew: true, updateExisting: true };

function setup(rows: RowView[], general: RowGeneral = GENERAL, excluded: number[] = []) {
  const onToggle = vi.fn();
  render(<PreviewTable rows={rows} general={general} excluded={new Set(excluded)} onToggle={onToggle} />);
  return onToggle;
}

describe('PreviewTable: textos da linha', () => {
  it('Atualizar mostra antes → depois; motivos e avisos por extenso', () => {
    setup([
      row(2, 'UPDATE', {
        diff: [
          {
            field: 'phone',
            label: 'Telefone',
            before: '(92) *****-0001',
            after: '(92) *****-0002',
          },
          {
            field: 'jobTitle',
            label: 'Função',
            before: null,
            after: 'Operadora',
          },
        ],
        warnings: ['Autorização ignorada: falta a origem.'],
      }),
      row(3, 'INVALID', { reasons: ['Telefone inválido'] }),
    ]);

    expect(screen.getByText('Telefone: (92) *****-0001 → (92) *****-0002')).toBeInTheDocument();
    expect(screen.getByText('Função: — → Operadora')).toBeInTheDocument();
    expect(screen.getByText('Autorização ignorada: falta a origem.')).toBeInTheDocument();
    const invalid = screen.getByRole('row', { name: /Pessoa 3/ });
    expect(within(invalid).getByText('Inválida')).toBeInTheDocument();
    expect(within(invalid).getByText('Telefone inválido')).toBeInTheDocument();
  });
});

describe('PreviewTable: caixas', () => {
  it('caixas só em Criar e Atualizar', async () => {
    const rows = ROW_CLASSES.map((classification, i) => row(i + 2, classification));
    const onToggle = setup(rows, GENERAL, [3]);

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(screen.getByRole('checkbox', { name: 'Incluir a linha 2' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Incluir a linha 3' })).not.toBeChecked();
    await userEvent.click(boxes[1]);
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ rowNumber: 3, classification: 'UPDATE' }));
  });

  it('marcador geral desligado desabilita as caixas da classe', () => {
    setup([row(2, 'CREATE'), row(3, 'UPDATE')], {
      createNew: false,
      updateExisting: true,
    });

    expect(screen.getByRole('checkbox', { name: 'Incluir a linha 2' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Incluir a linha 2' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Incluir a linha 3' })).toBeEnabled();
  });
});
