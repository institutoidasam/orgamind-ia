import type { Role } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  actorWith,
  type PermissionChange,
} from '../../shared/authz/actor.test-fixtures';
import type { PendencyDetail } from './team-pendency.query';
import {
  buildPendencyItem,
  viewNeedsOf,
  type PendencyViewContext,
} from './team-pendency.view';
import type { TeamActor } from './team-whatsapp.policy';

const T0 = new Date('2026-11-21T12:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

/** Linha do alerta enviado a "Pessoa A" (fictícia), sem responsável, entregue e sem resposta. */
function detail(over: Partial<PendencyDetail> = {}): PendencyDetail {
  return {
    id: 'rec-1',
    dispatchId: 'disp-1',
    userId: 'user-1',
    userName: 'Pessoa A',
    status: 'SENT',
    sectorId: 'sec-1',
    sectorName: 'Logística',
    shiftId: null,
    shiftName: 'Noite',
    levelName: null,
    phoneE164: '+5592991110001',
    messageId: 'msg-1',
    ackAt: null,
    ackKind: null,
    ackByUserId: null,
    ackNote: null,
    ackMessageId: null,
    lastReplyMessageId: null,
    reminderStatuses: [],
    personSectorId: 'sec-1',
    handlerId: null,
    assignedAt: null,
    dueAt: null,
    closedAt: null,
    closedById: null,
    closeReason: null,
    notes: [],
    alert: {
      authorId: 'author-1',
      authorName: 'Gestor S1',
      text: 'Vazamento no galpão',
      createdAt: T0,
      ackDeadlineMinutes: 15,
    },
    ...over,
  };
}

function actorOf(role: Role, change: PermissionChange & { id?: string } = {}) {
  const actor: TeamActor = {
    ...actorWith(role, change),
    managedSectorIds: ['sec-1'],
  };
  return actor;
}

function context(over: Partial<PendencyViewContext> = {}): PendencyViewContext {
  return {
    actor: actorOf('ADMIN'),
    now: at(30),
    names: new Map(),
    replies: new Map(),
    conversations: new Map([['msg-1', 'conv-1']]),
    ...over,
  };
}

const reply = (kind: 'TEXT' | 'AUDIO', content: string | null) => ({
  content,
  kind,
  at: at(10),
});

const NOTE = {
  id: 'n1',
  kind: 'CONTACT' as const,
  authorId: 'h1',
  text: 'Liguei',
  createdAt: at(5),
};

/** Item de um responsável ativo, com prazo e uma anotação, visto pelo ADMIN. */
function assembled() {
  const row = detail({
    handlerId: 'h1',
    assignedAt: at(1),
    dueAt: at(61),
    notes: [NOTE],
  });
  const handler = { state: 'active' as const, name: 'Gestor S1' };
  const names = new Map([['h1', 'Gestor S1']]);
  return buildPendencyItem(row, handler, context({ names }));
}

const ASSEMBLED = {
  id: 'rec-1',
  dispatchId: 'disp-1',
  group: 'no_reply',
  situation: 'IN_PROGRESS',
  person: {
    name: 'Pessoa A',
    sectorId: 'sec-1',
    sectorName: 'Logística',
    shiftName: 'Noite',
  },
  alert: {
    text: 'Vazamento no galpão',
    authorName: 'Gestor S1',
    sentAt: T0.toISOString(),
    ackDeadlineAt: at(15).toISOString(),
  },
  handler: { id: 'h1', name: 'Gestor S1', state: 'active' },
  assignedAt: at(1).toISOString(),
  dueAt: at(61).toISOString(),
  closure: null,
  ack: null,
  notes: [
    {
      id: 'n1',
      kind: 'CONTACT',
      authorName: 'Gestor S1',
      at: at(5).toISOString(),
      text: 'Liguei',
    },
  ],
};

describe('montagem do item (K2-5, DK8)', () => {
  it('aceite 14: monta pessoa, alerta, grupo, prazo de ciência, responsável com state, situação e anotações', () => {
    expect(assembled()).toMatchObject(ASSEMBLED);
  });
});

/** Responsável inativo e sem nome, pendência encerrada e depois ciente. */
function closedAndAcked() {
  const row = detail({
    handlerId: 'h2',
    closedAt: at(20),
    closedById: 'h2',
    closeReason: 'Resolvido',
    ackAt: at(25),
    ackKind: 'MANUAL',
  });
  const handler = { state: 'inactive' as const, name: '' };
  return buildPendencyItem(row, handler, context());
}

describe('responsável, encerramento e ciência (K2-2, DK8)', () => {
  it('responsável sem nome (vazio) vira name null; encerramento e ciência aparecem', () => {
    const item = closedAndAcked();
    expect(item.handler).toEqual({ id: 'h2', name: null, state: 'inactive' });
    expect(item.situation).toBe('ACKED');
    expect(item.closure).toEqual({
      byId: 'h2',
      byName: null,
      at: at(20).toISOString(),
      reason: 'Resolvido',
    });
    expect(item.ack).toEqual({ kind: 'MANUAL', at: at(25).toISOString() });
  });
});

/** `lastReply` da linha com a resposta `m-reply` já lida (texto ou áudio). */
function lastReplyOf(row: PendencyDetail, kind: 'TEXT' | 'AUDIO') {
  const message = reply(kind, kind === 'TEXT' ? 'Preciso de ajuda' : 'legenda');
  const replies = new Map([['m-reply', message]]);
  return buildPendencyItem(row, null, context({ replies })).lastReply;
}

describe('última resposta (K2-5, Anti-objetivo 2)', () => {
  it('aceite 14: lastReply só no grupo replied; mídia sem texto', () => {
    const row = detail({ lastReplyMessageId: 'm-reply' });
    const acked = { ...row, ackAt: at(12), ackKind: 'KEYWORD' as const };
    const at10 = at(10).toISOString();
    expect(lastReplyOf(row, 'TEXT')).toEqual({
      text: 'Preciso de ajuda',
      media: null,
      at: at10,
    });
    expect(lastReplyOf(row, 'AUDIO')).toEqual({
      text: null,
      media: 'audio',
      at: at10,
    });
    expect(lastReplyOf(acked, 'TEXT')).toBeNull();
    expect(lastReplyOf(detail(), 'TEXT')).toBeNull();
    expect(viewNeedsOf([row, acked, detail()]).replyIds).toEqual(['m-reply']);
  });
});

const idFor = (actor: TeamActor, row = detail()) =>
  buildPendencyItem(row, null, context({ actor })).conversationId;
const canView = (actor: TeamActor) =>
  buildPendencyItem(detail(), null, context({ actor })).canViewDispatch;

describe('conversa e resultado do envio (aceite 22, DK8)', () => {
  it('aceite 22: conversationId só para ADMIN e OPERATOR e com mensagem; canViewDispatch só ADMIN e autor', () => {
    expect(idFor(actorOf('ADMIN'))).toBe('conv-1');
    expect(idFor(actorOf('OPERATOR'))).toBe('conv-1');
    expect(idFor(actorOf('SUPERVISOR'))).toBeNull();
    expect(idFor(actorOf('ADMIN'), detail({ messageId: null }))).toBeNull();
    expect(canView(actorOf('ADMIN'))).toBe(true);
    expect(canView(actorOf('SUPERVISOR', { id: 'author-1' }))).toBe(true);
    expect(canView(actorOf('SUPERVISOR', { id: 'outro' }))).toBe(false);
    expect(canView(actorOf('OPERATOR', { id: 'outro' }))).toBe(false);
  });
});

const personFor = (actor: TeamActor, row = detail()) =>
  buildPendencyItem(row, null, context({ actor })).person;

describe('telefone e nome (DK8)', () => {
  it('telefone e nome por phoneView/nameView conforme a chave', () => {
    const row = detail({ userName: '+55 92 99111-0001' });
    const full = personFor(actorOf('SUPERVISOR'), row);
    const revoke = ['telefone.ver_completo' as const];
    const masked = personFor(actorOf('SUPERVISOR', { revoke }), row);
    expect(full).toMatchObject({
      name: '+55 92 99111-0001',
      phoneE164: '+5592991110001',
      hasPhone: true,
    });
    expect([masked.phoneE164, masked.hasPhone]).toEqual([null, true]);
    expect(masked.phoneMasked).toContain('0001');
    expect(masked.name).not.toContain('99111');
    expect(masked.phoneMasked).not.toContain('99111');
  });

  it('sem telefone gravado (envio antigo): hasPhone false', () => {
    const person = personFor(actorOf('ADMIN'), detail({ phoneE164: null }));
    expect(person).toMatchObject({
      phoneE164: null,
      hasPhone: false,
      phoneMasked: null,
    });
  });
});
