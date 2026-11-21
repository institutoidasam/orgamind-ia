import { describe, expect, it } from 'vitest';
import { actorWith } from '../../shared/authz/actor.test-fixtures';
import {
  canHandoverPendenciesFrom,
  handoverSkipOf,
  isPendencyHandoverTarget,
} from './team-pendency-handover.rules';
import type { TeamActor } from './team-whatsapp.policy';

const dest = (over: Partial<TeamActor> = {}): TeamActor => ({
  ...actorWith('OPERATOR', { id: 'bia' }),
  managedSectorIds: ['s1'],
  ...over,
});

describe('canHandoverPendenciesFrom — quem pode passar as pendências de alguém (K3-4)', () => {
  it('próprio; ADMIN de outro; SUPERVISOR de outro não', () => {
    expect(
      canHandoverPendenciesFrom({ id: 'ana', role: 'SUPERVISOR' }, 'ana'),
    ).toBe(true);
    expect(canHandoverPendenciesFrom({ id: 'zed', role: 'ADMIN' }, 'ana')).toBe(
      true,
    );
    expect(
      canHandoverPendenciesFrom({ id: 'sup', role: 'SUPERVISOR' }, 'ana'),
    ).toBe(false);
  });
});

describe('isPendencyHandoverTarget — quem pode receber (K3-4, K2-7)', () => {
  it('nulo, inativo, sem acesso, não remetente, sem equipe.enviar, igual a quem sai → falso; remetente ativo com equipe.enviar → verdadeiro', () => {
    expect(isPendencyHandoverTarget(null, 'ana')).toBe(false);
    expect(isPendencyHandoverTarget(dest({ isActive: false }), 'ana')).toBe(
      false,
    );
    expect(isPendencyHandoverTarget(dest({ hasAccess: false }), 'ana')).toBe(
      false,
    );
    expect(
      isPendencyHandoverTarget(dest({ managedSectorIds: [] }), 'ana'),
    ).toBe(false);
    expect(isPendencyHandoverTarget(dest({ permissions: [] }), 'ana')).toBe(
      false,
    );
    expect(isPendencyHandoverTarget(dest({ id: 'ana' }), 'ana')).toBe(false);
    expect(isPendencyHandoverTarget(dest(), 'ana')).toBe(true);
    const admin = dest({
      ...actorWith('ADMIN', { id: 'zed' }),
      managedSectorIds: [],
    });
    expect(isPendencyHandoverTarget(admin, 'ana')).toBe(true);
  });
});

describe('handoverSkipOf — motivo do pulo da pendência (DT4.4)', () => {
  it('acked, closed, missing; handler_changed com responsável atual = destino → already_with_target; com outro ou null → other_handler', () => {
    expect(handoverSkipOf('acked', 'ana', 'bia')).toBe('acked');
    expect(handoverSkipOf('closed', 'ana', 'bia')).toBe('closed');
    expect(handoverSkipOf('missing', undefined, 'bia')).toBe('not_found');
    expect(handoverSkipOf('handler_changed', 'bia', 'bia')).toBe(
      'already_with_target',
    );
    expect(handoverSkipOf('handler_changed', 'caio', 'bia')).toBe(
      'other_handler',
    );
    expect(handoverSkipOf('handler_changed', null, 'bia')).toBe(
      'other_handler',
    );
  });
});
