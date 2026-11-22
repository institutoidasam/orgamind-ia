import { describe, expect, it } from 'vitest';
import {
  IMPORT_FIELDS,
  ROW_CLASSES,
  type ColumnMapping,
  type ImportField,
  type RowClass,
} from '../../schemas/contracts/people-import.schema';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import { toImportActor, type ImportActor } from './import-actor';
import type { FieldDiff } from './import-person';
import type { StoredRow } from './people-import.repository';
import { toRowView } from './row-view';

const FULL = toImportActor({
  ...actorWith('SUPERVISOR', { id: 'u-full' }),
  managedSectorIds: ['s1'],
});
const BLIND = toImportActor({
  ...actorWith('SUPERVISOR', {
    id: 'u-blind',
    revoke: ['telefone.ver_completo'],
  }),
  managedSectorIds: ['s1'],
});
/** Nome cadastrado que é o próprio telefone (D11). */
const PHONE_NAME = '(92) 99111-0002';

function mappingOf(
  columns: Partial<Record<ImportField, number>>,
): ColumnMapping {
  const mapping = {} as ColumnMapping;
  for (const field of IMPORT_FIELDS) mapping[field] = columns[field] ?? null;
  return mapping;
}

const MAPPING = mappingOf({ name: 0, registration: 1, phone: 2, sector: 4 });

function rowOf(over: Partial<StoredRow> = {}): StoredRow {
  return {
    rowNumber: 2,
    cells: { '0': 'Ana Souza', '1': 'M-1', '2': '', '3': '', '4': 'Logística' },
    classification: 'CREATE',
    reasons: [],
    warnings: [],
    preview: null,
    ...over,
  };
}

function viewOf(row: StoredRow, actor: ImportActor) {
  return toRowView({ row, mapping: MAPPING, actor });
}

describe('toRowView: telefone nulo no diff (T17 M3)', () => {
  const phoneDiff = (before: string | null, after: string | null) =>
    rowOf({
      classification: 'UPDATE',
      preview: {
        personName: 'Ana Souza',
        diff: [{ field: 'phone', before, after }],
      },
    });
  const phone = { field: 'phone', label: 'Telefone' };

  it('pessoa sem telefone no cadastro: before nulo, com ou sem a chave', () => {
    const row = phoneDiff(null, '+5592991110003');
    for (const actor of [FULL, BLIND]) {
      expect(viewOf(row, actor).diff).toEqual([
        { ...phone, before: null, after: '(92) 99111-0003' },
      ]);
    }
  });

  it('linha sem telefone: after nulo', () => {
    const row = phoneDiff('+5592991110001', null);
    expect(viewOf(row, FULL).diff).toEqual([
      { ...phone, before: '(92) 99111-0001', after: null },
    ]);
    expect(viewOf(row, BLIND).diff).toEqual([
      { ...phone, before: '•••• 0001', after: null },
    ]);
  });
});

describe('toRowView: diff de Atualizar (GX8)', () => {
  const diff: FieldDiff[] = [
    { field: 'name', before: PHONE_NAME, after: 'Ana Souza' },
    { field: 'phone', before: '+5592991110001', after: '+5592991110003' },
    { field: 'sector', before: 'Logística', after: 'Cozinha' },
  ];
  const row = rowOf({
    classification: 'UPDATE',
    preview: { personName: PHONE_NAME, diff },
  });

  it('diff mascara nome e telefone de antes sem telefone.ver_completo', () => {
    expect(viewOf(row, BLIND).diff).toEqual([
      { field: 'name', label: 'Nome', before: '•••• 0002', after: 'Ana Souza' },
      {
        field: 'phone',
        label: 'Telefone',
        before: '•••• 0001',
        after: '(92) 99111-0003',
      },
      {
        field: 'sector',
        label: 'Setor',
        before: 'Logística',
        after: 'Cozinha',
      },
    ]);
    expect(viewOf(row, FULL).diff.slice(0, 2)).toEqual([
      { field: 'name', label: 'Nome', before: PHONE_NAME, after: 'Ana Souza' },
      {
        field: 'phone',
        label: 'Telefone',
        before: '(92) 99111-0001',
        after: '(92) 99111-0003',
      },
    ]);
  });
});

describe('toRowView: nome da linha', () => {
  const found = { personName: PHONE_NAME, diff: [] };

  it('nome da linha: célula do arquivo; vazia em Atualizar usa o nome atual com nameView', () => {
    const cells = (name: string) => ({
      '0': name,
      '1': 'M-1',
      '4': 'Logística',
    });
    const update = rowOf({
      classification: 'UPDATE',
      cells: cells(''),
      preview: found,
    });
    const masked = rowOf({
      classification: 'UNCHANGED',
      cells: cells('•••• 0002'),
      preview: found,
    });
    expect(viewOf(update, BLIND).name).toBe('•••• 0002');
    expect(viewOf(update, FULL).name).toBe(PHONE_NAME);
    expect(viewOf(masked, BLIND).name).toBe('•••• 0002');
    expect(viewOf(rowOf({ cells: cells('Bruno Lima') }), BLIND).name).toBe(
      'Bruno Lima',
    );
    const invalid = rowOf({
      classification: 'INVALID',
      cells: cells(''),
      preview: found,
    });
    expect(viewOf(invalid, FULL).name).toBeNull();
  });
});

describe('toRowView: caixa e colunas', () => {
  it('selectable só em Criar e Atualizar', () => {
    const selectable = (classification: RowClass | null) =>
      viewOf(rowOf({ classification }), FULL).selectable;
    expect(ROW_CLASSES.filter(selectable)).toEqual(['CREATE', 'UPDATE']);
    expect(selectable(null)).toBe(false);
  });

  it('mostra só as colunas mapeadas: coluna não mapeada não sai na resposta', () => {
    const row = rowOf({
      cells: {
        '0': 'Ana Souza',
        '1': 'M-1',
        '3': 'CPF-SIGILOSO',
        '4': 'Logística',
      },
      reasons: ['Nome inválido'],
      warnings: ['Linha de exemplo'],
    });
    const view = viewOf(row, FULL);
    expect(view).toEqual({
      rowNumber: 2,
      classification: 'CREATE',
      name: 'Ana Souza',
      registration: 'M-1',
      sector: 'Logística',
      reasons: ['Nome inválido'],
      warnings: ['Linha de exemplo'],
      diff: [],
      selectable: true,
    });
    expect(JSON.stringify(view)).not.toContain('CPF-SIGILOSO');
  });
});
