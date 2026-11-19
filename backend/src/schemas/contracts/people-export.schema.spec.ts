import { describe, expect, it } from 'vitest';
import {
  peopleExportQuerySchema,
  scheduleExportQuerySchema,
} from './people-export.schema';

describe('peopleExportQuerySchema', () => {
  it('format obrigatório; status padrão active; sectorId e shiftId vazios valem ausentes; date opcional e só AAAA-MM-DD', () => {
    expect(peopleExportQuerySchema.safeParse({}).success).toBe(false);

    const minimal = peopleExportQuerySchema.parse({ format: 'csv' });
    expect(minimal).toEqual({
      format: 'csv',
      sectorId: undefined,
      shiftId: undefined,
      status: 'active',
      date: undefined,
    });

    const blank = peopleExportQuerySchema.parse({
      format: 'xlsx',
      sectorId: '',
      shiftId: '  ',
      status: 'all',
      date: '2026-11-19',
    });
    expect(blank.sectorId).toBeUndefined();
    expect(blank.shiftId).toBeUndefined();
    expect(blank.status).toBe('all');
    expect(blank.date).toBe('2026-11-19');

    const filled = peopleExportQuerySchema.parse({
      format: 'csv',
      sectorId: ' setor-1 ',
      shiftId: 'turno-1',
    });
    expect(filled.sectorId).toBe('setor-1');
    expect(filled.shiftId).toBe('turno-1');

    for (const date of ['19/11/2026', '2026-02-30', '']) {
      expect(
        peopleExportQuerySchema.safeParse({ format: 'csv', date }).success,
      ).toBe(false);
    }
    expect(
      peopleExportQuerySchema.safeParse({ format: 'csv', status: 'todos' })
        .success,
    ).toBe(false);
  });
});

describe('scheduleExportQuerySchema', () => {
  const valid = {
    format: 'xlsx',
    sectorId: 'setor-1',
    from: '2026-11-01',
    to: '2026-11-30',
  };

  it('format, sectorId, from e to obrigatórios', () => {
    expect(scheduleExportQuerySchema.parse(valid)).toEqual(valid);

    for (const missing of Object.keys(valid)) {
      const rest = Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== missing),
      );
      expect(scheduleExportQuerySchema.safeParse(rest).success).toBe(false);
    }
    expect(
      scheduleExportQuerySchema.safeParse({ ...valid, sectorId: '' }).success,
    ).toBe(false);
    expect(
      scheduleExportQuerySchema.safeParse({ ...valid, from: '2026-13-01' })
        .success,
    ).toBe(false);
  });
});

describe('formato da planilha', () => {
  it('formato fora de csv e xlsx é recusado', () => {
    for (const format of ['pdf', 'CSV', 'xls', '']) {
      expect(peopleExportQuerySchema.safeParse({ format }).success).toBe(false);
      expect(
        scheduleExportQuerySchema.safeParse({
          format,
          sectorId: 'setor-1',
          from: '2026-11-01',
          to: '2026-11-30',
        }).success,
      ).toBe(false);
    }
  });
});
