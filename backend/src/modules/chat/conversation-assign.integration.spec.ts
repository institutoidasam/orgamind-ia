import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DomainError } from '../../shared/errors/domain.error';
import {
  at,
  auditRows,
  conversationRow,
  historyRows,
  newConversation,
  ownershipService,
  startOwnershipDb,
  stopOwnershipDb,
  T0,
  type OwnershipDb,
} from './conversation-ownership.test-fixtures';
import type { AssignConversationInput } from '../../schemas/contracts/chat.schema';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-assign.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const PAST = new Date('2026-01-01T00:00:00.000Z');

let db: OwnershipDb;
let service: ReturnType<typeof ownershipService>['service'];
let events: ReturnType<typeof ownershipService>['events'];

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startOwnershipDb();
  ({ service, events } = ownershipService(db));
}, 180_000);

beforeEach(() => vi.clearAllMocks());

afterAll(() => stopOwnershipDb(db));

type Key = 'admin' | 'ana' | 'bia';
const actor = (key: Key) => ({
  id: db.ids[key],
  role: key === 'admin' ? 'ADMIN' : 'OPERATOR',
});
/** Pedido como a tela manda: para quem atribuir e o atendente que ela mostrava. */
const send = (id: string, by: Key, input: AssignConversationInput) =>
  service.assign(id, actor(by), input);
const assigned = (to: Key, over: object = {}) =>
  newConversation(db, { assignedUserId: db.ids[to], assignedAt: T0, ...over });
const person = (key: string, data: object = {}) =>
  db.prisma.user
    .create({
      data: { email: `${key}@test.local`, password: 'x', name: key, ...data },
      select: { id: true },
    })
    .then((user) => user.id);
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as DomainError,
  );

/** A linha como estava, nenhuma linha de histórico, nenhuma trilha e nenhum evento. */
async function expectNothingWritten(
  id: string,
  before: Awaited<ReturnType<typeof conversationRow>>,
) {
  expect(await conversationRow(db, id)).toEqual(before);
  expect(await historyRows(db, id)).toEqual([]);
  expect(await auditRows(db, id)).toEqual([]);
  expect(events.publish).not.toHaveBeenCalled();
}

/** DK7: `conversation.assign` por troca, com ids e `kind`; nunca a observação. */
async function expectAssignTrail(id: string) {
  const { ana, bia } = db.ids;
  const kindOf = (e: { metadata: unknown }) =>
    (e.metadata as { kind: string }).kind;
  const trail = (await auditRows(db, id)).sort((a, b) =>
    kindOf(a).localeCompare(kindOf(b)),
  );
  const change = (before: string | null, after: string | null) => [
    { field: 'assignedUserId', before, after },
  ];
  expect(trail).toMatchObject([
    {
      action: 'conversation.assign',
      actorId: ana,
      changes: change(null, ana),
      metadata: { assignedUserId: ana, assignedBy: ana, kind: 'ASSUMED' },
    },
    {
      actorId: ana,
      changes: change(ana, bia),
      metadata: { assignedUserId: bia, assignedBy: ana, kind: 'TRANSFERRED' },
    },
    {
      actorId: bia,
      changes: change(bia, null),
      metadata: { assignedUserId: null, assignedBy: bia, kind: 'UNASSIGNED' },
    },
  ]);
  expect(JSON.stringify(trail)).not.toContain('peguei');
}

/** Assumir (ana) → transferir (bia) → remover: linha, histórico, trilha e um evento por passo. */
async function expectWalkRecorded(id: string) {
  const { ana, bia } = db.ids;
  expect(await conversationRow(db, id)).toMatchObject({
    assignedUserId: null,
    assignedAt: null,
  });
  expect(await historyRows(db, id)).toMatchObject([
    { action: 'ASSUMED', actorId: ana, toUserId: ana, note: 'peguei' },
    { action: 'TRANSFERRED', actorId: ana, fromUserId: ana, toUserId: bia },
    { action: 'UNASSIGNED', actorId: bia, fromUserId: bia, toUserId: null },
  ]);
  await expectAssignTrail(id);
  const published = {
    type: 'conversation.updated',
    conversationId: id,
    instanceId: db.channelId,
  };
  expect(events.publish.mock.calls).toEqual([
    [published],
    [published],
    [published],
  ]);
}

