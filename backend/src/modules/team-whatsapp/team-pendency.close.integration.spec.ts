import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  at,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import {
  closedBy,
  heldBy,
  readers,
  setupHandling,
} from './team-pendency.handling.test-fixtures';
import { TeamPendencyService } from './team-pendency.service';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.close.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const REASON = 'Sem retorno do setor';

let db: PendencyDb;
let scenario: Awaited<ReturnType<typeof setupHandling>>;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  scenario = await setupHandling(db);
}, 180_000);

afterAll(() => stopPendencyDb(db));

/** Encerrar em `at(10)`: `expected` é o responsável que a tela mostrava. */
const closeAs = (actorId: string, id: string, expected: string | null) =>
  scenario
    .actions()
    .close(
      actorId,
      id,
      { expectedHandlerId: expected, reason: REASON },
      at(10),
    );

/** Reabrir em `at(20)`. */
const reopenAs = (actorId: string, id: string, expected: string | null) =>
  scenario
    .actions()
    .reopen(actorId, id, { expectedHandlerId: expected }, at(20));

/** O item como a tela o lê, em `at(30)` (a pendência aberta ainda está no prazo). */
const itemOf = (actorId: string, id: string) =>
  new TeamPendencyService(db.prisma as unknown as PrismaService).get(
    actorId,
    id,
    at(30),
  );

describe.skipIf(!ENABLED)('Encerrar e Reabrir — quem trata', () => {
  it.each(['close', 'reopen'] as const)(
    'aceite 16: não responsável nem ADMIN — 403 not_handler em %s',
    async (action) => {
      const { manager, seed } = scenario;
      const { snapshot } = readers(db);
      // Reabrir só vale para encerrada; a porta (403) vem antes de olhar isso.
      const closed = action === 'reopen' ? closedBy(db.ids.admin) : {};
      const byAdmin = await seed({ ...heldBy(db.ids.admin), ...closed });
      const free = await seed(closed);
      for (const [id, expected] of [
        [byAdmin, db.ids.admin],
        [free, null],
      ] as const) {
        const before = await snapshot(id);
        const call =
          action === 'close'
            ? closeAs(manager.id, id, expected)
            : reopenAs(manager.id, id, expected);
        await expect(call).rejects.toMatchObject({
          status: 403,
          code: 'team_whatsapp.not_handler',
        });
        expect(await snapshot(id)).toEqual(before);
      }
    },
  );

  it('ADMIN encerra pendência de outro e pendência sem responsável', async () => {
    const { manager, seed } = scenario;
    const { rowOf } = readers(db);
    const held = await seed(heldBy(manager.id));
    await closeAs(db.ids.admin, held, manager.id);
    expect(await rowOf(held)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyClosedAt: at(10),
      pendencyClosedById: db.ids.admin,
    });
    const free = await seed();
    await closeAs(db.ids.admin, free, null);
    expect(await rowOf(free)).toMatchObject({
      pendencyHandlerId: null,
      pendencyDueAt: null,
      pendencyClosedAt: at(10),
      pendencyClosedById: db.ids.admin,
      pendencyCloseReason: REASON,
    });
  });
});

describe.skipIf(!ENABLED)('Encerrar — a tratativa', () => {
  it('aceite 18: encerrar grava encerramento e anotação CLOSE; Encerrada sem ciência; ackAt continua nulo', async () => {
    const { manager, seed } = scenario;
    const { rowOf, notesOf, trailOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    await closeAs(manager.id, id, manager.id);
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyAssignedAt: at(1),
      pendencyDueAt: at(61),
      pendencyClosedAt: at(10),
      pendencyClosedById: manager.id,
      pendencyCloseReason: REASON,
      ackAt: null,
      ackKind: null,
    });
    const [note, ...others] = await notesOf(id);
    expect(others).toEqual([]);
    expect(note).toMatchObject({
      kind: 'CLOSE',
      text: REASON,
      authorId: manager.id,
      createdAt: at(10),
    });
    expect(await itemOf(manager.id, id)).toMatchObject({
      situation: 'CLOSED',
      ack: null,
      closure: { reason: REASON, byId: manager.id },
    });
    const [event, ...rest] = await trailOf(id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: 'team_whatsapp.pendency_close',
      actorId: manager.id,
      metadata: { recipientId: id, noteId: note.id },
    });
  });
});

