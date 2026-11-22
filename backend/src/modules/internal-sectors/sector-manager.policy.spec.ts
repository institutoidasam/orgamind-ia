import type { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../../shared/errors/domain.error';
import {
  assertManagerChangeAllowed,
  canSetSectorManager,
} from './sector-manager.policy';

const actor = (role: Role) => ({ id: `u-${role}`, role });
const ADMIN_ONLY = {
  status: 403,
  code: 'sector.manager_admin_only',
  message: 'Só o administrador escolhe o gestor do setor.',
  detail: undefined,
};

describe('canSetSectorManager', () => {
  it('canSetSectorManager: só ADMIN', () => {
    expect(canSetSectorManager(actor('ADMIN'))).toBe(true);
    for (const role of ['SUPERVISOR', 'OPERATOR', 'VIEWER'] as const) {
      expect(canSetSectorManager(actor(role))).toBe(false);
    }
  });
});

describe('assertManagerChangeAllowed — quem não é ADMIN', () => {
  const supervisor = actor('SUPERVISOR');

  it('SUPERVISOR: managerId ausente ou igual ao atual passa', () => {
    expect(() =>
      assertManagerChangeAllowed(supervisor, undefined, 'm-1'),
    ).not.toThrow();
    expect(() =>
      assertManagerChangeAllowed(supervisor, 'm-1', 'm-1'),
    ).not.toThrow();
    expect(() =>
      assertManagerChangeAllowed(supervisor, null, null),
    ).not.toThrow();
    expect(() =>
      assertManagerChangeAllowed(supervisor, undefined, null),
    ).not.toThrow();
  });

  it('SUPERVISOR: managerId diferente do atual lança 403 sector.manager_admin_only com o texto', () => {
    const attempts: [string | null, string | null][] = [
      ['m-2', 'm-1'],
      [null, 'm-1'],
      ['m-2', null],
    ];
    for (const [requested, current] of attempts) {
      const act = () =>
        assertManagerChangeAllowed(supervisor, requested, current);
      expect(act).toThrow(ForbiddenError);
      expect(act).toThrow(expect.objectContaining(ADMIN_ONLY));
    }
  });
});

describe('assertManagerChangeAllowed — ADMIN', () => {
  it('ADMIN troca o gestor', () => {
    const admin = actor('ADMIN');
    expect(() => assertManagerChangeAllowed(admin, 'm-2', 'm-1')).not.toThrow();
    expect(() => assertManagerChangeAllowed(admin, null, 'm-1')).not.toThrow();
    expect(() => assertManagerChangeAllowed(admin, 'm-2', null)).not.toThrow();
  });
});
