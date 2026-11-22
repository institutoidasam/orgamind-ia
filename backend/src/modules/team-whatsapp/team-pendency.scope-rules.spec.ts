import { describe, expect, it } from 'vitest';
import {
  actorWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import {
  canHandlePendency,
  effectiveSectorId,
  handlerStateOf,
  pendencyScopeOf,
  scopeAllows,
  type PendencyScopeFacts,
} from './team-pendency.rules';
import type { TeamActor } from './team-whatsapp.policy';

type ActorInput = {
  role?: 'ADMIN' | 'SUPERVISOR' | 'OPERATOR' | 'VIEWER';
  id?: string;
  managed?: readonly string[];
  change?: PermissionChange;
  off?: Partial<Pick<TeamActor, 'isActive' | 'hasAccess'>>;
};

function teamActor(input: ActorInput = {}): TeamActor {
  const role = input.role ?? 'SUPERVISOR';
  return {
    ...actorWith(role, { id: input.id ?? 'sup1', ...input.change }),
    managedSectorIds: input.managed ?? ['s1'],
    ...input.off,
  };
}

const facts = (over: Partial<PendencyScopeFacts> = {}): PendencyScopeFacts => ({
  isAlert: true,
  authorId: 'autor',
  sectorId: 's1',
  personSectorId: 's9',
  ...over,
});

describe('K2-4: quem não é remetente não vê pendência', () => {
  it('não remetente (VIEWER, sem setor gerido, inativo, sem acesso) — scope none, scopeAllows falso', () => {
    const own = facts({ authorId: 'sup1' });
    const actors: (TeamActor | null)[] = [
      teamActor({ role: 'VIEWER' }),
      teamActor({ managed: [] }),
      teamActor({ off: { isActive: false } }),
      teamActor({ off: { hasAccess: false } }),
      null,
    ];
    for (const actor of actors) {
      const scope = pendencyScopeOf(actor);
      expect(scope).toEqual({ kind: 'none' });
      expect(scopeAllows(scope, own)).toBe(false);
      expect(canHandlePendency(actor, own)).toBe(false);
    }
  });

  it('ADMIN — all; envio que não é alerta — falso mesmo para ADMIN', () => {
    const admin = pendencyScopeOf(teamActor({ role: 'ADMIN', managed: [] }));
    expect(admin).toEqual({ kind: 'all' });
    expect(scopeAllows(admin, facts({ authorId: null, sectorId: null }))).toBe(
      true,
    );
    expect(scopeAllows(admin, facts({ isAlert: false }))).toBe(false);
    const own = pendencyScopeOf(teamActor({ id: 'autor' }));
    expect(scopeAllows(own, facts({ isAlert: false }))).toBe(false);
  });
});

describe('K2-4: alcance limitado (aceites 12 e 13)', () => {
  const scope = pendencyScopeOf(teamActor({ id: 'sup1', managed: ['s1'] }));

  it('aceite 12: limited — autor vê qualquer setor; gestor vê setor efetivo gerido; outro setor de outro autor — falso', () => {
    expect(scope).toEqual({
      kind: 'limited',
      actorId: 'sup1',
      sectorIds: ['s1'],
    });
    const sentByMe = facts({ authorId: 'sup1', sectorId: 's7' });
    expect(scopeAllows(scope, sentByMe)).toBe(true);
    expect(scopeAllows(scope, facts({ authorId: 'outro' }))).toBe(true);
    const elsewhere = facts({ authorId: 'outro', sectorId: 's7' });
    expect(scopeAllows(scope, elsewhere)).toBe(false);
    expect(scopeAllows(scope, { ...elsewhere, authorId: null })).toBe(false);
  });

  it('aceite 13: setor vazio usa personSectorId', () => {
    const nominal = facts({ authorId: 'outro', sectorId: null });
    expect(effectiveSectorId(nominal)).toBe('s9');
    expect(effectiveSectorId(facts())).toBe('s1');
    expect(scopeAllows(scope, { ...nominal, personSectorId: 's1' })).toBe(true);
    expect(scopeAllows(scope, nominal)).toBe(false);
    expect(scopeAllows(scope, { ...nominal, personSectorId: null })).toBe(
      false,
    );
    // o setor gravado no envio vale; o atual da pessoa não o substitui
    const moved = facts({
      authorId: 'outro',
      sectorId: 's7',
      personSectorId: 's1',
    });
    expect(scopeAllows(scope, moved)).toBe(false);
  });

  it('K2-9: setor sem gestor — só autor e ADMIN', () => {
    const noManager = facts({ authorId: 'autor', sectorId: 's5' });
    const admin = pendencyScopeOf(teamActor({ role: 'ADMIN', managed: [] }));
    const author = pendencyScopeOf(teamActor({ id: 'autor', managed: ['s1'] }));
    expect(scopeAllows(scope, noManager)).toBe(false);
    expect(scopeAllows(author, noManager)).toBe(true);
    expect(scopeAllows(admin, noManager)).toBe(true);
  });
});

describe('canHandlePendency e handlerStateOf (DK4)', () => {
  it('canHandlePendency exige remetente, equipe.enviar e alcance', () => {
    expect(canHandlePendency(teamActor(), facts())).toBe(true);
    expect(
      canHandlePendency(teamActor({ role: 'ADMIN', managed: [] }), facts()),
    ).toBe(true);
    const noKey = teamActor({ change: { revoke: ['equipe.enviar'] } });
    expect(canHandlePendency(noKey, facts())).toBe(false);
    const adminNoKey = teamActor({
      role: 'ADMIN',
      change: { revoke: ['equipe.enviar'] },
    });
    expect(canHandlePendency(adminNoKey, facts())).toBe(false);
    expect(canHandlePendency(teamActor({ role: 'VIEWER' }), facts())).toBe(
      false,
    );
    expect(canHandlePendency(teamActor(), facts({ sectorId: 's7' }))).toBe(
      false,
    );
    expect(canHandlePendency(null, facts())).toBe(false);
  });

  it('handlerStateOf — null, inativo, sem acesso → inactive; sem equipe.enviar, sem setor gerido, fora do setor → out_of_scope; senão active', () => {
    const state = (h: TeamActor | null, f = facts()) => handlerStateOf(h, f);
    expect(state(null)).toBe('inactive');
    expect(state(teamActor({ off: { isActive: false } }))).toBe('inactive');
    expect(state(teamActor({ off: { hasAccess: false } }))).toBe('inactive');
    expect(state(teamActor({ change: { revoke: ['equipe.enviar'] } }))).toBe(
      'out_of_scope',
    );
    expect(state(teamActor({ managed: [] }))).toBe('out_of_scope');
    expect(state(teamActor(), facts({ sectorId: 's7' }))).toBe('out_of_scope');
    expect(state(teamActor())).toBe('active');
    expect(state(teamActor({ role: 'ADMIN', managed: [] }))).toBe('active');
  });
});
