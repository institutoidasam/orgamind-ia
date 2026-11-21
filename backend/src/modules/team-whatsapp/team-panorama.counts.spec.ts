import { describe, expect, it } from 'vitest';
import type { DaySituation } from '../staff-schedule/schedule-resolver';
import { panoramaCounts } from './team-panorama.counts';
import type { DayMember } from './team-whatsapp.roster';
import type { TeamMember } from './team-whatsapp.repository';
import { member } from './team-whatsapp.test-fixtures';

const ACTIVE = ['manha', 'noite'];

const work = (shiftId: string): DaySituation => ({
  kind: 'WORK',
  sectorId: 's1',
  shiftId,
  source: 'CYCLE',
});
const off = (reason: 'DAY_OFF' | 'VACATION'): DaySituation => ({
  kind: 'OFF',
  reason,
  source: 'CYCLE',
});
const NONE: DaySituation = { kind: 'NONE' };

const dayMember = (
  situation: DaySituation,
  over: Partial<TeamMember> = {},
): DayMember => ({
  ...member(over),
  jobTitle: null,
  levelId: null,
  level: null,
  fromOtherSector: false,
  situation,
});

const noGaps = {
  otherShifts: 0,
  dayOff: 0,
  vacation: 0,
  noSchedule: 0,
  noPhone: 0,
  notAuthorized: 0,
};

describe('panoramaCounts — situação do dia (aceite 4)', () => {
  it('aceite 4: em serviço por turno ativo, com zero nos turnos sem ninguém, na ordem dos turnos', () => {
    const counts = panoramaCounts(
      [dayMember(work('noite')), dayMember(work('noite'))],
      ACTIVE,
    );

    expect(counts).toEqual({
      ...noGaps,
      byShift: [
        { shiftId: 'manha', count: 0 },
        { shiftId: 'noite', count: 2 },
      ],
    });
  });

  it('aceite 4: WORK em turno inativo conta em otherShifts', () => {
    const counts = panoramaCounts(
      [dayMember(work('manha')), dayMember(work('extinto'))],
      ACTIVE,
    );

    expect(counts.otherShifts).toBe(1);
    expect(counts.byShift).toEqual([
      { shiftId: 'manha', count: 1 },
      { shiftId: 'noite', count: 0 },
    ]);
  });

  it('aceite 4: folga, férias e sem escala', () => {
    const counts = panoramaCounts(
      [
        dayMember(off('DAY_OFF')),
        dayMember(off('DAY_OFF')),
        dayMember(off('VACATION')),
        dayMember(NONE),
      ],
      ACTIVE,
    );

    expect(counts).toMatchObject({ dayOff: 2, vacation: 1, noSchedule: 1 });
    expect(counts.byShift.map((s) => s.count)).toEqual([0, 0]);
  });
});

describe('panoramaCounts — contato entre os em serviço (aceite 4)', () => {
  it('aceite 4: sem telefone e sem autorização só entre os em serviço; quem não tem telefone não conta também como sem autorização', () => {
    const noPhoneAndUnauthorized = {
      phoneE164: null,
      contactAuthorization: 'NAO_AUTORIZADO',
    } as const;
    const counts = panoramaCounts(
      [
        dayMember(work('manha'), noPhoneAndUnauthorized),
        dayMember(work('extinto'), { phoneE164: null }),
        dayMember(work('noite'), { contactAuthorization: 'NAO_AUTORIZADO' }),
        dayMember(off('DAY_OFF'), noPhoneAndUnauthorized),
        dayMember(NONE, noPhoneAndUnauthorized),
      ],
      ACTIVE,
    );

    expect(counts).toMatchObject({ noPhone: 2, notAuthorized: 1 });
  });

  it('telefone do contato ligado vale como telefone (sendPhoneOf)', () => {
    const counts = panoramaCounts(
      [
        dayMember(work('manha'), {
          phoneE164: null,
          contact: { phoneE164: '+5592991110001' },
        }),
      ],
      ACTIVE,
    );

    expect(counts.noPhone).toBe(0);
    expect(counts.notAuthorized).toBe(0);
  });

  it('CADASTRO_ANTERIOR autorizado não conta como sem autorização', () => {
    const counts = panoramaCounts(
      [
        dayMember(work('manha'), {
          contactAuthorization: 'AUTORIZADO',
          authorizationSource: 'CADASTRO_ANTERIOR',
        }),
      ],
      ACTIVE,
    );

    expect(counts.notAuthorized).toBe(0);
  });
});
