import { describe, expect, it } from 'vitest';
import type { PendencySituation } from '../../schemas/contracts/team-pendency.schema';
import {
  assumeKind,
  comparePendencies,
  isUnassignedOverdue,
  pendencyConflict,
  pendencyDueAt,
  pendencySituation,
  replyMediaOf,
  requiresHandler,
  type LockedPendency,
  type PendencyStateFacts,
  type SortablePendency,
} from './team-pendency.rules';

const T0 = new Date('2026-11-21T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const state = (over: Partial<PendencyStateFacts> = {}): PendencyStateFacts => ({
  ackAt: null,
  closedAt: null,
  handlerId: 'u1',
  handlerState: 'active',
  dueAt: at(30),
  ...over,
});

describe('pendencySituation (K2-2, DK5)', () => {
  it.each<[string, Partial<PendencyStateFacts>, PendencySituation]>([
    [
      'ciente vence encerrada e atrasada',
      { ackAt: at(-1), closedAt: at(-2), dueAt: at(-9) },
      'ACKED',
    ],
    [
      'encerrada vence sem responsável e atrasada',
      { closedAt: at(-2), handlerId: null, dueAt: at(-9) },
      'CLOSED',
    ],
    [
      'sem responsável vence atrasada',
      { handlerId: null, handlerState: null, dueAt: at(-9) },
      'UNASSIGNED',
    ],
    ['com responsável e prazo vencido', { dueAt: at(-9) }, 'OVERDUE'],
    ['com responsável e prazo em dia', {}, 'IN_PROGRESS'],
  ])(
    'K2-2: ordem ACKED > CLOSED > UNASSIGNED > OVERDUE > IN_PROGRESS — %s',
    (_caso, over, expected) => {
      expect(pendencySituation(state(over), T0)).toBe(expected);
    },
  );

  it('aceite 19: ack depois do encerramento — ACKED; prazo vencido — OVERDUE', () => {
    const closedThenAcked = state({ closedAt: at(-30), ackAt: at(-5) });
    expect(pendencySituation(closedThenAcked, T0)).toBe('ACKED');
    expect(pendencySituation(state({ dueAt: T0 }), T0)).toBe('OVERDUE');
    expect(pendencySituation(state({ dueAt: at(1) }), T0)).toBe('IN_PROGRESS');
  });

  it('responsável inactive ou out_of_scope — UNASSIGNED', () => {
    const future = { dueAt: at(30) };
    expect(
      pendencySituation(state({ ...future, handlerState: 'inactive' }), T0),
    ).toBe('UNASSIGNED');
    expect(
      pendencySituation(state({ ...future, handlerState: 'out_of_scope' }), T0),
    ).toBe('UNASSIGNED');
    expect(
      pendencySituation(state({ ...future, handlerState: null }), T0),
    ).toBe('UNASSIGNED');
  });
});

const item = (
  id: string,
  situation: PendencySituation,
  createdMin: number,
  deadlineMin: number,
): SortablePendency => ({
  id,
  situation,
  alertCreatedAt: at(createdMin),
  ackDeadlineAt: at(deadlineMin),
});

describe('ordem da lista e contador (K2-5, K2-6)', () => {
  it('aceite 15: ordem — Sem responsável vencida, atrasada, demais da mais antiga; empate por id', () => {
    const list = [
      item('p4', 'IN_PROGRESS', -300, -240),
      item('p3', 'OVERDUE', -200, -140),
      item('p1', 'UNASSIGNED', -50, -20),
      item('p5', 'UNASSIGNED', -400, 60),
      item('p2b', 'UNASSIGNED', -100, -40),
      item('p2a', 'UNASSIGNED', -100, -40),
      item('p6', 'ACKED', -500, -440),
    ];
    const sorted = [...list].sort((a, b) => comparePendencies(a, b, T0));
    expect(sorted.map((p) => p.id)).toEqual([
      'p2a',
      'p2b',
      'p1',
      'p3',
      'p6',
      'p5',
      'p4',
    ]);
    expect(comparePendencies(list[0], list[0], T0)).toBe(0);
  });

  it('isUnassignedOverdue — só UNASSIGNED com prazo de ciência vencido', () => {
    expect(isUnassignedOverdue(item('a', 'UNASSIGNED', -50, -1), T0)).toBe(
      true,
    );
    expect(isUnassignedOverdue(item('a', 'UNASSIGNED', -50, 0), T0)).toBe(true);
    expect(isUnassignedOverdue(item('a', 'UNASSIGNED', -50, 1), T0)).toBe(
      false,
    );
    expect(isUnassignedOverdue(item('a', 'OVERDUE', -50, -10), T0)).toBe(false);
    expect(isUnassignedOverdue(item('a', 'IN_PROGRESS', -50, -10), T0)).toBe(
      false,
    );
  });

  it('K2-8: pendencyDueAt = now + 60 min', () => {
    expect(pendencyDueAt(T0)).toEqual(at(60));
    expect(T0).toEqual(new Date('2026-11-21T12:00:00.000Z'));
  });
});