describe.skipIf(!ENABLED)('assign — assumir, transferir e remover', () => {
  it('aceite 8: assumir, transferir e remover gravam histórico, conversation.assign e conversation.updated', async () => {
    const { ana, bia } = db.ids;
    const id = await newConversation(db);
    const taken = await send(id, 'ana', {
      userId: ana,
      expectedAssigneeId: null,
      note: 'peguei',
    });
    expect(taken).toMatchObject({ status: 'IN_PROGRESS', assignedUserId: ana });
    const input = { userId: bia, expectedAssigneeId: ana };
    expect(await send(id, 'ana', input)).toMatchObject({ assignedUserId: bia });
    const freed = await send(id, 'bia', {
      userId: null,
      expectedAssigneeId: bia,
    });
    expect(freed).toMatchObject({ status: 'PENDING', assignedUserId: null });
    await expectWalkRecorded(id);
  });
});

describe.skipIf(!ENABLED)('assign — quem pode (K1-3, K1-7)', () => {
  it('OPERATOR não atendente remove ou transfere conversa de outro — 403 chat.not_assignee, nada gravado', async () => {
    const id = await assigned('ana');
    const before = await conversationRow(db, id);
    const { ana, admin } = db.ids;
    const attempts = [
      send(id, 'bia', { userId: null, expectedAssigneeId: ana }),
      send(id, 'bia', { userId: admin, expectedAssigneeId: ana }),
    ];
    for (const attempt of attempts) {
      expect(await failure(attempt)).toMatchObject({
        status: 403,
        code: 'chat.not_assignee',
      });
    }
    await expectNothingWritten(id, before);
  });

  it('ADMIN transfere e remove conversa de outro atendente', async () => {
    const { ana, bia, admin } = db.ids;
    const id = await assigned('ana');
    await send(id, 'admin', { userId: bia, expectedAssigneeId: ana });
    await send(id, 'admin', { userId: null, expectedAssigneeId: bia });
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'TRANSFERRED', actorId: admin, fromUserId: ana },
      { action: 'UNASSIGNED', actorId: admin, fromUserId: bia },
    ]);
    expect(await auditRows(db, id)).toHaveLength(2);
  });
});

describe.skipIf(!ENABLED)('assign — conferência condicional (aceite 8)', () => {
  it('aceite 8: expectedAssigneeId diferente — 409 com o atendente atual', async () => {
    const id = await assigned('bia');
    const before = await conversationRow(db, id);
    const error = await failure(
      send(id, 'ana', { userId: db.ids.ana, expectedAssigneeId: null }),
    );
    expect(error).toMatchObject({
      status: 409,
      code: 'chat.conversation_changed',
    });
    expect(JSON.parse(error?.detail ?? '')).toEqual({
      assignee: { id: db.ids.bia, name: 'bia atendente', active: true },
    });
    const stale = send(id, 'admin', {
      userId: db.ids.ana,
      expectedAssigneeId: db.ids.ana,
    });
    expect(await failure(stale)).toMatchObject({ status: 409 });
    await expectNothingWritten(id, before);
  });
});

describe.skipIf(!ENABLED)('assign — destino e conversa (DK6.1)', () => {
  it('aceite 8: destino inativo, sem acesso, SUPERVISOR e VIEWER — 404 user.not_found', async () => {
    const noAccess = {
      hasAccess: false,
      role: 'VIEWER',
      email: null,
      password: null,
    };
    const targets = [
      await person('inativo', { isActive: false }),
      await person('sem-acesso', noAccess),
      await person('supervisor', { role: 'SUPERVISOR' }),
      await person('viewer', { role: 'VIEWER' }),
    ];
    const id = await assigned('ana');
    const before = await conversationRow(db, id);
    for (const userId of targets) {
      const attempt = send(id, 'admin', {
        userId,
        expectedAssigneeId: db.ids.ana,
      });
      expect(await failure(attempt)).toMatchObject({
        status: 404,
        code: 'user.not_found',
      });
    }
    await expectNothingWritten(id, before);
  });

  it('conversa inexistente — 404 conversation.not_found; destino inválido vence (antes da trava)', async () => {
    const bad = send('conv-inexistente', 'admin', {
      userId: 'usuario-inexistente',
      expectedAssigneeId: null,
    });
    expect(await failure(bad)).toMatchObject({ code: 'user.not_found' });
    const missing = send('conv-inexistente', 'ana', {
      userId: db.ids.ana,
      expectedAssigneeId: null,
    });
    expect(await failure(missing)).toMatchObject({
      status: 404,
      code: 'conversation.not_found',
    });
  });
});

