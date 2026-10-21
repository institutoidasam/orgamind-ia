import { describe, expect, it } from 'vitest';
import { buildSectorTarget, eligibleMembers, noScheduleCount, offMembers } from './member-filter';
import type { RosterMember } from './schemas';

type Situation = RosterMember['situation'];

const work = (shiftId: string): Situation => ({ kind: 'WORK', sectorId: 's1', shiftId, source: 'CYCLE' });
const OFF: Situation = { kind: 'OFF', reason: 'VACATION', source: 'EXCEPTION' };
const NONE: Situation = { kind: 'NONE' };

function member(id: string, situation: Situation, extra: Partial<RosterMember> = {}): RosterMember {
  return {
    id, name: id, email: `${id}@x.test`, phoneE164: `+55929${id.length}`, isActive: true,
    jobTitle: null, fromOtherSector: false, situation, ...extra,
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
    ['turno lista só o WORK daquele turno', 'noite', false, ['joao', 'visita']],
    ['ALL lista todo WORK e deixa o NONE de fora', 'ALL', false, ['ana', 'joao', 'visita']],
    ['ALL com includeOff acrescenta quem está de folga', 'ALL', true, ['ana', 'joao', 'visita', 'maria']],
    ['turno específico ignora includeOff', 'noite', true, ['joao', 'visita']],
  ])('%s', (_name, choice, includeOff, expected) => {
    expect(ids(eligibleMembers(members, choice, includeOff))).toEqual(expected);
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

describe('buildSectorTarget', () => {
  const base = { sectorId: 's1', sectorName: 'Produção', shiftName: 'Noite', date: '2026-10-21', members };

  it('seleção: label com data e seleção, userIds e só os escolhidos como destinatários', () => {
    const target = buildSectorTarget({ ...base, choice: 'noite', includeOff: false, selectedIds: ['joao'] });
    expect(target).toEqual({
      type: 'sector', sectorId: 's1', date: '2026-10-21', shiftId: 'noite', includeOff: false,
      label: 'Produção · Noite · 21/10 · seleção de 1', userIds: ['joao'],
      recipients: [{ id: 'joao', name: 'joao' }], leftOut: [],
    });
  });

  it('todos os turnos com folga: sem shiftId, sem userIds, e sem telefone fica de fora', () => {
    const semFone = member('pedro', work('noite'), { phoneE164: null });
    const target = buildSectorTarget({
      ...base, shiftName: null, choice: 'ALL', includeOff: true, selectedIds: null, members: [...members, semFone],
    });
    expect(target).toMatchObject({
      shiftId: null, includeOff: true, userIds: null, label: 'Produção · todos os turnos · 21/10',
      leftOut: [{ id: 'pedro', name: 'pedro' }],
    });
    expect(target.type === 'sector' && target.recipients.map((r) => r.id)).toEqual(['ana', 'joao', 'visita', 'maria']);
  });

  it('includeOff só vale em todos os turnos', () => {
    const target = buildSectorTarget({ ...base, choice: 'noite', includeOff: true, selectedIds: null });
    expect(target).toMatchObject({ shiftId: 'noite', includeOff: false });
  });
});