const locked = (over: Partial<LockedPendency> = {}): LockedPendency => ({
  id: 'r1',
  dispatchId: 'd1',
  ackAt: null,
  handlerId: 'u1',
  assignedAt: at(-10),
  dueAt: at(50),
  closedAt: null,
  closedById: null,
  closeReason: null,
  ...over,
});

describe('pendencyConflict (DK10.3)', () => {
  it('pendencyConflict — acked antes de closed antes de handler_changed; not_closed quando espera encerrada', () => {
    const open = { handlerId: 'u1', closed: false } as const;
    const everything = locked({
      ackAt: at(-1),
      closedAt: at(-2),
      handlerId: 'u9',
    });
    expect(pendencyConflict(everything, open)).toBe('acked');
    expect(pendencyConflict({ ...everything, ackAt: null }, open)).toBe(
      'closed',
    );
    expect(pendencyConflict(locked({ handlerId: 'u9' }), open)).toBe(
      'handler_changed',
    );
    expect(pendencyConflict(locked(), open)).toBeNull();
    expect(pendencyConflict(locked(), { handlerId: 'u1', closed: true })).toBe(
      'not_closed',
    );
  });
});

describe('pendencyConflict por ação (DK13)', () => {
  it('DK13: pendencyConflict de Registrar contato (closed any, ignoreAck) — ciente, encerrada ou ciente e encerrada com o mesmo responsável: null; responsável trocado: handler_changed', () => {
    const contact = {
      handlerId: 'u1',
      closed: 'any',
      ignoreAck: true,
    } as const;
    expect(pendencyConflict(locked({ ackAt: at(-1) }), contact)).toBeNull();
    expect(pendencyConflict(locked({ closedAt: at(-2) }), contact)).toBeNull();
    expect(
      pendencyConflict(locked({ ackAt: at(-1), closedAt: at(-2) }), contact),
    ).toBeNull();
    expect(
      pendencyConflict(locked({ ackAt: at(-1), handlerId: 'u9' }), contact),
    ).toBe('handler_changed');
    expect(pendencyConflict(locked({ handlerId: null }), contact)).toBe(
      'handler_changed',
    );
  });

  it('pendencyConflict de Assumir, Transferir e Encerrar (closed false) continua acked em ciente e closed em encerrada; de Reabrir (closed true), acked e not_closed', () => {
    const open = { handlerId: 'u1', closed: false } as const;
    const reopen = { handlerId: 'u1', closed: true } as const;
    expect(pendencyConflict(locked({ ackAt: at(-1) }), open)).toBe('acked');
    expect(pendencyConflict(locked({ closedAt: at(-2) }), open)).toBe('closed');
    expect(
      pendencyConflict(locked({ ackAt: at(-1), closedAt: at(-2) }), reopen),
    ).toBe('acked');
    expect(pendencyConflict(locked({ ackAt: at(-1) }), reopen)).toBe('acked');
    expect(pendencyConflict(locked(), reopen)).toBe('not_closed');
    expect(pendencyConflict(locked({ closedAt: at(-2) }), reopen)).toBeNull();
    expect(
      pendencyConflict(locked({ closedAt: at(-2), handlerId: null }), {
        handlerId: null,
        closed: true,
      }),
    ).toBeNull();
  });
});

describe('assumeKind, requiresHandler e replyMediaOf (DK8, DK11–DK14)', () => {
  it('assumeKind — eu noop; null, inactive, out_of_scope assume; active take_over', () => {
    expect(assumeKind('me', 'me', 'active')).toBe('noop');
    expect(assumeKind('me', null, null)).toBe('assume');
    expect(assumeKind('me', 'u9', 'inactive')).toBe('assume');
    expect(assumeKind('me', 'u9', 'out_of_scope')).toBe('assume');
    expect(assumeKind('me', 'u9', 'active')).toBe('take_over');
  });

  it('requiresHandler — ADMIN nunca; outro com expected diferente sim', () => {
    const admin = { id: 'a1', role: 'ADMIN' };
    const sup = { id: 'u1', role: 'SUPERVISOR' };
    expect(requiresHandler(admin, 'u9')).toBe(false);
    expect(requiresHandler(admin, null)).toBe(false);
    expect(requiresHandler(sup, 'u1')).toBe(false);
    expect(requiresHandler(sup, 'u9')).toBe(true);
    expect(requiresHandler(sup, null)).toBe(true);
  });

  it('replyMediaOf — AUDIO audio; IMAGE e STICKER image; demais file; TEXT null', () => {
    expect(replyMediaOf('TEXT')).toBeNull();
    expect(replyMediaOf('AUDIO')).toBe('audio');
    expect(replyMediaOf('IMAGE')).toBe('image');
    expect(replyMediaOf('STICKER')).toBe('image');
    for (const kind of [
      'VIDEO',
      'DOCUMENT',
      'LOCATION',
      'CONTACT',
      'UNSUPPORTED',
    ] as const) {
      expect(replyMediaOf(kind)).toBe('file');
    }
  });
});
