import { describe, expect, it } from 'vitest';
import {
  eligibleAcross,
  eligibleFor,
  passesLevel,
  sectorTargetLabel,
  shiftsLabel,
  type DayMember,
  type DispatchFilter,
  type LevelFilter,
} from './team-whatsapp.roster';
import { dayPerson } from './team-whatsapp.test-fixtures';

type LabelInput = Parameters<typeof sectorTargetLabel>[0];

const label = (over: Partial<LabelInput>): string =>
  sectorTargetLabel({
    sectorNames: ['Produção'],
    levelNames: [],
    shiftName: null,
    date: '2026-10-21',
    selected: null,
    ...over,
  });

describe('sectorTargetLabel (GC12)', () => {
  it.each<[string, Partial<LabelInput>, string]>([
    [
      'um setor sem nível = rótulo de hoje, com seleção',
      { shiftName: 'Noite', selected: 2 },
      'Produção · Noite · 21/10 · seleção de 2',
    ],
    ['um setor, todos os turnos', {}, 'Produção · todos os turnos · 21/10'],
    [
      'dois setores por vírgula',
      { sectorNames: ['Operação', 'TI'] },
      'Operação, TI · todos os turnos · 21/10',
    ],
    [
      'três setores: dois primeiros + 1',
      { sectorNames: ['Logística', 'Operação', 'RH'], shiftName: 'Noite' },
      'Logística, Operação +1 · Noite · 21/10',
    ],
    [
      'quatro setores e um nível',
      {
        sectorNames: ['Logística', 'Operação', 'RH', 'TI'],
        levelNames: ['Coordenador'],
        shiftName: 'Noite',
        date: '2026-10-22',
      },
      'Logística, Operação +2 · Coordenador · Noite · 22/10',
    ],
    [
      'Sem nível por último, com seleção',
      { levelNames: ['Analista', 'Sem nível'], selected: 3 },
      'Produção · Analista, Sem nível · todos os turnos · 21/10 · seleção de 3',
    ],
  ])('%s', (_caso, over, expected) => {
    expect(label(over)).toBe(expected);
  });
});

describe('passesLevel (C5)', () => {
  const COORD = 'lvl-coord';
  const only = (ids: string[], withoutLevel: boolean): LevelFilter => ({
    levelIds: new Set(ids),
    withoutLevel,
  });
  it.each<[string, LevelFilter, string | null, boolean]>([
    ['sem filtro × coordenador → passa', null, COORD, true],
    ['lista vazia e sem withoutLevel = todos', only([], false), null, true],
    ['Coordenador × coordenador → passa', only([COORD], false), COORD, true],
    ['Coordenador × sem nível → não passa', only([COORD], false), null, false],
    ['withoutLevel × sem nível → passa', only([], true), null, true],
    ['withoutLevel × coordenador → não passa', only([], true), COORD, false],
    ['os dois × coordenador → passa', only([COORD], true), COORD, true],
    ['os dois × sem nível → passa', only([COORD], true), null, true],
  ])('%s', (_caso, filter, levelId, expected) => {
    expect(passesLevel({ levelId }, filter)).toBe(expected);
  });
});

describe('eligibleFor com vários turnos (D9)', () => {
  const work = (shiftId: string): DayMember['situation'] => ({
    kind: 'WORK',
    sectorId: 's1',
    shiftId,
    source: 'PROFILE',
  });
  const off: DayMember['situation'] = {
    kind: 'OFF',
    reason: 'DAY_OFF',
    source: 'CYCLE',
  };
  const DN = new Set(['dia', 'noite']);
  const only = (includeOff: boolean) => ({ shiftIds: DN, includeOff });
  const all = { shiftIds: null, includeOff: true };

  it.each<[string, DayMember['situation'], DispatchFilter, boolean]>([
    ['WORK no Dia passa', work('dia'), only(false), true],
    ['WORK na Noite passa', work('noite'), only(false), true],
    [
      'WORK fora dos turnos pedidos não passa',
      work('manha'),
      only(false),
      false,
    ],
    ['OFF não passa', off, only(false), false],
    [
      'OFF não passa nem com includeOff (só em todos os turnos)',
      off,
      only(true),
      false,
    ],
    ['todos os turnos (null) + includeOff: OFF passa', off, all, true],
  ])('%s', (_caso, situation, filter, expected) => {
    const member = { ...dayPerson(), fromOtherSector: false, situation };
    expect(eligibleFor([member], filter)).toHaveLength(expected ? 1 : 0);
  });
});

describe('shiftsLabel (D9)', () => {
  it.each<[string[], string | null]>([
    [[], null],
    [['Noite'], 'Noite'],
    [['Dia', 'Noite'], 'Dia, Noite'],
    [['Dia', 'Noite', 'Madrugada'], 'Dia, Noite +1'],
  ])('%j → %s', (names, expected) => {
    expect(shiftsLabel(names)).toBe(expected);
  });
});

describe('eligibleAcross com vários turnos e setores (D9)', () => {
  const ana: DayMember = {
    ...dayPerson({ id: 'ana', name: 'Ana' }),
    fromOtherSector: false,
    situation: {
      kind: 'WORK',
      sectorId: 'ti',
      shiftId: 'noite',
      source: 'PROFILE',
    },
  };

  it('pessoa que aparece nos dois setores conta uma vez, no primeiro', () => {
    const days = [
      { sectorId: 'op', sectorName: 'Operação', members: [ana] },
      { sectorId: 'ti', sectorName: 'TI', members: [ana] },
    ];
    const result = eligibleAcross(days, {
      shiftIds: new Set(['dia', 'noite']),
      includeOff: false,
    });
    expect(result.map((m) => [m.id, m.inSector.sectorId])).toEqual([
      ['ana', 'op'],
    ]);
  });
});
