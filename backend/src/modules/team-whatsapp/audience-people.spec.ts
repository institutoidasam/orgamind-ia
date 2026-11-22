import { beforeEach, describe, expect, it } from 'vitest';
import { classifyPeople, shiftNamesOf } from './audience-people';
import {
  DATE,
  NIGHT,
  S1,
  S2,
  createAudienceHarness,
  givenPeople,
  on,
  person,
  request,
  verdict,
  type AudienceHarness,
} from './team-audience.test-fixtures';
import { buildAudience } from './team-whatsapp.audience';
import type { TeamMemberWithSchedule } from './team-whatsapp.repository';
import { SHIFT_FIRST, SHIFT_SECOND } from './team-whatsapp.test-fixtures';

let h: AudienceHarness;
beforeEach(() => {
  h = createAudienceHarness();
});

const ACTIVE = [SHIFT_FIRST, SHIFT_SECOND, NIGHT];
const COORD = { id: 'lv-coord', name: 'Coordenador' };
const ANALISTA = { id: 'lv-ana', name: 'Analista' };

type PeopleInput = Parameters<typeof classifyPeople>[0];

/** O público de `classifyPeople` + `buildAudience`, resumido como o da prévia: id → motivo (`in` = recebe). */
function classified(
  bySector: Record<string, TeamMemberWithSchedule[]>,
  over: Partial<PeopleInput> = {},
): Record<string, string> {
  const people = new Map(Object.entries(bySector));
  const { included, excluded } = buildAudience({
    sectors: classifyPeople({
      base: 'on_duty',
      includeOff: false,
      date: DATE,
      sectors: [S1, S2],
      shiftIds: null,
      shiftNames: shiftNamesOf(ACTIVE, [...people.values()].flat()),
      level: null,
      people,
      ...over,
    }),
    userIds: undefined,
  });
  return Object.fromEntries<string>([
    ...included.map((e): [string, string] => [e.member.id, 'in']),
    ...excluded.map((e): [string, string] => [e.member.id, e.reason ?? 'in']),
  ]);
}

describe('classifyPeople — o mesmo público da prévia (aceite 21 a 39)', () => {
  it('classifyPeople dá o mesmo resultado que a prévia para o mesmo escopo', async () => {
    const bySector = {
      s1: [
        person('ana'),
        person('bia', SHIFT_FIRST, on('DAY_OFF')),
        person('davi', SHIFT_SECOND),
        person('caio', SHIFT_FIRST, on('VACATION')),
      ],
      s2: [person('eva', SHIFT_FIRST, { sectorId: S2.id })],
    };
    givenPeople(h, bySector);

    const all = await h.service.preview(
      'a',
      request({ target: { sectorIds: [S1.id, S2.id] } }),
    );
    const firstShift = await h.service.preview(
      'a',
      request({
        target: { sectorIds: [S1.id, S2.id], shiftIds: [SHIFT_FIRST.id] },
      }),
    );

    expect(classified(bySector)).toEqual(verdict(all));
    expect(classified(bySector, { shiftIds: [] })).toEqual(verdict(all));
    expect(classified(bySector, { shiftIds: [SHIFT_FIRST.id] })).toEqual(
      verdict(firstShift),
    );
    expect(classified(bySector)).toMatchObject({
      ana: 'in',
      eva: 'in',
      bia: 'day_off',
      caio: 'vacation',
    });
  });
});

describe('shiftNamesOf — nomes dos turnos da escala', () => {
  const OLD = { id: 'shift_old', name: 'Turno antigo' };

  it('shiftNamesOf inclui turno inativo do vínculo', () => {
    const names = shiftNamesOf(
      [SHIFT_FIRST],
      [
        person('ana', OLD),
        person('bia', { id: SHIFT_FIRST.id, name: 'Nome velho' }),
        person('caio', null),
      ],
    );

    expect([...names]).toEqual([
      [OLD.id, OLD.name],
      [SHIFT_FIRST.id, SHIFT_FIRST.name],
    ]);
  });
});

describe('classifyPeople — filtro de nível (C5)', () => {
  it('filtro de nível e sem nível iguais aos da prévia', async () => {
    const bySector = {
      s1: [
        person('ana', SHIFT_FIRST, { levelId: COORD.id }),
        person('bia', SHIFT_FIRST, { levelId: ANALISTA.id }),
        person('caio'),
      ],
    };
    givenPeople(h, bySector);
    h.levels.listActive.mockResolvedValue([COORD, ANALISTA]);

    const picked = await h.service.preview(
      'a',
      request({ target: { levelIds: [COORD.id], withoutLevel: true } }),
    );
    const noLevel = await h.service.preview(
      'a',
      request({ target: { withoutLevel: true } }),
    );

    const level = (levelIds: string[], withoutLevel: boolean) => ({
      level: { levelIds: new Set(levelIds), withoutLevel },
    });
    expect(classified(bySector, level([COORD.id], true))).toEqual(
      verdict(picked),
    );
    expect(classified(bySector, level([], true))).toEqual(verdict(noLevel));
    expect(verdict(picked)).toEqual({ ana: 'in', caio: 'in' });
    expect(verdict(noLevel)).toEqual({ caio: 'in' });
  });
});
