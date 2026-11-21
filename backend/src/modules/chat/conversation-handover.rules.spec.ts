import { describe, expect, it } from 'vitest';
import {
  canHandoverFrom,
  handoverChange,
  handoverSkipReason,
} from './conversation-handover.rules';
import type { LockedConversation } from './conversation-ownership.repository';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const RESOLVED_AT = new Date('2026-11-21T10:00:00.000Z');
const locked = (
  over: Partial<LockedConversation> = {},
): LockedConversation => ({
  id: 'c1',
  instanceId: 'i1',
  assignedUserId: 'ana',
  resolvedAt: null,
  lastInboundAt: null,
  ...over,
});

describe('canHandoverFrom — quem pode passar as conversas de alguém (K3-1, K3-2)', () => {
  it('o próprio sim; ADMIN de outro sim; OPERATOR de outro não', () => {
    expect(canHandoverFrom({ id: 'ana', role: 'OPERATOR' }, 'ana')).toBe(true);
    expect(canHandoverFrom({ id: 'zed', role: 'ADMIN' }, 'ana')).toBe(true);
    expect(canHandoverFrom({ id: 'bia', role: 'OPERATOR' }, 'ana')).toBe(false);
  });
});

describe('handoverSkipReason — ordem dos pulos (DT2.2)', () => {
  it('resolvida antes de tudo; já com o destino; sem atendente; com outro; com quem sai → null', () => {
    const skip = (over: Partial<LockedConversation>) =>
      handoverSkipReason(locked(over), 'ana', 'bia');
    expect(skip({ resolvedAt: RESOLVED_AT, assignedUserId: 'bia' })).toBe(
      'resolved',
    );
    expect(skip({ resolvedAt: RESOLVED_AT, assignedUserId: null })).toBe(
      'resolved',
    );
    expect(skip({ assignedUserId: 'bia' })).toBe('already_with_target');
    expect(skip({ assignedUserId: null })).toBe('unassigned');
    expect(skip({ assignedUserId: 'caio' })).toBe('other_assignee');
    expect(skip({ assignedUserId: 'ana' })).toBeNull();
  });
});

describe('handoverChange — o que a passagem grava (DT2.3, K1-7)', () => {
  it('SHIFT_HANDOVER, atendente = destino, pauseBot true, resolved false, observação', () => {
    const conversation = locked();
    expect(
      handoverChange(conversation, {
        actorId: 'zed',
        toId: 'bia',
        note: 'Turno da noite',
        now: NOW,
      }),
    ).toEqual({
      conversation,
      actorId: 'zed',
      assignedUserId: 'bia',
      resolved: false,
      actions: ['SHIFT_HANDOVER'],
      note: 'Turno da noite',
      pauseBot: true,
      now: NOW,
    });
  });
});
