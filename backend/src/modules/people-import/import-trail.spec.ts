import { describe, expect, it } from 'vitest';
import type { ImportResultCounts } from './import-person';
import {
  importCompletedChange,
  importConfirmedChange,
  importReason,
} from './import-trail';

const AUTO_CLOSE_REASON =
  'Encerrada automaticamente: gravação interrompida há mais de 7 dias.';

const counts: ImportResultCounts = {
  rows: 40,
  created: 10,
  updated: 12,
  unchanged: 5,
  invalid: 3,
  duplicate: 2,
  conflict: 1,
  ignored: 4,
  failed: 2,
  phoneTaken: 1,
  notWritten: 0,
  writing: 0,
};

const completedInput = {
  actorId: 'ator-1',
  batchId: 'lote-1',
  fileName: 'pessoas.xlsx',
  counts,
};

function fieldsOf(change: { changes: { field: string }[] }): string[] {
  return change.changes.map((item) => item.field);
}

function afterOf(
  change: { changes: { field: string; after: unknown }[] },
  field: string,
): unknown {
  return change.changes.find((item) => item.field === field)?.after;
}

describe('importConfirmedChange', () => {
  it('Planilhas, entidade Spreadsheet, id do lote, sem dado pessoal', () => {
    const change = importConfirmedChange({
      actorId: 'ator-1',
      batchId: 'lote-1',
      fileName: 'pessoas.xlsx',
      rowCount: 40,
      toCreate: 10,
      toUpdate: 12,
    });

    expect(change).toMatchObject({
      action: 'people_import.confirmed',
      entity: 'Spreadsheet',
      entityId: 'lote-1',
      category: 'SPREADSHEET',
      subjectUserId: null,
      reason: null,
      actorId: 'ator-1',
    });
    expect(change.metadata).toBeUndefined();
    expect(change.changes).toEqual([
      { field: 'fileName', before: null, after: 'pessoas.xlsx' },
      { field: 'rowCount', before: null, after: 40 },
      { field: 'toCreate', before: null, after: 10 },
      { field: 'toUpdate', before: null, after: 12 },
    ]);
  });
});

describe('importCompletedChange', () => {
  it('Planilhas, contagens na ordem, com phoneTaken depois de failed', () => {
    const change = importCompletedChange({
      ...completedInput,
      ending: 'COMPLETED',
    });

    expect(change).toMatchObject({
      action: 'people_import.completed',
      entity: 'Spreadsheet',
      entityId: 'lote-1',
      category: 'SPREADSHEET',
      subjectUserId: null,
      reason: null,
      actorId: 'ator-1',
    });
    expect(change.metadata).toBeUndefined();
    expect(change.changes.every((item) => item.before === null)).toBe(true);
    expect(fieldsOf(change)).toEqual([
      'fileName',
      'ending',
      'rowCount',
      'created',
      'updated',
      'unchanged',
      'invalid',
      'duplicate',
      'conflict',
      'failed',
      'phoneTaken',
      'notWritten',
    ]);
    expect(afterOf(change, 'rowCount')).toBe(40);
    expect(afterOf(change, 'failed')).toBe(2);
    expect(afterOf(change, 'phoneTaken')).toBe(1);
  });
});

describe('importCompletedChange: writing e motivo', () => {
  it('writing só quando > 0; motivo só no automático', () => {
    const closed = importCompletedChange({
      ...completedInput,
      ending: 'CLOSED',
      counts: { ...counts, notWritten: 7, writing: 3 },
    });
    expect(closed.reason).toBeNull();
    expect(fieldsOf(closed).at(-1)).toBe('writing');
    expect(afterOf(closed, 'writing')).toBe(3);
    expect(afterOf(closed, 'notWritten')).toBe(7);

    const auto = importCompletedChange({
      ...completedInput,
      ending: 'AUTO_CLOSED',
    });
    expect(auto.reason).toBe(AUTO_CLOSE_REASON);
    expect(afterOf(auto, 'ending')).toBe('AUTO_CLOSED');
    expect(fieldsOf(auto)).not.toContain('writing');
  });
});

describe('importCompletedChange: sem dado pessoal', () => {
  it('só nome do arquivo e números, nenhum campo phone, email, nome ou id de pessoa', () => {
    const change = importCompletedChange({
      ...completedInput,
      ending: 'CLOSED',
      counts: { ...counts, writing: 1 },
    });

    expect(
      fieldsOf(change).filter((f) =>
        /^(phone|email|name|id|personId|userId)$/i.test(f),
      ),
    ).toEqual([]);
    for (const item of change.changes) {
      expect(['string', 'number']).toContain(typeof item.after);
    }
  });
});

describe('importReason', () => {
  it('prefixo e nome do arquivo; corta em 200 caracteres sem partir um par substituto', () => {
    const prefix = importReason('');
    expect(prefix).toBe('Importação de planilha: ');
    expect(importReason('pessoas.csv')).toBe(
      'Importação de planilha: pessoas.csv',
    );

    const long = importReason('a'.repeat(500));
    expect(long).toHaveLength(200);
    expect(long.startsWith(prefix)).toBe(true);

    const emoji = importReason('a'.repeat(199 - prefix.length) + '\u{1F600}');
    expect(emoji).toHaveLength(199);
    expect(emoji.endsWith('a')).toBe(true);
  });
});
