import { describe, it, expect } from 'vitest';
import {
  SITUATION_LABEL,
  assigneeLabel,
  conversationActions,
  replyLock,
  situationOf,
} from './situation';
import type { ConversationSummary } from './schemas';

const base: ConversationSummary = {
  id: 'c1', instanceId: 'i1', instanceName: 'A', remoteJid: 'j@s', phoneE164: null,
  contactId: null, displayName: 'Cliente', waName: null, profilePicUrl: null,
  lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0,
};
const conv = (extra: Partial<ConversationSummary>): ConversationSummary => ({ ...base, ...extra });
const operator = { id: 'u1', role: 'OPERATOR' };
const admin = { id: 'u9', role: 'ADMIN' };
const mine = conv({ status: 'IN_PROGRESS', assignedUserId: 'u1', assignedUserName: 'Ana' });
const other = conv({ status: 'IN_PROGRESS', assignedUserId: 'u2', assignedUserName: 'Bia' });
const pending = conv({ status: 'PENDING', assignedUserId: null });
const resolved = conv({ status: 'RESOLVED', resolvedAt: '2026-11-21T10:00:00.000Z' });

describe('situationOf e assigneeLabel', () => {
  it('situationOf: status do servidor; sem status, pelos campos', () => {
    expect(SITUATION_LABEL).toEqual({ PENDING: 'Pendente', IN_PROGRESS: 'Em atendimento', RESOLVED: 'Resolvida' });
    expect(situationOf({ status: 'RESOLVED', assignedUserId: 'u1' })).toBe('RESOLVED');
    expect(situationOf({ resolvedAt: '2026-11-21T10:00:00.000Z', assignedUserId: 'u1' })).toBe('RESOLVED');
    expect(situationOf({ assignedUserId: 'u1' })).toBe('IN_PROGRESS');
    expect(situationOf({ status: null, assignedUserId: null })).toBe('PENDING');
    expect(situationOf({ status: 'ARCHIVED', assignedUserId: 'u1' })).toBe('IN_PROGRESS');
  });

  it('assigneeLabel: Ana; Ana (inativo)', () => {
    expect(assigneeLabel('Ana', true)).toBe('Ana');
    expect(assigneeLabel('Ana', null)).toBe('Ana');
    expect(assigneeLabel('Ana', false)).toBe('Ana (inativo)');
    expect(assigneeLabel(null, false)).toBeNull();
  });
});

describe('conversationActions', () => {
  it('minha aberta — Resolver, Transferir, Remover atendente; sem Assumir', () => {
    expect(conversationActions(mine, operator)).toEqual({
      resolve: true, reopen: false, assume: false, transfer: true, remove: true,
    });
  });

  it('aceite 2: de outro, OPERATOR — só Assumir conversa', () => {
    expect(conversationActions(other, operator)).toEqual({
      resolve: false, reopen: false, assume: true, transfer: false, remove: false,
    });
  });

  it('de outro, ADMIN — Assumir, Resolver, Transferir, Remover', () => {
    expect(conversationActions(other, admin)).toEqual({
      resolve: true, reopen: false, assume: true, transfer: true, remove: true,
    });
  });

  it('Pendente — Assumir e Transferir; Resolver só ADMIN', () => {
    expect(conversationActions(pending, operator)).toEqual({
      resolve: false, reopen: false, assume: true, transfer: true, remove: false,
    });
    expect(conversationActions(pending, admin).resolve).toBe(true);
  });

  it('Resolvida — Reabrir, Assumir, Transferir', () => {
    expect(conversationActions(resolved, operator)).toEqual({
      resolve: false, reopen: true, assume: true, transfer: true, remove: false,
    });
  });
});

describe('replyLock', () => {
  it('de outro e aberta — travado com o nome; minha, Pendente ou Resolvida — livre', () => {
    expect(replyLock(other, 'u1')).toEqual({ locked: true, name: 'Bia' });
    expect(replyLock({ ...other, assignedUserActive: false }, 'u1')).toEqual({ locked: true, name: 'Bia (inativo)' });
    expect(replyLock(mine, 'u1')).toEqual({ locked: false, name: null });
    expect(replyLock(pending, 'u1')).toEqual({ locked: false, name: null });
    expect(replyLock(conv({ ...other, status: 'RESOLVED' }), 'u1')).toEqual({ locked: false, name: null });
  });
});