describe.skipIf(!ENABLED)('Encerrar — recusas de estado', () => {
  it('aceite 18: encerrar com ciência — 422 ack_exists; já encerrada ou responsável trocado — 409 pendency_changed', async () => {
    const { manager, seed } = scenario;
    const { snapshot } = readers(db);
    const acked = await seed({ ...heldBy(manager.id), ackAt: at(5) });
    const closed = await seed({
      ...heldBy(manager.id),
      ...closedBy(db.ids.admin),
    });
    const moved = await seed(heldBy(db.ids.admin));
    const cases = [
      [acked, 422, 'team_whatsapp.ack_exists'],
      [closed, 409, 'team_whatsapp.pendency_changed'],
      [moved, 409, 'team_whatsapp.pendency_changed'],
    ] as const;
    for (const [id, status, code] of cases) {
      const before = await snapshot(id);
      await expect(closeAs(manager.id, id, manager.id)).rejects.toMatchObject({
        status,
        code,
      });
      expect(await snapshot(id)).toEqual(before);
    }
  });
});

describe.skipIf(!ENABLED)('Reabrir — volta à tratativa', () => {
  it('aceite 18: reabrir encerrada sem ciência — Em tratativa, mesmo responsável, prazo novo, encerramento limpo, anotação CLOSE mantida', async () => {
    const { manager, seed } = scenario;
    const { rowOf, notesOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    await closeAs(manager.id, id, manager.id);
    await reopenAs(manager.id, id, manager.id);
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyAssignedAt: at(1),
      pendencyDueAt: at(80),
      pendencyClosedAt: null,
      pendencyClosedById: null,
      pendencyCloseReason: null,
      ackAt: null,
    });
    expect((await notesOf(id)).map((n) => [n.kind, n.text])).toEqual([
      ['CLOSE', REASON],
    ]);
    expect(await itemOf(manager.id, id)).toMatchObject({
      situation: 'IN_PROGRESS',
      closure: null,
      handler: { id: manager.id },
    });
  });

  it('reabrir encerrada pelo ADMIN sem responsável — Sem responsável, dueAt nulo', async () => {
    const { seed } = scenario;
    const { rowOf } = readers(db);
    const id = await seed(closedBy(db.ids.admin));
    await reopenAs(db.ids.admin, id, null);
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: null,
      pendencyDueAt: null,
      pendencyClosedAt: null,
      pendencyClosedById: null,
      pendencyCloseReason: null,
    });
    expect(await itemOf(db.ids.admin, id)).toMatchObject({
      situation: 'UNASSIGNED',
      handler: null,
      closure: null,
    });
  });
});

describe.skipIf(!ENABLED)('Reabrir — recusas de estado', () => {
  it('reabrir aberta, ciente ou com responsável trocado — 409 pendency_changed, nada gravado', async () => {
    const { manager, seed } = scenario;
    const { snapshot } = readers(db);
    const closed = closedBy(db.ids.admin);
    const rows = [
      await seed(heldBy(manager.id)),
      await seed({ ...heldBy(manager.id), ...closed, ackAt: at(7) }),
      await seed({ ...heldBy(db.ids.admin), ...closed }),
    ];
    for (const id of rows) {
      const before = await snapshot(id);
      await expect(reopenAs(manager.id, id, manager.id)).rejects.toMatchObject({
        status: 409,
        code: 'team_whatsapp.pendency_changed',
      });
      expect(await snapshot(id)).toEqual(before);
    }
  });
});
