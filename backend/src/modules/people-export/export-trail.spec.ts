import { describe, expect, it } from 'vitest';
import {
  peopleExportChange,
  phoneVisibilityOf,
  scheduleExportChange,
} from './export-trail';

const setor = { id: 'setor-1', name: 'Logística' };
const turno = { id: 'turno-1', name: 'Manhã' };

const peopleInput = {
  actorId: 'ator-1',
  format: 'csv' as const,
  sector: null,
  shift: null,
  status: 'active' as const,
  date: '2026-11-19',
  rowCount: 42,
  phoneVisibility: 'masked' as const,
};

describe('peopleExportChange', () => {
  it('ação, categoria SPREADSHEET, autor e os sete campos com antes vazio', () => {
    const change = peopleExportChange(peopleInput);

    expect(change).toMatchObject({
      action: 'people.export',
      entity: 'Spreadsheet',
      entityId: null,
      category: 'SPREADSHEET',
      subjectUserId: null,
      reason: null,
      actorId: 'ator-1',
    });
    expect(change.metadata).toBeUndefined();
    expect(change.changes).toEqual([
      { field: 'format', before: null, after: 'CSV' },
      { field: 'sector', before: null, after: 'Todos os setores' },
      { field: 'shift', before: null, after: 'Todos os turnos' },
      { field: 'statusFilter', before: null, after: 'active' },
      { field: 'referenceDate', before: null, after: '2026-11-19' },
      { field: 'rowCount', before: null, after: 42 },
      { field: 'phoneVisibility', before: null, after: 'masked' },
    ]);
  });

  it('Todos os setores e Todos os turnos quando não há filtro; setor e turno escolhidos como id e nome', () => {
    const filtered = peopleExportChange({
      ...peopleInput,
      format: 'xlsx',
      sector: setor,
      shift: turno,
      status: 'all',
      phoneVisibility: 'full',
    });
    const after = (field: string) =>
      filtered.changes.find((item) => item.field === field)?.after;

    expect(after('format')).toBe('XLSX');
    expect(after('sector')).toEqual(setor);
    expect(after('shift')).toEqual(turno);
    expect(after('statusFilter')).toBe('all');
    expect(after('phoneVisibility')).toBe('full');
  });
});

describe('scheduleExportChange', () => {
  it('setor como entityId e período em periodFrom e periodTo', () => {
    const change = scheduleExportChange({
      actorId: 'ator-2',
      format: 'xlsx',
      sector: setor,
      from: '2026-11-01',
      to: '2026-11-30',
      rowCount: 120,
    });

    expect(change).toMatchObject({
      action: 'schedule.export',
      entity: 'Spreadsheet',
      entityId: 'setor-1',
      category: 'SPREADSHEET',
      subjectUserId: null,
      reason: null,
      actorId: 'ator-2',
    });
    expect(change.changes).toEqual([
      { field: 'format', before: null, after: 'XLSX' },
      { field: 'sector', before: null, after: setor },
      { field: 'periodFrom', before: null, after: '2026-11-01' },
      { field: 'periodTo', before: null, after: '2026-11-30' },
      { field: 'rowCount', before: null, after: 120 },
    ]);
  });
});

describe('phoneVisibilityOf', () => {
  it('masked sem a chave; full para ADMIN; partial para gestor com a chave', () => {
    expect(phoneVisibilityOf({ isAdmin: true, fullPhone: false })).toBe(
      'masked',
    );
    expect(phoneVisibilityOf({ isAdmin: false, fullPhone: false })).toBe(
      'masked',
    );
    expect(phoneVisibilityOf({ isAdmin: true, fullPhone: true })).toBe('full');
    expect(phoneVisibilityOf({ isAdmin: false, fullPhone: true })).toBe(
      'partial',
    );
  });
});

describe('dado de pessoa fora do evento', () => {
  it('nenhum campo se chama phone ou email e nenhum valor traz dado de pessoa', () => {
    const changes = [
      peopleExportChange({
        ...peopleInput,
        sector: setor,
        shift: turno,
        phoneVisibility: 'partial',
      }),
      scheduleExportChange({
        actorId: 'ator-1',
        format: 'csv',
        sector: setor,
        from: '2026-11-01',
        to: '2026-11-30',
        rowCount: 3,
      }),
    ];

    for (const change of changes) {
      for (const item of change.changes) {
        expect(item.field).not.toMatch(/phone$|^email$|name|registration/i);
        expect(item.before).toBeNull();
      }
      const text = JSON.stringify(change);
      expect(text).not.toMatch(/\+\d{8,}|@|•/);
    }
  });
});
