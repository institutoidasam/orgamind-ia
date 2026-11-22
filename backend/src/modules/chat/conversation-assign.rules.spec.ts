import { describe, expect, it } from 'vitest';
import {
  assignChange,
  assignHasNoEffect,
  assignKind,
  canAssign,
} from './conversation-assign.rules';
import type { LockedConversation } from './conversation-ownership.repository';

const operator = { id: 'ana', role: 'OPERATOR' };
const admin = { id: 'zed', role: 'ADMIN' };
const NOW = new Date('2026-11-21T12:00:00.000Z');
const locked = (over: Partial<LockedConversation> = {}) => ({
  id: 'c1',
  instanceId: 'i1',
  assignedUserId: null,
  resolvedAt: null,
  lastInboundAt: null,
  ...over,
});

describe('assignKind — tipo da ação (DK6)', () => {
  it('assignKind: null remove, eu assumo, outro transfere', () => {
    expect(assignKind('ana', null)).toBe('UNASSIGNED');
    expect(assignKind('ana', 'ana')).toBe('ASSUMED');
    expect(assignKind('ana', 'bia')).toBe('TRANSFERRED');
  });
});

describe('canAssign — 403 chat.not_assignee (K1-3, K1-7, K1-8)', () => {
  it('remover: não ADMIN com expected diferente do ator — 403', () => {
    expect(canAssign(operator, 'UNASSIGNED', 'bia')).toBe(false);
    expect(canAssign(operator, 'UNASSIGNED', null)).toBe(false);
    expect(canAssign(operator, 'UNASSIGNED', 'ana')).toBe(true);
    expect(canAssign(admin, 'UNASSIGNED', 'bia')).toBe(true);
  });

  it('transferir: não ADMIN, expected de outro — 403; expected null — permitido', () => {
    expect(canAssign(operator, 'TRANSFERRED', 'bia')).toBe(false);
    expect(canAssign(operator, 'TRANSFERRED', 'ana')).toBe(true);
    expect(canAssign(operator, 'TRANSFERRED', null)).toBe(true);
    expect(canAssign(admin, 'TRANSFERRED', 'bia')).toBe(true);
  });

  it('assumir: nunca 403', () => {
    for (const expected of ['bia', 'ana', null]) {
      expect(canAssign(operator, 'ASSUMED', expected)).toBe(true);
    }
  });
});

describe('assignHasNoEffect — o pedido já é o estado (DK6.5)', () => {
  it('sem efeito: assumir o que já é meu e aberto; remover sem atendente', () => {
    expect(
      assignHasNoEffect(locked({ assignedUserId: 'ana' }), 'ASSUMED', 'ana'),
    ).toBe(true);
    expect(assignHasNoEffect(locked(), 'UNASSIGNED', null)).toBe(true);
    expect(
      assignHasNoEffect(locked({ resolvedAt: NOW }), 'UNASSIGNED', null),
    ).toBe(true);
  });

  it('tem efeito: assumir pendente ou resolvida, transferir, remover com atendente', () => {
    expect(assignHasNoEffect(locked(), 'ASSUMED', 'ana')).toBe(false);
    expect(
      assignHasNoEffect(locked({ resolvedAt: NOW }), 'ASSUMED', 'ana'),
    ).toBe(false);
    expect(
      assignHasNoEffect(
        locked({ assignedUserId: 'ana' }),
        'TRANSFERRED',
        'bia',
      ),
    ).toBe(false);
    expect(
      assignHasNoEffect(locked({ assignedUserId: 'ana' }), 'UNASSIGNED', null),
    ).toBe(false);
  });
});

describe('assignChange — o que gravar (DK6.6)', () => {
  it('assignChange: assumir/transferir pausam o robô; resolvida ganha REOPENED antes; remover não pausa', () => {
    const base = { actorId: 'ana', note: null, now: NOW };
    const open = locked({ assignedUserId: 'bia' });
    expect(
      assignChange(open, 'TRANSFERRED', { ...base, userId: 'cid' }),
    ).toMatchObject({
      assignedUserId: 'cid',
      resolved: false,
      actions: ['TRANSFERRED'],
      pauseBot: true,
    });
    expect(
      assignChange(locked({ resolvedAt: NOW }), 'ASSUMED', {
        ...base,
        userId: 'ana',
      }),
    ).toMatchObject({
      assignedUserId: 'ana',
      resolved: false,
      actions: ['REOPENED', 'ASSUMED'],
      pauseBot: true,
    });
    expect(
      assignChange(open, 'UNASSIGNED', { ...base, userId: null }),
    ).toMatchObject({
      assignedUserId: null,
      actions: ['UNASSIGNED'],
      pauseBot: false,
    });
  });
});
