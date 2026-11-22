import { describe, expect, it } from 'vitest';
import type { StaffExceptionKind } from '@prisma/client';
import type { ScheduleExceptionInput } from '../staff-schedule/schedule-resolver';
import {
  classifySector,
  type AudienceBase,
  type AudienceEntry,
  type AudienceFilter,
} from './audience-classify';
import { withAssignmentOn } from './team-member-assignment';
import {
  SHIFT_FIRST,
  SHIFT_SECOND,
  dayPerson,
  onShift,
} from './team-whatsapp.test-fixtures';

const DATE = '2026-11-20';
const S1 = { id: 's1', name: 'Financeiro' };
const S2 = { id: 's2', name: 'Logística' };
const NIGHT = { id: 'shift_night', name: 'Noturno' };
const OLD = { id: 'shift_old', name: 'Turno antigo' };
const NAMES = new Map(
  [SHIFT_FIRST, SHIFT_SECOND, NIGHT].map((s) => [s.id, s.name]),
);
const only = (...ids: string[]) => new Set(ids);

/** Pessoa do setor s1 com o turno do vínculo (sem ciclo: o turno do cadastro vale todo dia). */
const worker = (
  id: string,
  shift: { id: string; name: string } | null,
  over: Partial<Parameters<typeof dayPerson>[0]> = {},
) => dayPerson({ id, name: id, ...onShift(shift), ...over });

/** Ciclo de um dia que repete `shiftId` (null = folga) desde antes da data. */
const cycleOf = (shiftId: string | null, startDate = '2026-01-01') => ({
  cycle: { startDate, cycleLength: 1, days: [shiftId] },
});

/** Exceção que cobre só a data do teste. */
const on = (
  kind: StaffExceptionKind,
  extra: Partial<ScheduleExceptionInput> = {},
) => ({
  exceptions: [
    {
      id: `x-${kind}`,
      kind,
      startDate: DATE,
      endDate: DATE,
      shiftId: null,
      sectorId: null,
      ...extra,
    },
  ],
});

const run = (
  base: AudienceBase,
  people: Parameters<typeof classifySector>[0]['people'],
  over: Partial<AudienceFilter> = {},
  at: { sector?: typeof S1; date?: string } = {},
): AudienceEntry[] =>
  classifySector({
    base,
    sector: at.sector ?? S1,
    date: at.date ?? DATE,
    people,
    filter: {
      shiftIds: null,
      includeOff: false,
      level: null,
      shiftNames: NAMES,
      ...over,
    },
  });

/** id → motivo ('in' = entra), para comparar o público inteiro de uma vez. */
const verdict = (entries: readonly AudienceEntry[]) =>
  Object.fromEntries(entries.map((e) => [e.member.id, e.reason ?? 'in']));

describe('classifySector em serviço: folga não tem opção de entrar (regra T3)', () => {
  it('folga com includeOff:true não entra na base em serviço', () => {
    const entries = run(
      'on_duty',
      [worker('ana', SHIFT_FIRST), worker('caio', SHIFT_FIRST, cycleOf(null))],
      { includeOff: true },
    );
    expect(verdict(entries)).toEqual({ ana: 'in', caio: 'day_off' });
  });
});

describe('classifySector em serviço: quem entra e quem sai com motivo', () => {
  it('aceite 1: em serviço — escalados e remanejados para o setor entram; Folga, Férias e Em outro setor nesta data', () => {
    const toS1 = on('OTHER_SECTOR', {
      shiftId: SHIFT_SECOND.id,
      sectorId: 's1',
    });
    const toS2 = on('OTHER_SECTOR', {
      shiftId: SHIFT_FIRST.id,
      sectorId: 's2',
    });
    const entries = run('on_duty', [
      worker('ana', SHIFT_FIRST),
      worker('bia', SHIFT_FIRST, { sectorId: 's9', ...toS1 }),
      worker('caio', SHIFT_FIRST, cycleOf(null)),
      worker('duda', SHIFT_FIRST, on('VACATION')),
      worker('edu', SHIFT_FIRST, toS2),
      worker('gui', SHIFT_FIRST, { sectorId: 's9' }),
    ]);
    expect(verdict(entries)).toEqual({
      ana: 'in',
      bia: 'in',
      caio: 'day_off',
      duda: 'vacation',
      edu: 'other_sector',
    });
    const bia = entries.find((e) => e.member.id === 'bia');
    expect(bia).toMatchObject({ sectorId: 's1', shiftName: '2º turno' });
  });

  it('aceite 15: escala põe em outro turno ou em nenhum → Fora do turno nesta data', () => {
    const chosen = { shiftIds: only(SHIFT_FIRST.id) };
    const swapped = worker('ana', SHIFT_FIRST, cycleOf(SHIFT_SECOND.id));
    const nowhere = worker('bia', SHIFT_FIRST, on('SHIFT_SWAP'));
    const entries = run('on_duty', [swapped, nowhere], chosen);
    expect(verdict(entries)).toEqual({
      ana: 'other_shift',
      bia: 'other_shift',
    });
    // Com todos os turnos, quem a escala não põe em turno nenhum também.
    const loose = run('on_duty', [worker('cia', null)]);
    expect(verdict(loose)).toEqual({ cia: 'other_shift' });
  });
});