/** Resolvida (sem atendente): assumir ou transferir reabre — REOPENED antes da ação (K1-7). */
async function expectReopenedBy(by: Key, userId: string, kind: string) {
  const id = await newConversation(db, { resolvedAt: at(-1) });
  const summary = await send(id, by, { userId, expectedAssigneeId: null });
  expect(summary).toMatchObject({
    status: 'IN_PROGRESS',
    resolvedAt: null,
    assignedUserId: userId,
  });
  expect(await conversationRow(db, id)).toMatchObject({ resolvedAt: null });
  expect(await historyRows(db, id)).toMatchObject([
    { action: 'REOPENED', actorId: db.ids[by] },
    { action: kind, actorId: db.ids[by], toUserId: userId },
  ]);
  expect(events.publish).toHaveBeenCalledTimes(1);
}

describe.skipIf(!ENABLED)('assign — conversa resolvida (K1-7)', () => {
  it('aceite 8: transferir numa resolvida — REOPENED e TRANSFERRED, aberta', () =>
    expectReopenedBy('admin', db.ids.ana, 'TRANSFERRED'));

  it('assumir numa resolvida — REOPENED e ASSUMED, aberta', () =>
    expectReopenedBy('bia', db.ids.bia, 'ASSUMED'));
});

describe.skipIf(!ENABLED)('assign — robô (aceite 9)', () => {
  const botPausedAt = async (id: string) =>
    (await conversationRow(db, id)).botPausedAt;

  it('aceite 9: assumir e transferir pausam; remover não muda botPausedAt; nada zera botPausedAt', async () => {
    const { ana, bia } = db.ids;
    const taken = await newConversation(db);
    const handed = await assigned('ana');
    const kept = await assigned('ana', { botPausedAt: PAST });
    const freed = await assigned('ana');
    await send(taken, 'ana', { userId: ana, expectedAssigneeId: null });
    await send(handed, 'ana', { userId: bia, expectedAssigneeId: ana });
    await send(kept, 'ana', { userId: null, expectedAssigneeId: ana });
    await send(freed, 'ana', { userId: null, expectedAssigneeId: ana });
    expect(await botPausedAt(taken)).not.toBeNull();
    expect(await botPausedAt(handed)).not.toBeNull();
    expect(await botPausedAt(kept)).toEqual(PAST);
    expect(await botPausedAt(freed)).toBeNull();
  });
});

describe.skipIf(!ENABLED)('assign — atendente inativo e sem efeito', () => {
  it('aceite 10: OPERATOR assume conversa de atendente inativo', async () => {
    const gone = await person('saiu', { isActive: false });
    const id = await newConversation(db, {
      assignedUserId: gone,
      assignedAt: T0,
    });
    const stale = await failure(
      send(id, 'bia', { userId: db.ids.bia, expectedAssigneeId: null }),
    );
    expect(JSON.parse(stale?.detail ?? '')).toEqual({
      assignee: { id: gone, name: 'saiu', active: false },
    });
    const summary = await send(id, 'ana', {
      userId: db.ids.ana,
      expectedAssigneeId: gone,
    });
    expect(summary).toMatchObject({
      status: 'IN_PROGRESS',
      assignedUserId: db.ids.ana,
      assignedUserActive: true,
    });
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'ASSUMED', fromUserId: gone, toUserId: db.ids.ana },
    ]);
  });

  it('sem efeito — 200, nenhuma linha, nenhum evento', async () => {
    const mine = await assigned('ana', { botPausedAt: PAST });
    const pending = await newConversation(db);
    const beforeMine = await conversationRow(db, mine);
    const beforePending = await conversationRow(db, pending);
    const again = await send(mine, 'ana', {
      userId: db.ids.ana,
      expectedAssigneeId: db.ids.ana,
    });
    expect(again).toMatchObject({ id: mine, assignedUserId: db.ids.ana });
    const none = await send(pending, 'admin', {
      userId: null,
      expectedAssigneeId: null,
    });
    expect(none).toMatchObject({ id: pending, status: 'PENDING' });
    await expectNothingWritten(mine, beforeMine);
    await expectNothingWritten(pending, beforePending);
  });
});
