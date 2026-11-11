import { describe, expect, it } from 'vitest';
import {
  buildSectorTarget, eligibleMembers, filterByLevel, leftOutPeople, noScheduleCount, offMembers,
} from './member-filter';
import type { RosterMember } from './schemas';

type Situation = RosterMember['situation'];

const work = (shiftId: string): Situation => ({ kind: 'WORK', sectorId: 's1', shiftId, source: 'CYCLE' });
const OFF: Situation = { kind: 'OFF', reason: 'VACATION', source: 'EXCEPTION' };
const NONE: Situation = { kind: 'NONE' };

function member(id: string, situation: Situation, extra: Partial<RosterMember> = {}): RosterMember {
  return {
    id, name: id, email: `${id}@x.test`, phoneE164: `+55929${id.length}`, isActive: true,
    jobTitle: null, fromOtherSector: false, situation, level: null, ...extra,
  };
}

const members = [
  member('ana', work('manha')),
  member('joao', work('noite')),
  member('visita', work('noite'), { fromOtherSector: true }),
  member('maria', OFF),
  member('ze', NONE),
  member('lia', work('noite'), { isActive: false }),
];
const ids = (list: RosterMember[]) => list.map((m) => m.id);

describe('eligibleMembers', () => {
  it.each([
    ['turno lista só o WORK daquele turno', ['noite'], false, ['joao', 'visita']],
    ['dois turnos listam o WORK de qualquer um deles', ['manha', 'noite'], false, ['ana', 'joao', 'visita']],
    ['sem turnos (todos) lista todo WORK e deixa o NONE de fora', [], false, ['ana', 'joao', 'visita']],
    ['sem turnos com includeOff acrescenta quem está de folga', [], true, ['ana', 'joao', 'visita', 'maria']],
    ['turno específico ignora includeOff', ['noite'], true, ['joao', 'visita']],
  ])('%s', (_name, shiftIds, includeOff, expected) => {
    expect(ids(eligibleMembers(members, shiftIds, includeOff))).toEqual(expected);
  });
});

describe('grupos informativos', () => {
  it('offMembers exclui visitantes', () => {
    const visitorOff = member('rui', OFF, { fromOtherSector: true });
    expect(ids(offMembers([...members, visitorOff]))).toEqual(['maria']);
  });

  it('noScheduleCount conta NONE', () => {
    expect(noScheduleCount(members)).toBe(1);
  });
});

describe('filterByLevel', () => {
  const coord = { id: 'level_coordinator', name: 'Coordenador' };
  const staff = [
    member('ana', work('manha'), { level: coord }),
    member('joao', work('manha'), { level: { id: 'level_employee', name: 'Funcionário' } }),
    member('maria', OFF, { level: coord }),
    member('ze', work('manha')),
  ];
  it.each([
    ['sem filtro, todos', [], false, ['ana', 'joao', 'maria', 'ze']],
    ['Coordenador, só coordenadores (inclusive de folga)', ['level_coordinator'], false, ['ana', 'maria']],
    ['Sem nível, só sem nível', [], true, ['ze']],
    ['Coordenador e Sem nível juntos', ['level_coordinator'], true, ['ana', 'maria', 'ze']],
  ])('%s', (_name, levelIds, withoutLevel, expected) => {
    expect(ids(filterByLevel(staff, { levelIds, withoutLevel }))).toEqual(expected);
  });
});

const none = { levelIds: [], withoutLevel: false };
const levels = [{ id: 'l1', name: 'Coordenador' }, { id: 'l2', name: 'Funcionário' }];

const shifts = [
  { id: 'manha', name: 'Manhã' },
  { id: 'tarde', name: 'Tarde' },
  { id: 'noite', name: 'Noite' },
];

