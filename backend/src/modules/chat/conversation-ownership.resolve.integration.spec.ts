import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import type { DomainError } from '../../shared/errors/domain.error';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/chat/conversation-ownership.resolve.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

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

const actor = (key: 'admin' | 'ana' | 'bia') => ({
  id: db.ids[key],
  role: key === 'admin' ? 'ADMIN' : 'OPERATOR',
});
/** Pedido como a tela manda: atendente e `lastInboundAt` que ela mostrava. */
const body = (over: object = {}) => ({
  expectedAssigneeId: db.ids.ana as string | null,
  expectedLastInboundAt: T0.toISOString() as string | null,
  ...over,
});
const assigned = (to: 'ana' | 'bia', over: object = {}) =>
  newConversation(db, { assignedUserId: db.ids[to], assignedAt: T0, ...over });

/** Nada gravado e nenhum evento publicado (a conversa segue como estava). */
async function expectUntouched(id: string, assignee: string | null) {
  expect(await conversationRow(db, id)).toMatchObject({
    assignedUserId: assignee,
    resolvedAt: null,
  });
  expect(await historyRows(db, id)).toEqual([]);
  expect(await auditRows(db, id)).toEqual([]);
  expect(events.publish).not.toHaveBeenCalled();
}

/** Trilha `conversation.assign` do Resolver: atendente → vazio, sem a observação (DK7). */
async function expectAssignTrail(id: string, actorId: string, note: string) {
  const [event] = await auditRows(db, id);
  expect(event).toMatchObject({
    action: 'conversation.assign',
    actorId,
    changes: [{ field: 'assignedUserId', before: db.ids.ana, after: null }],
  });
  expect(JSON.stringify(event)).not.toContain(note);
}

describe.skipIf(!ENABLED)('resolve — quem resolve (K1-3)', () => {
  it('aceite 2: atendente resolve com observação — RESOLVED, sem atendente, linha com a observação, AuditEvent conversation.assign after null sem note, conversation.updated', async () => {
    const id = await assigned('ana');
    const before = Date.now();
    const summary = await service.resolve(
      id,
      actor('ana'),
      body({ note: 'resolvido por telefone' }),
    );
    expect(summary).toMatchObject({
      id,
      status: 'RESOLVED',
      assignedUserId: null,
    });
    const row = await conversationRow(db, id);
    expect(row).toMatchObject({ assignedUserId: null, assignedAt: null });
    expect(row.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(await historyRows(db, id)).toMatchObject([
      {
        action: 'RESOLVED',
        actorId: db.ids.ana,
        fromUserId: db.ids.ana,
        toUserId: null,
        note: 'resolvido por telefone',
      },
    ]);
    await expectAssignTrail(id, db.ids.ana, 'resolvido por telefone');
    expect(events.publish).toHaveBeenCalledExactlyOnceWith({
      type: 'conversation.updated',
      conversationId: id,
      instanceId: db.channelId,
    });
  });

  it('aceite 2: ADMIN resolve conversa de outro', async () => {
    const id = await assigned('ana');
    await service.resolve(id, actor('admin'), body());
    expect(await conversationRow(db, id)).toMatchObject({
      assignedUserId: null,
    });
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'RESOLVED', actorId: db.ids.admin, fromUserId: db.ids.ana },
    ]);
    expect(await auditRows(db, id)).toMatchObject([{ actorId: db.ids.admin }]);
  });
});

describe.skipIf(!ENABLED)('resolve — negações (K1-3)', () => {
  it('aceite 2: OPERATOR não atendente — 403 chat.not_assignee, nada gravado', async () => {
    const id = await assigned('ana');
    await expect(
      service.resolve(id, actor('bia'), body()),
    ).rejects.toMatchObject({
      status: 403,
      code: 'chat.not_assignee',
    });
    await expectUntouched(id, db.ids.ana);
  });

  it('Pendente: OPERATOR não resolve (403); ADMIN resolve', async () => {
    const id = await newConversation(db);
    const pending = body({ expectedAssigneeId: null });
    await expect(
      service.resolve(id, actor('ana'), pending),
    ).rejects.toMatchObject({
      status: 403,
      code: 'chat.not_assignee',
    });
    await expectUntouched(id, null);
    await service.resolve(id, actor('admin'), pending);
    expect((await conversationRow(db, id)).resolvedAt).not.toBeNull();
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'RESOLVED', fromUserId: null },
    ]);
    expect(await auditRows(db, id)).toEqual([]);
  });
});