describe('classifySector em serviço: turno noturno e a data da véspera', () => {
  it('aceite 18 (parte pura): data da véspera põe na lista quem tem o turno noturno que começou nela', () => {
    // Noturno só na noite de 19/11 (o turno pertence à data em que começa).
    const cycle = {
      startDate: '2026-11-19',
      cycleLength: 2,
      days: [NIGHT.id, null],
    };
    const night = worker('ana', NIGHT, { cycle });
    const filter = { shiftIds: only(NIGHT.id) };
    const eve = run('on_duty', [night], filter, { date: '2026-11-19' });
    expect(verdict(eve)).toEqual({ ana: 'in' });
    expect(eve[0]).toMatchObject({ shiftId: NIGHT.id, shiftName: 'Noturno' });
    expect(verdict(run('on_duty', [night], filter))).toEqual({
      ana: 'day_off',
    });
  });
});

describe('classifySector em serviço: turnos escolhidos (DF6)', () => {
  const chosen = { shiftIds: only(SHIFT_FIRST.id) };

  it('turnos escolhidos: do setor com vínculo e escala noutro turno não aparece', () => {
    const entries = run(
      'on_duty',
      [
        worker('ana', SHIFT_SECOND),
        worker('bia', SHIFT_SECOND, cycleOf(SHIFT_FIRST.id)),
      ],
      chosen,
    );
    // Ana trabalha no 2º turno e só tem vínculo nele: sem relação com o 1º.
    // Bia tem vínculo no 2º, mas a escala a põe no 1º: entra.
    expect(verdict(entries)).toEqual({ bia: 'in' });
  });

  it('turnos escolhidos: folga ou férias com vínculo em turno não escolhido não aparece em serviço', () => {
    const entries = run(
      'on_duty',
      [
        worker('ana', SHIFT_SECOND, cycleOf(null)),
        worker('bia', SHIFT_SECOND, on('VACATION')),
        worker('caio', SHIFT_FIRST, cycleOf(null)),
        worker('duda', SHIFT_FIRST, on('VACATION')),
      ],
      chosen,
    );
    expect(verdict(entries)).toEqual({ caio: 'day_off', duda: 'vacation' });
  });

  it('turnos escolhidos: remanejado para outro setor aparece só se tem relação com os turnos', () => {
    const toS2 = on('OTHER_SECTOR', {
      shiftId: SHIFT_SECOND.id,
      sectorId: 's2',
    });
    const entries = run(
      'on_duty',
      [worker('ana', SHIFT_FIRST, toS2), worker('bia', SHIFT_SECOND, toS2)],
      chosen,
    );
    expect(verdict(entries)).toEqual({ ana: 'other_sector' });
  });
});

describe('classifySector vinculada: setor e turno do vínculo da data', () => {
  it('aceite 3: vinculada sem includeOff — folga sai com Folga; com includeOff entra', () => {
    const people = [
      worker('ana', SHIFT_FIRST),
      worker('bia', SHIFT_FIRST, cycleOf(null)),
    ];
    expect(verdict(run('assigned', people))).toEqual({
      ana: 'in',
      bia: 'day_off',
    });
    const withOff = run('assigned', people, { includeOff: true });
    expect(verdict(withOff)).toEqual({ ana: 'in', bia: 'in' });
  });

  it('vacation sai nas duas bases mesmo com includeOff', () => {
    const people = [worker('ana', SHIFT_FIRST, on('VACATION'))];
    const filter = { includeOff: true, shiftIds: only(SHIFT_FIRST.id) };
    expect(verdict(run('assigned', people, filter))).toEqual({
      ana: 'vacation',
    });
    expect(verdict(run('on_duty', people, filter))).toEqual({
      ana: 'vacation',
    });
  });
});