describe('buildSectorTarget', () => {
  const base = {
    sectors: [{ id: 's1', name: 'Produção', members }], levels, levelFilter: none, shifts, date: '2026-10-21',
  };

  it('seleção: label com data e seleção, userIds, só o escolhido como destinatário e o resto como não selecionado', () => {
    const target = buildSectorTarget({ ...base, shiftIds: ['noite'], includeOff: false, selectedIds: ['joao'] });
    expect(target).toEqual({
      type: 'sector', sectorIds: ['s1'], levelIds: [], withoutLevel: false, date: '2026-10-21', shiftIds: ['noite'],
      includeOff: false, label: 'Produção · Noite · 21/10 · seleção de 1', userIds: ['joao'],
      recipients: [{ id: 'joao', name: 'joao' }], leftOut: [{ name: 'visita', reason: 'unselected' }],
    });
  });

  it('todos os turnos com folga: sem shiftIds, sem userIds, e sem telefone fica de fora', () => {
    const semFone = member('pedro', work('noite'), { phoneE164: null });
    const target = buildSectorTarget({
      ...base, sectors: [{ id: 's1', name: 'Produção', members: [...members, semFone] }],
      shiftIds: [], includeOff: true, selectedIds: null,
    });
    expect(target).toMatchObject({
      shiftIds: [], includeOff: true, userIds: null, label: 'Produção · todos os turnos · 21/10',
      leftOut: [{ name: 'pedro', reason: 'no_phone' }],
    });
    expect(target.type === 'sector' && target.recipients.map((r) => r.id)).toEqual(['ana', 'joao', 'visita', 'maria']);
  });

  it('includeOff só vale sem turnos escolhidos', () => {
    const target = buildSectorTarget({ ...base, shiftIds: ['noite'], includeOff: true, selectedIds: null });
    expect(target).toMatchObject({ shiftIds: ['noite'], includeOff: false });
  });

  it('vários turnos: rótulo na ordem dos turnos, até dois nomes e +N, e quem trabalha em qualquer um recebe', () => {
    const two = buildSectorTarget({ ...base, shiftIds: ['noite', 'manha'], includeOff: false, selectedIds: null });
    expect(two).toMatchObject({ shiftIds: ['noite', 'manha'], label: 'Produção · Manhã, Noite · 21/10' });
    expect(two.type === 'sector' && two.recipients.map((r) => r.id)).toEqual(['ana', 'joao', 'visita']);
    const three = buildSectorTarget({ ...base, shiftIds: ['manha', 'tarde', 'noite'], includeOff: false, selectedIds: null });
    expect(three).toMatchObject({ label: 'Produção · Manhã, Tarde +1 · 21/10' });
  });

});

describe('buildSectorTarget: setores e níveis', () => {
  it('vários setores e níveis: rótulo com dois nomes + N, Sem nível por último, e só o nível escolhido recebe', () => {
    const coord = { id: 'l1', name: 'Coordenador' };
    const sector = (id: string, name: string, level: typeof coord | null) =>
      ({ id, name, members: [member(`${id}-c`, work('noite'), { level }), member(`${id}-x`, work('noite'))] });
    const target = buildSectorTarget({
      sectors: [sector('rh', 'RH', coord), sector('ti', 'TI', coord), sector('op', 'Operação', coord)],
      levels, levelFilter: { levelIds: ['l1'], withoutLevel: true }, shifts,
      date: '2026-10-21', shiftIds: ['noite'], includeOff: false, selectedIds: null,
    });
    expect(target).toMatchObject({
      sectorIds: ['rh', 'ti', 'op'], levelIds: ['l1'], withoutLevel: true,
      label: 'Operação, RH +1 · Coordenador, Sem nível · Noite · 21/10',
    });
    expect(target.type === 'sector' && target.recipients).toHaveLength(6);
  });
});

describe('leftOutPeople', () => {
  const list = [
    member('ana', work('noite')),
    member('bruno', work('noite'), { phoneE164: null }),
    member('caio', work('noite')),
  ];

  it('com seleção: quem tem telefone e não foi marcado é "unselected"; sem telefone é "no_phone"; na ordem da lista', () => {
    expect(leftOutPeople(list, ['caio'])).toEqual([
      { name: 'ana', reason: 'unselected' },
      { name: 'bruno', reason: 'no_phone' },
    ]);
  });

  it('enviar para todos: só quem não tem telefone fica de fora', () => {
    expect(leftOutPeople(list, null)).toEqual([{ name: 'bruno', reason: 'no_phone' }]);
  });
});
