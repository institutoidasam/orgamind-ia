import { describe, expect, it } from 'vitest';
import type { LockedConversation } from './conversation-ownership.repository';
import {
  canResolve,
  resolveStateChanged,
} from './conversation-ownership.rules';

const operator = { id: 'ana', role: 'OPERATOR' };
const admin = { id: 'zed', role: 'ADMIN' };

describe('canResolve — quem pode resolver (K1-3)', () => {
  it('resolver: não ADMIN com expected diferente do ator — 403', () => {
    expect(canResolve(operator, 'bia')).toBe(false);
    expect(canResolve(operator, 'ana')).toBe(true);
  });

  it('Pendente (expected null): não ADMIN 403; ADMIN permitido', () => {
    expect(canResolve(operator, null)).toBe(false);
    expect(canResolve(admin, null)).toBe(true);
  });

  it('ADMIN com qualquer expected — permitido', () => {
    expect(canResolve(admin, 'bia')).toBe(true);
    expect(canResolve(admin, 'zed')).toBe(true);
  });
});

describe('resolveStateChanged — conferência na linha travada (DK5)', () => {
  const T0 = new Date('2026-11-21T12:00:00.000Z');
  const locked = (over: Partial<LockedConversation> = {}) => ({
    id: 'c1',
    instanceId: 'i1',
    assignedUserId: 'ana',
    resolvedAt: null,
    lastInboundAt: T0,
    ...over,
  });
  const expected = (over: object = {}) => ({
    expectedAssigneeId: 'ana',
    expectedLastInboundAt: T0.toISOString(),
    ...over,
  });

  it('igual (lastInboundAt comparado em ms, null só com null) — não mudou', () => {
    expect(resolveStateChanged(locked(), expected())).toBe(false);
    expect(
      resolveStateChanged(
        locked({ assignedUserId: null, lastInboundAt: null }),
        expected({ expectedAssigneeId: null, expectedLastInboundAt: null }),
      ),
    ).toBe(false);
  });

  it('resolvida, atendente trocado ou lastInboundAt diferente — mudou', () => {
    expect(resolveStateChanged(locked({ resolvedAt: T0 }), expected())).toBe(
      true,
    );
    expect(
      resolveStateChanged(locked(), expected({ expectedAssigneeId: 'bia' })),
    ).toBe(true);
    expect(
      resolveStateChanged(
        locked(),
        expected({ expectedLastInboundAt: '2026-11-21T11:59:59.999Z' }),
      ),
    ).toBe(true);
    expect(
      resolveStateChanged(locked(), expected({ expectedLastInboundAt: null })),
    ).toBe(true);
    expect(
      resolveStateChanged(locked({ lastInboundAt: null }), expected()),
    ).toBe(true);
  });
});
