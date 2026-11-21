import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  at,
  newAlert,
  newPendency,
  startPendencyDb,
  stopPendencyDb,
  type NewPendencyInput,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import {
  lockPendency,
  PENDENCY_TX_OPTIONS,
  runPendencyTransition,
  type PendencyTransition,
} from './team-pendency-write.repository';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-write.repository.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: PendencyDb;
let dispatchId = '';

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  dispatchId = await newAlert(db, { authorId: db.ids.admin, createdAt: at(0) });
}, 180_000);

afterAll(() => stopPendencyDb(db));
afterEach(() => vi.restoreAllMocks());

const seed = (over: Partial<NewPendencyInput> = {}) =>
  newPendency(db, { dispatchId, ...over });

/** Assumir por `ana` em `at(10)`; cada teste sobrescreve só o que importa. */
function assume(
  recipientId: string,
  over: Partial<PendencyTransition> = {},
): PendencyTransition {
  return {
    recipientId,
    actorId: db.ids.ana,
    now: at(10),
    action: 'team_whatsapp.pendency_assume',
    kind: 'assume',
    expect: { handlerId: null, closed: false },
    patch: { handlerId: db.ids.ana, assignedAt: at(10), dueAt: at(70) },
    note: null,
    handlerState: { before: null, after: 'active' },
    ...over,
  };
}

const conflictCases: [
  string,
  Partial<NewPendencyInput>,
  PendencyTransition['expect'],
][] = [
  ['acked', { ackAt: at(5) }, { handlerId: null, closed: false }],
  ['closed', { closedAt: at(5) }, { handlerId: null, closed: false }],
  ['not_closed', {}, { handlerId: null, closed: true }],
  [
    'handler_changed',
    { handlerId: 'pessoa-outra' },
    { handlerId: null, closed: false },
  ],
];

const run = (t: PendencyTransition) =>
  runPendencyTransition(db.prisma as unknown as PrismaService, db.audit, t);
const row = (id: string) =>
  db.prisma.teamWhatsappRecipient.findUniqueOrThrow({ where: { id } });
const notesOf = (id: string) =>
  db.prisma.teamPendencyNote.findMany({ where: { recipientId: id } });
const trailOf = (id: string) =>
  db.prisma.auditEvent.findMany({
    where: { entity: 'TeamWhatsappRecipient', entityId: id },
  });

describe.skipIf(!ENABLED)('lockPendency', () => {
  it('lockPendency — inexistente null', async () => {
    const locked = await db.prisma.$transaction((tx) =>
      lockPendency(tx, 'nao-existe'),
    );
    expect(locked).toBeNull();
  });

  it('lockPendency — devolve as colunas da pendência', async () => {
    const id = await seed({
      handlerId: db.ids.ana,
      assignedAt: at(1),
      dueAt: at(61),
      closedAt: at(2),
      closedById: db.ids.bia,
      closeReason: 'Resolvido',
    });
    const locked = await db.prisma.$transaction((tx) => lockPendency(tx, id));
    expect(locked).toEqual({
      id,
      dispatchId,
      ackAt: null,
      handlerId: db.ids.ana,
      assignedAt: at(1),
      dueAt: at(61),
      closedAt: at(2),
      closedById: db.ids.bia,
      closeReason: 'Resolvido',
    });
  });
});

describe.skipIf(!ENABLED)('transição — gravação e trilha', () => {
  it('aceite 23: transição de assumir — grava responsável, assignedAt e dueAt; AuditEvent team_whatsapp.pendency_assume com antes/depois de handlerId, situation e dueAt, sem texto', async () => {
    const id = await seed();
    const outcome = await run(assume(id));
    expect(outcome).toEqual({
      ok: true,
      noteId: null,
      before: { handlerId: null, situation: 'UNASSIGNED', dueAt: null },
      after: {
        handlerId: db.ids.ana,
        situation: 'IN_PROGRESS',
        dueAt: at(70).toISOString(),
      },
    });
    expect(await row(id)).toMatchObject({
      pendencyHandlerId: db.ids.ana,
      pendencyAssignedAt: at(10),
      pendencyDueAt: at(70),
    });
    const [event, ...rest] = await trailOf(id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: 'team_whatsapp.pendency_assume',
      category: null,
      actorId: db.ids.ana,
      metadata: { dispatchId, recipientId: id, kind: 'assume' },
      changes: [
        { field: 'handlerId', before: null, after: db.ids.ana },
        { field: 'situation', before: 'UNASSIGNED', after: 'IN_PROGRESS' },
        { field: 'dueAt', before: null, after: at(70).toISOString() },
      ],
    });
  });
});

describe.skipIf(!ENABLED)('transição — anotação e colunas intocadas', () => {
  it('anotação — TeamPendencyNote com kind e autor; metadata com noteId e sem o texto', async () => {
    const id = await seed();
    const text = 'Liguei para o setor e combinei a retirada';
    const outcome = await run(assume(id, { note: { kind: 'ASSUME', text } }));
    const [note, ...rest] = await notesOf(id);
    expect(rest).toEqual([]);
    expect(note).toMatchObject({
      kind: 'ASSUME',
      authorId: db.ids.ana,
      text,
      createdAt: at(10),
    });
    expect(outcome).toMatchObject({ ok: true, noteId: note.id });
    const [event] = await trailOf(id);
    expect(event.metadata).toEqual({
      dispatchId,
      recipientId: id,
      kind: 'assume',
      noteId: note.id,
    });
    expect(JSON.stringify(event)).not.toContain(text);
  });

  it('não muda updatedAt, status, ackAt nem campos de rastreio', async () => {
    const id = await seed({
      messageId: 'wamid-k2-a',
      lastReplyMessageId: 'wamid-k2-r',
    });
    const before = await row(id);
    await run(assume(id));
    const after = await row(id);
    const tracking = (r: typeof before) =>
      Object.fromEntries(
        Object.entries(r).filter(([key]) => !key.startsWith('pendency')),
      );
    expect(tracking(after)).toEqual(tracking(before));
    expect(after).toMatchObject({
      updatedAt: at(0),
      status: 'SENT',
      ackAt: null,
    });
  });
});

