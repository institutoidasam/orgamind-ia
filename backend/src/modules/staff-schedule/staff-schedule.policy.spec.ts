import { describe, expect, it } from 'vitest';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import {
  canAssignSector,
  canEditPerson,
  canViewSchedule,
  viewableSectorIds,
} from './staff-schedule.policy';

const PROD = 'sector-prod';
const LOG = 'sector-log';

function actor(
  role: TeamActor['role'],
  managedSectorIds: string[] = [],
): TeamActor {
  return {
    id: `actor-${role}`,
    role,
    isActive: true,
    hasAccess: true,
    managedSectorIds,
  };
}

const ADMIN = actor('ADMIN');
const BOSS_PROD = actor('SUPERVISOR', [PROD]);
const BOSS_LOG = actor('OPERATOR', [LOG]);
const PLAIN = actor('OPERATOR');

describe('política da escala (GC8)', () => {
  it.each([
    ['ADMIN', ADMIN, true, null],
    ['gestor de Produção', BOSS_PROD, true, [PROD]],
    ['gestor de Logística', BOSS_LOG, true, [LOG]],
    ['operador sem setor gerenciado', PLAIN, false, []],
  ] as const)('%s: ver escala', (_label, who, canView, sectors) => {
    expect(canViewSchedule(who)).toBe(canView);
    expect(viewableSectorIds(who)).toEqual(sectors);
  });

  it('ADMIN ou gestor inativo não vê a escala', () => {
    expect(canViewSchedule({ ...ADMIN, isActive: false })).toBe(false);
    expect(viewableSectorIds({ ...BOSS_PROD, isActive: false })).toEqual([]);
  });

  it.each([
    ['ADMIN', ADMIN, [true, true, true]],
    ['gestor de Produção', BOSS_PROD, [true, false, false]],
    ['gestor de Logística', BOSS_LOG, [false, true, false]],
    ['operador sem setor gerenciado', PLAIN, [false, false, false]],
  ] as const)(
    '%s: editar pessoa de Produção, de Logística, sem setor',
    (_label, who, expected) => {
      const people = [
        { sectorId: PROD },
        { sectorId: LOG },
        { sectorId: null },
      ];
      expect(people.map((p) => canEditPerson(who, p))).toEqual(expected);
    },
  );

  it.each([
    ['ADMIN', ADMIN, [true, true, false]],
    ['gestor de Produção', BOSS_PROD, [true, false, false]],
    ['gestor de Logística', BOSS_LOG, [false, true, false]],
    ['operador sem setor gerenciado', PLAIN, [false, false, false]],
  ] as const)(
    '%s: destino Produção ativa, Logística ativa, setor inativo',
    (_label, who, expected) => {
      const sectors = [
        { id: PROD, isActive: true },
        { id: LOG, isActive: true },
        { id: 'sector-old', isActive: false },
      ];
      expect(sectors.map((s) => canAssignSector(who, s))).toEqual(expected);
    },
  );
});