describe('classifySector vinculada: todos os turnos, troca de turno e folga com turno escolhido', () => {
  it('vinculada com todos os turnos inclui sem turno e turno inativo; com turnos escolhidos só eles', () => {
    const visiting = on('OTHER_SECTOR', {
      shiftId: SHIFT_FIRST.id,
      sectorId: 's1',
    });
    const people = [
      worker('ana', SHIFT_FIRST),
      worker('bia', null),
      worker('caio', OLD),
      worker('dora', SHIFT_FIRST, { sectorId: 's9', ...visiting }),
    ];
    expect(verdict(run('assigned', people))).toEqual({
      ana: 'in',
      bia: 'in',
      caio: 'in',
    });
    const chosen = run('assigned', people, { shiftIds: only(SHIFT_FIRST.id) });
    expect(verdict(chosen)).toEqual({ ana: 'in' });
  });

  it('troca de turno não muda o turno na vinculada', () => {
    const swap = on('SHIFT_SWAP', { shiftId: SHIFT_SECOND.id });
    const people = [worker('ana', SHIFT_FIRST, swap)];
    const first = run('assigned', people, { shiftIds: only(SHIFT_FIRST.id) });
    expect(verdict(first)).toEqual({ ana: 'in' });
    expect(first[0]).toMatchObject({
      shiftId: SHIFT_FIRST.id,
      shiftName: '1º turno',
    });
    const second = run('assigned', people, { shiftIds: only(SHIFT_SECOND.id) });
    expect(second).toEqual([]);
  });

  it('includeOff na vinculada vale com turno escolhido', () => {
    const people = [worker('ana', SHIFT_FIRST, cycleOf(null))];
    const chosen = { shiftIds: only(SHIFT_FIRST.id) };
    expect(verdict(run('assigned', people, chosen))).toEqual({
      ana: 'day_off',
    });
    const withOff = run('assigned', people, { ...chosen, includeOff: true });
    expect(verdict(withOff)).toEqual({ ana: 'in' });
  });
});

describe('classifySector remanejado e nível', () => {
  it('aceite 9: remanejado A→B entra em B em serviço e em A na vinculada', () => {
    const toB = on('OTHER_SECTOR', {
      shiftId: SHIFT_SECOND.id,
      sectorId: 's2',
    });
    const people = [worker('ana', SHIFT_FIRST, toB)];
    const inB = run('on_duty', people, {}, { sector: S2 });
    expect(verdict(inB)).toEqual({ ana: 'in' });
    expect(inB[0]).toMatchObject({ sectorId: 's2', shiftName: '2º turno' });
    expect(verdict(run('on_duty', people))).toEqual({ ana: 'other_sector' });
    expect(verdict(run('assigned', people))).toEqual({ ana: 'in' });
    expect(run('assigned', people, {}, { sector: S2 })).toEqual([]);
  });

  it('nível do vínculo da data filtra nas duas bases', () => {
    const line = {
      sectorId: 's1',
      sector: { isActive: true },
      shiftId: SHIFT_FIRST.id,
      shift: { name: SHIFT_FIRST.name },
      levelId: 'l1',
      level: { id: 'l1', name: 'Pleno' },
    };
    // O espelho diz l2; o vínculo da data diz l1 (Pleno): vale o do vínculo.
    const ana = withAssignmentOn(
      worker('ana', SHIFT_FIRST, { levelId: 'l2' }),
      line,
    );
    const bia = worker('bia', SHIFT_FIRST, { levelId: 'l2' });
    const level = { levelIds: only('l1'), withoutLevel: false };
    for (const base of ['on_duty', 'assigned'] as const) {
      const entries = run(base, [ana, bia], { level });
      expect(verdict(entries)).toEqual({ ana: 'in' });
      expect(entries[0].levelName).toBe('Pleno');
    }
  });

  it('pessoa inativa não aparece', () => {
    const people = [worker('ana', SHIFT_FIRST, { isActive: false })];
    expect(run('on_duty', people)).toEqual([]);
    expect(run('assigned', people)).toEqual([]);
  });
});