describe.skipIf(!ENABLED)('transição — fechar, reabrir e contato', () => {
  it('fechar e reabrir — chave ausente mantém a coluna e null a limpa', async () => {
    const id = await seed({
      handlerId: db.ids.ana,
      assignedAt: at(1),
      dueAt: at(61),
    });
    const close = {
      closedAt: at(20),
      closedById: db.ids.ana,
      closeReason: 'Feito',
    };
    await run(
      assume(id, {
        action: 'team_whatsapp.pendency_close',
        expect: { handlerId: db.ids.ana, closed: false },
        patch: close,
        handlerState: { before: 'active', after: 'active' },
      }),
    );
    expect(await row(id)).toMatchObject({
      pendencyHandlerId: db.ids.ana,
      pendencyDueAt: at(61),
      pendencyClosedAt: at(20),
      pendencyCloseReason: 'Feito',
    });
    await run(
      assume(id, {
        action: 'team_whatsapp.pendency_reopen',
        expect: { handlerId: db.ids.ana, closed: true },
        patch: { closedAt: null, closedById: null, closeReason: null },
        handlerState: { before: 'active', after: 'active' },
      }),
    );
    expect(await row(id)).toMatchObject({
      pendencyHandlerId: db.ids.ana,
      pendencyClosedAt: null,
      pendencyClosedById: null,
      pendencyCloseReason: null,
    });
  });
});

describe.skipIf(!ENABLED)('transição — registrar contato', () => {
  it('expectativa de contato (closed any, ignoreAck) — grava a anotação em pendência ciente e em encerrada', async () => {
    const acked = await seed({ handlerId: db.ids.ana, ackAt: at(5) });
    const closed = await seed({ handlerId: db.ids.ana, closedAt: at(5) });
    for (const id of [acked, closed]) {
      const before = await row(id);
      const outcome = await run(
        assume(id, {
          action: 'team_whatsapp.pendency_note',
          kind: 'contact',
          expect: { handlerId: db.ids.ana, closed: 'any', ignoreAck: true },
          patch: null,
          note: { kind: 'CONTACT', text: 'Falei com a pessoa' },
          handlerState: { before: 'active', after: 'active' },
        }),
      );
      const [note] = await notesOf(id);
      expect(note.kind).toBe('CONTACT');
      expect(outcome).toMatchObject({ ok: true, noteId: note.id });
      expect(await row(id)).toEqual(before);
    }
  });
});

describe.skipIf(!ENABLED)('transição — conflitos', () => {
  it.each(conflictCases)(
    'conflito %s — colunas iguais, nenhuma anotação, nenhum AuditEvent',
    async (conflict, input, expectation) => {
      const id = await seed(input);
      const before = await row(id);
      const outcome = await run(
        assume(id, {
          expect: expectation,
          note: { kind: 'ASSUME', text: 'não deve gravar' },
        }),
      );
      expect(outcome).toMatchObject({ ok: false, conflict, current: { id } });
      expect(await row(id)).toEqual(before);
      expect(await notesOf(id)).toEqual([]);
      expect(await trailOf(id)).toEqual([]);
    },
  );

  it('ausente — conflict missing', async () => {
    expect(await run(assume('nao-existe'))).toEqual({
      ok: false,
      conflict: 'missing',
      current: null,
    });
  });
});

describe.skipIf(!ENABLED)('transição — só conferência', () => {
  it('só conferência (patch e note nulos) — ok sem UPDATE, anotação nem AuditEvent; com estado diferente do esperado, o conflito volta', async () => {
    const id = await seed({ handlerId: db.ids.ana, dueAt: at(61) });
    const before = await row(id);
    const check = (handlerId: string) =>
      run(
        assume(id, {
          expect: { handlerId, closed: false },
          patch: null,
          handlerState: { before: 'active', after: 'active' },
        }),
      );
    const ok = await check(db.ids.ana);
    expect(ok).toMatchObject({ ok: true, noteId: null });
    expect(ok.ok && ok.after).toEqual(ok.ok && ok.before);
    expect(await check(db.ids.bia)).toMatchObject({
      ok: false,
      conflict: 'handler_changed',
      current: { handlerId: db.ids.ana },
    });
    expect(await row(id)).toEqual(before);
    expect(await notesOf(id)).toEqual([]);
    expect(await trailOf(id)).toEqual([]);
  });
});

describe.skipIf(!ENABLED)('transição — atomicidade e prazos', () => {
  it('falha do recordChange desfaz colunas e anotação', async () => {
    const id = await seed();
    const before = await row(id);
    vi.spyOn(db.audit, 'recordChange').mockRejectedValueOnce(
      new Error('falha da trilha'),
    );
    await expect(
      run(assume(id, { note: { kind: 'ASSUME', text: 'desfaz junto' } })),
    ).rejects.toThrow('falha da trilha');
    expect(await row(id)).toEqual(before);
    expect(await notesOf(id)).toEqual([]);
  });

  it('toda $transaction usa PENDENCY_TX_OPTIONS', async () => {
    expect(PENDENCY_TX_OPTIONS).toEqual({ timeout: 10_000, maxWait: 5_000 });
    const spy = vi.spyOn(db.prisma, '$transaction');
    await run(assume(await seed()));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 10_000,
      maxWait: 5_000,
    });
  });
});
