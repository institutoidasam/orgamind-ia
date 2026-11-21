import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  at,
  grantPermission,
  newSector,
  newTeamUser,
  revokePermission,
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

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.transfer.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: PendencyDb;
let scenario: Awaited<ReturnType<typeof setupHandling>>;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  scenario = await setupHandling(db);
}, 180_000);

afterAll(() => stopPendencyDb(db));

/** Transferir em `at(10)`: `expected` é o responsável que a tela mostrava. */
const transferAs = (
  actorId: string,
  id: string,
  toUserId: string,
  expected: string | null,
) =>
  scenario
    .actions()
    .transfer(actorId, id, { toUserId, expectedHandlerId: expected }, at(10));

describe.skipIf(!ENABLED)('Transferir — o responsável passa a outro', () => {
  it('aceite 17: transferir pelo responsável — destino responsável, prazo recomeça, trilha pendency_transfer, sem anotação', async () => {
    const { manager, seed } = scenario;
    const { rowOf, notesOf, trailOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    await transferAs(manager.id, id, db.ids.admin, manager.id);
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: db.ids.admin,
      pendencyAssignedAt: at(10),
      pendencyDueAt: at(70),
    });
    expect(await notesOf(id)).toEqual([]);
    const [event, ...rest] = await trailOf(id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: 'team_whatsapp.pendency_transfer',
      actorId: manager.id,
      metadata: { recipientId: id },
      changes: [
        { field: 'handlerId', before: manager.id, after: db.ids.admin },
        { field: 'situation', before: 'IN_PROGRESS', after: 'IN_PROGRESS' },
        {
          field: 'dueAt',
          before: at(61).toISOString(),
          after: at(70).toISOString(),
        },
      ],
    });
  });

  it('ADMIN transfere pendência de outro e sem responsável', async () => {
    const { manager, otherAdmin, seed } = scenario;
    const { rowOf } = readers(db);
    const held = await seed(heldBy(manager.id));
    await transferAs(db.ids.admin, held, otherAdmin.id, manager.id);
    expect((await rowOf(held)).pendencyHandlerId).toBe(otherAdmin.id);
    const free = await seed();
    await transferAs(db.ids.admin, free, manager.id, null);
    expect(await rowOf(free)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyAssignedAt: at(10),
      pendencyDueAt: at(70),
    });
  });
});

describe.skipIf(!ENABLED)('Transferir — fora do período', () => {
  it('ações valem para pendência fora do período de 7 dias', async () => {
    const { manager, seed, actions } = scenario;
    const { rowOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    const later = at(40 * 24 * 60);
    await actions().transfer(
      manager.id,
      id,
      { toUserId: db.ids.admin, expectedHandlerId: manager.id },
      later,
    );
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: db.ids.admin,
      pendencyAssignedAt: later,
      pendencyDueAt: at(40 * 24 * 60 + 60),
    });
  });
});

describe.skipIf(!ENABLED)('Transferir — destino', () => {
  it('aceite 17: destino inativo, sem acesso, sem equipe.enviar, que não vê a pendência ou inexistente — 404 user.not_found, nada gravado', async () => {
    const { manager, seed } = scenario;
    const { snapshot } = readers(db);
    const id = await seed(heldBy(manager.id));
    const inactive = await newTeamUser(db, { role: 'ADMIN', isActive: false });
    const noAccess = await newTeamUser(db, { role: 'ADMIN', hasAccess: false });
    const elsewhere = await newTeamUser(db, { role: 'SUPERVISOR' });
    await newSector(db, { managerId: elsewhere.id });
    const targets = [
      inactive.id,
      noAccess.id,
      elsewhere.id,
      db.ids.ana,
      'usuario-inexistente',
    ];
    const before = await snapshot(id);
    for (const target of targets) {
      await expect(
        transferAs(manager.id, id, target, manager.id),
      ).rejects.toMatchObject({ status: 404, code: 'user.not_found' });
    }
    // O gestor perde a chave: ele continua vendo a pendência, mas não a recebe.
    await revokePermission(db, 'SUPERVISOR', 'equipe.enviar');
    try {
      const admin = db.ids.admin;
      await expect(
        transferAs(admin, id, manager.id, manager.id),
      ).rejects.toMatchObject({ status: 404, code: 'user.not_found' });
    } finally {
      await grantPermission(db, 'SUPERVISOR', 'equipe.enviar');
    }
    expect(await snapshot(id)).toEqual(before);
  });
});

describe.skipIf(!ENABLED)('Transferir — nada a fazer e estado mudou', () => {
  it('transferir para o próprio responsável mostrado — 204 sem gravar; se mudou no meio, 409 pendency_changed', async () => {
    const { manager, seed } = scenario;
    const { snapshot } = readers(db);
    const id = await seed(heldBy(manager.id));
    const before = await snapshot(id);
    await transferAs(manager.id, id, manager.id, manager.id);
    expect(await snapshot(id)).toEqual(before);

    const moved = await seed(heldBy(db.ids.admin));
    const movedBefore = await snapshot(moved);
    await expect(
      transferAs(manager.id, moved, manager.id, manager.id),
    ).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.pendency_changed',
    });
    expect(await snapshot(moved)).toEqual(movedBefore);
  });

  it('transferir ciente, encerrada ou com responsável trocado — 409 pendency_changed', async () => {
    const { manager, seed } = scenario;
    const { snapshot } = readers(db);
    const rows = [
      await seed({ ...heldBy(manager.id), ackAt: at(5) }),
      await seed({ ...heldBy(manager.id), ...closedBy(db.ids.admin) }),
      await seed(heldBy(db.ids.admin)),
    ];
    for (const id of rows) {
      const before = await snapshot(id);
      await expect(
        transferAs(manager.id, id, db.ids.admin, manager.id),
      ).rejects.toMatchObject({
        status: 409,
        code: 'team_whatsapp.pendency_changed',
      });
      expect(await snapshot(id)).toEqual(before);
    }
  });
});

describe.skipIf(!ENABLED)('Transferir e Registrar contato — quem trata', () => {
  it.each(['transfer', 'addNote'] as const)(
    'aceite 16: não responsável nem ADMIN — 403 not_handler em %s',
    async (action) => {
      const { manager, seed, actions } = scenario;
      const { snapshot } = readers(db);
      const call = (id: string, expected: string | null) =>
        action === 'transfer'
          ? transferAs(manager.id, id, db.ids.admin, expected)
          : actions().addNote(
              manager.id,
              id,
              { expectedHandlerId: expected, text: 'Liguei' },
              at(10),
            );
      const byAdmin = await seed(heldBy(db.ids.admin));
      const free = await seed();
      for (const [id, expected] of [
        [byAdmin, db.ids.admin],
        [free, null],
      ] as const) {
        const before = await snapshot(id);
        await expect(call(id, expected)).rejects.toMatchObject({
          status: 403,
          code: 'team_whatsapp.not_handler',
        });
        expect(await snapshot(id)).toEqual(before);
      }
    },
  );
});
