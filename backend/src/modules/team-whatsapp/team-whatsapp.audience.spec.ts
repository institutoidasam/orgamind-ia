import { describe, expect, it } from 'vitest';
import {
  classifySector,
  type AudienceEntry,
  type AudienceRuleReason,
} from './audience-classify';
import { buildAudience } from './team-whatsapp.audience';
import {
  SHIFT_FIRST,
  SHIFT_SECOND,
  dayPerson,
  onShift,
} from './team-whatsapp.test-fixtures';

const S1 = { id: 's1', name: 'Financeiro' };
const S2 = { id: 's2', name: 'Logística' };

/** Entrada já classificada de um setor (a saída de `classifySector`); `reason` nulo = entra. */
const entry = (
  id: string,
  sector = S1,
  reason: AudienceRuleReason | null = null,
): AudienceEntry => ({
  member: dayPerson({ id, name: id }),
  sectorId: sector.id,
  sectorName: sector.name,
  shiftId: null,
  shiftName: null,
  levelName: null,
  reason,
});

const ids = (list: readonly AudienceEntry[]) => list.map((e) => e.member.id);
const reasons = (list: readonly AudienceEntry[]) =>
  Object.fromEntries(list.map((e) => [e.member.id, e.reason]));

/** Pessoa do cadastro com setor e turno do vínculo (base vinculada). */
const worker = (id: string, sectorId: string, shift = SHIFT_FIRST) =>
  dayPerson({ id, name: id, sectorId, ...onShift(shift) });

const DAY_OFF = {
  cycle: { startDate: '2026-01-01', cycleLength: 1, days: [null] },
};
const VACATION = {
  exceptions: [
    {
      id: 'x-vacation',
      kind: 'VACATION' as const,
      startDate: '2026-11-20',
      endDate: '2026-11-20',
      shiftId: null,
      sectorId: null,
    },
  ],
};

/** O que `classifySector` devolve para o setor com "Incluir folga" nos dois primeiros turnos. */
const classifyWithOff = (
  sector: typeof S1,
  people: Parameters<typeof classifySector>[0]['people'],
) =>
  classifySector({
    base: 'assigned',
    sector,
    date: '2026-11-20',
    people,
    filter: {
      shiftIds: new Set([SHIFT_FIRST.id, SHIFT_SECOND.id]),
      includeOff: true,
      level: null,
      shiftNames: new Map(),
    },
  });

describe('buildAudience: dois setores e dois turnos com folga', () => {
  it('aceite 2: dois setores e dois turnos com folga — férias fora, cada pessoa uma vez', () => {
    const night = {
      id: 'shift_night',
      name: 'Noturno',
      startTime: '22:00',
      endTime: '06:00',
    };
    const people = [
      worker('ana', 's1'),
      worker('bia', 's1', SHIFT_SECOND),
      { ...worker('caio', 's2'), ...DAY_OFF },
      { ...worker('duda', 's2', SHIFT_SECOND), ...VACATION },
      worker('edu', 's1', night),
    ];

    const audience = buildAudience({
      sectors: [classifyWithOff(S1, people), classifyWithOff(S2, people)],
      userIds: undefined,
    });

    expect(ids(audience.included)).toEqual(['ana', 'bia', 'caio']);
    expect(reasons(audience.excluded)).toEqual({ duda: 'vacation' });
    expect(audience.unknownSelected).toEqual([]);
  });
});

describe('buildAudience: cada pessoa uma vez entre os setores', () => {
  it('incluída num setor e excluída noutro conta como incluída', () => {
    const audience = buildAudience({
      sectors: [
        [entry('ana', S1, 'other_sector'), entry('bia', S1)],
        [entry('ana', S2), entry('bia', S2, 'other_shift')],
      ],
      userIds: undefined,
    });

    expect(ids(audience.included)).toEqual(['bia', 'ana']);
    expect(audience.included.map((e) => e.sectorId)).toEqual(['s1', 's2']);
    expect(audience.excluded).toEqual([]);
  });

  it('excluída em todos os setores fica com o motivo do primeiro em que aparece', () => {
    const audience = buildAudience({
      sectors: [
        [entry('caio', S1, 'day_off')],
        [entry('caio', S2, 'vacation')],
      ],
      userIds: undefined,
    });

    expect(audience.included).toEqual([]);
    expect(audience.excluded).toHaveLength(1);
    expect(audience.excluded[0]).toMatchObject({
      sectorId: 's1',
      reason: 'day_off',
    });
  });
});

describe('buildAudience: seleção nominal', () => {
  const sectors = [
    [entry('ana'), entry('bia'), entry('caio'), entry('duda', S1, 'vacation')],
  ];

  it('aceite 5: seleção de duas; as outras Não selecionado', () => {
    const audience = buildAudience({ sectors, userIds: ['bia', 'caio'] });

    expect(ids(audience.included)).toEqual(['bia', 'caio']);
    expect(reasons(audience.excluded)).toEqual({
      ana: 'not_selected',
      duda: 'vacation',
    });
    expect(audience.unknownSelected).toEqual([]);
  });

  it('aceite 7: marcada de férias numa reunião fica Férias, não Não selecionado', () => {
    const audience = buildAudience({ sectors, userIds: ['duda'] });

    expect(audience.included).toEqual([]);
    expect(reasons(audience.excluded)).toEqual({
      ana: 'not_selected',
      bia: 'not_selected',
      caio: 'not_selected',
      duda: 'vacation',
    });
  });

  it('id sem relação vai para unknownSelected e não aparece nas listas', () => {
    const audience = buildAudience({
      sectors,
      userIds: ['ana', 'fantasma', 'fantasma'],
    });

    expect(audience.unknownSelected).toEqual(['fantasma']);
    expect(ids(audience.included)).toEqual(['ana']);
    expect(ids([...audience.included, ...audience.excluded])).not.toContain(
      'fantasma',
    );
  });

  it('userIds vazio é igual a sem seleção', () => {
    const none = buildAudience({ sectors, userIds: undefined });
    const empty = buildAudience({ sectors, userIds: [] });

    expect(empty).toEqual(none);
    expect(ids(empty.included)).toEqual(['ana', 'bia', 'caio']);
    expect(reasons(empty.excluded)).toEqual({ duda: 'vacation' });
  });
});
