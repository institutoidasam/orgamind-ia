import { describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import {
  actorWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import { defaultPermissionsFor } from '../../shared/authz/permissions';
import { DomainError } from '../../shared/errors/domain.error';
import type { TeamPurpose } from '../../schemas/contracts/team-whatsapp.schema';
import { requireUrgencyFor, requireUrgencyKey } from './team-alert.policy';
import type { TeamActor } from './team-whatsapp.policy';

const URGENCY_DENIED = 'Você não tem permissão para criar alerta urgente.';

function teamActor(role: Role, change: PermissionChange = {}): TeamActor {
  return { ...actorWith(role, change), managedSectorIds: ['s1'] };
}

function deniedBy(run: () => void): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('esperava 403 e passou');
}

describe('team-alert policy — portão da chave equipe.urgencia (I1/DI2)', () => {
  const OTHER_PURPOSES: readonly (TeamPurpose | undefined)[] = [
    'shift_notice',
    'meeting',
    'alignment',
    'lecture',
    'overtime',
    undefined,
  ];

  it('Urgência sem a chave — 403 auth.permission_denied com o texto da chave', () => {
    const error = deniedBy(() =>
      requireUrgencyFor(teamActor('SUPERVISOR'), 'urgency'),
    );

    expect(error.status).toBe(403);
    expect(error.code).toBe('auth.permission_denied');
    expect(error.detail).toBe(URGENCY_DENIED);
  });

  it('Urgência com a chave, e outras finalidades sem ela — passa', () => {
    const granted = teamActor('SUPERVISOR', { grant: ['equipe.urgencia'] });
    const without = teamActor('OPERATOR');

    expect(() => requireUrgencyFor(granted, 'urgency')).not.toThrow();
    for (const purpose of OTHER_PURPOSES) {
      expect(() => requireUrgencyFor(without, purpose)).not.toThrow();
    }
  });

  it('requireUrgencyKey sem a chave — 403', () => {
    const error = deniedBy(() => requireUrgencyKey(teamActor('OPERATOR')));

    expect(error.status).toBe(403);
    expect(error.code).toBe('auth.permission_denied');
    expect(error.detail).toBe(URGENCY_DENIED);
    expect(() =>
      requireUrgencyKey(teamActor('OPERATOR', { grant: ['equipe.urgencia'] })),
    ).not.toThrow();
  });
});

describe('team-alert policy — a chave equipe.urgencia no catálogo (DI2)', () => {
  it('ADMIN tem a chave pelo catálogo (defaultPermissionsFor)', () => {
    expect(defaultPermissionsFor('ADMIN')).toContain('equipe.urgencia');
    expect(() =>
      requireUrgencyFor(teamActor('ADMIN'), 'urgency'),
    ).not.toThrow();
  });

  it('SUPERVISOR e OPERATOR não têm a chave no padrão', () => {
    expect(defaultPermissionsFor('SUPERVISOR')).not.toContain(
      'equipe.urgencia',
    );
    expect(defaultPermissionsFor('OPERATOR')).not.toContain('equipe.urgencia');
  });
});