describe.skipIf(!ENABLED)('resolve — gravação condicional (aceite 3)', () => {
  it('aceite 3: expectedLastInboundAt diferente — 409 chat.conversation_changed, nada gravado, nenhum evento', async () => {
    const id = await assigned('ana');
    const stale = body({ expectedLastInboundAt: at(-1).toISOString() });
    await expect(
      service.resolve(id, actor('ana'), stale),
    ).rejects.toMatchObject({
      status: 409,
      code: 'chat.conversation_changed',
    });
    await expectUntouched(id, db.ids.ana);
  });

  it('aceite 3: atendente trocado — 409 com detail do atual', async () => {
    const id = await assigned('bia');
    const error = await service.resolve(id, actor('ana'), body()).then(
      () => null,
      (e: unknown) => e as DomainError,
    );
    expect(error).toMatchObject({
      status: 409,
      code: 'chat.conversation_changed',
    });
    expect(JSON.parse(error?.detail ?? '')).toEqual({
      assignee: { id: db.ids.bia, name: 'bia atendente', active: true },
    });
    await expectUntouched(id, db.ids.bia);
  });

  it('já resolvida — 409 e a linha do histórico não duplica', async () => {
    const id = await newConversation(db, { resolvedAt: at(-1) });
    await expect(
      service.resolve(id, actor('admin'), body({ expectedAssigneeId: null })),
    ).rejects.toMatchObject({ status: 409, code: 'chat.conversation_changed' });
    expect(await historyRows(db, id)).toEqual([]);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('conversa inexistente — 404 antes do 403', async () => {
    await expect(
      service.resolve('conv-inexistente', actor('bia'), body()),
    ).rejects.toMatchObject({ status: 404, code: 'conversation.not_found' });
  });
});

describe.skipIf(!ENABLED)('reopen e robô (aceite 4 e 9)', () => {
  it('aceite 4: reabrir manual por OPERATOR — Pendente, REOPENED com o ator, conversation.updated; aberta — 409', async () => {
    const id = await newConversation(db, { resolvedAt: at(-1) });
    const summary = await service.reopen(id, actor('ana'), {
      note: 'cliente voltou',
    });
    expect(summary).toMatchObject({ id, status: 'PENDING', resolvedAt: null });
    expect(await conversationRow(db, id)).toMatchObject({
      resolvedAt: null,
      assignedUserId: null,
    });
    expect(await historyRows(db, id)).toMatchObject([
      { action: 'REOPENED', actorId: db.ids.ana, note: 'cliente voltou' },
    ]);
    expect(await auditRows(db, id)).toEqual([]);
    expect(events.publish).toHaveBeenCalledExactlyOnceWith({
      type: 'conversation.updated',
      conversationId: id,
      instanceId: db.channelId,
    });
    await expect(service.reopen(id, actor('ana'), {})).rejects.toMatchObject({
      status: 409,
      code: 'chat.conversation_changed',
    });
    expect(await historyRows(db, id)).toHaveLength(1);
  });

  it('aceite 9: resolver e reabrir não mudam botPausedAt', async () => {
    const paused = await assigned('ana', { botPausedAt: at(-5) });
    const free = await assigned('ana');
    for (const id of [paused, free]) {
      await service.resolve(id, actor('ana'), body());
      await service.reopen(id, actor('ana'), {});
    }
    expect((await conversationRow(db, paused)).botPausedAt).toEqual(at(-5));
    expect((await conversationRow(db, free)).botPausedAt).toBeNull();
  });
});
