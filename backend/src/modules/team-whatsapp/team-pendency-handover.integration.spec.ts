import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PendencyHandoverInput } from '../../schemas/contracts/team-pendency.schema';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  at,
  grantPermission,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  T0,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import {
  closedBy,
  heldBy,
  readers,
  setupHandling,
} from './team-pendency.handling.test-fixtures';
import { TeamPendencyHandoverService } from './team-pendency-handover.service';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-handover.integration.spec.ts
 * Passagem das pendências assumidas por quem sai (K3-4, DT4, aceite 28).
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOTE = 'Passei o turno às 18h; cliente aguarda retorno';
const NOT_FOUND = { status: 404, code: 'user.not_found' };

let db: PendencyDb;
let scenario: Awaited<ReturnType<typeof setupHandling>>;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  scenario = await setupHandling(db);
}, 180_000);

afterAll(() => stopPendencyDb(db));

type Request = Omit<PendencyHandoverInput, 'note'> & { note?: string };

/** Passagem em `at(10)` pelo serviço real, com a trilha do banco do teste. */
const handoverAs = (actorId: string, request: Request) =>
  new TeamPendencyHandoverService(
    db.prisma as unknown as PrismaService,
    db.audit,
  ).handover(actorId, { note: NOTE, ...request }, at(10));

describe.skipIf(!ENABLED)('passagem de pendências — o que o destino vê', () => {
  it('aceite 28: transfere as que o destino vê — responsável, prazo now+60, anotação HANDOVER só com a observação, trilha pendency_handover sem texto', async () => {
    const { manager, otherAdmin, seed } = scenario;
    const { rowOf, notesOf, trailOf } = readers(db);
    const live = await seed(heldBy(manager.id));
    const late = await seed({ ...heldBy(manager.id), dueAt: at(5) });
    const result = await handoverAs(manager.id, {
      toUserId: otherAdmin.id,
      pendencyIds: [live, late],
    });
    expect(result).toEqual({
      transferred: [{ id: live }, { id: late }],
      skipped: [],
    });
    expect(await rowOf(late)).toMatchObject({
      pendencyHandlerId: otherAdmin.id,
      pendencyAssignedAt: at(10),
      pendencyDueAt: at(70),
    });
    expect(await notesOf(live)).toMatchObject([
      { kind: 'HANDOVER', text: NOTE, authorId: manager.id },
    ]);
    const [event, ...rest] = await trailOf(late);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: 'team_whatsapp.pendency_handover',
      actorId: manager.id,
      metadata: { kind: 'handover', recipientId: late },
      changes: [
        { field: 'handlerId', before: manager.id, after: otherAdmin.id },
        { field: 'situation', before: 'OVERDUE', after: 'IN_PROGRESS' },
        {
          field: 'dueAt',
          before: at(5).toISOString(),
          after: at(70).toISOString(),
        },
      ],
    });
    expect(JSON.stringify(event)).not.toContain(NOTE);
  });
});

describe.skipIf(!ENABLED)(
  'passagem de pendências — fora do alcance do destino',
  () => {
    it('aceite 28: fora do alcance do destino — pulada, continua com quem sai, sem anotação; a que ele vê passa', async () => {
      const { manager, sector, seed } = scenario;
      const { snapshot, rowOf } = readers(db);
      const dest = await newTeamUser(db, { role: 'OPERATOR' });
      await newSector(db, { managerId: dest.id });
      // Alerta do próprio destino enviado ao setor do gestor: os dois o veem.
      const shared = await newAlert(db, { authorId: dest.id, createdAt: T0 });
      const visible = await newPendency(db, {
        dispatchId: shared,
        sectorId: sector.id,
        ...heldBy(manager.id),
      });
      const hidden = await seed(heldBy(manager.id));
      const before = await snapshot(hidden);
      const result = await handoverAs(manager.id, {
        toUserId: dest.id,
        pendencyIds: [hidden, visible],
      });
      expect(result).toEqual({
        transferred: [{ id: visible }],
        skipped: [{ id: hidden, reason: 'out_of_scope_target' }],
      });
      expect(await snapshot(hidden)).toEqual(before);
      expect((await rowOf(visible)).pendencyHandlerId).toBe(dest.id);
    });
  },
);

describe.skipIf(!ENABLED)('passagem de pendências — pulos', () => {
  it('já ciente, já encerrada e com um terceiro — puladas com o motivo (other_handler, não already_with_target)', async () => {
    const { manager, otherAdmin, seed } = scenario;
    const { snapshot } = readers(db);
    const acked = await seed({ ...heldBy(manager.id), ackAt: at(5) });
    const closed = await seed({
      ...heldBy(manager.id),
      ...closedBy(db.ids.admin),
    });
    const third = await seed(heldBy(db.ids.admin));
    const before = await Promise.all([acked, closed, third].map(snapshot));
    const result = await handoverAs(manager.id, {
      toUserId: otherAdmin.id,
      pendencyIds: [acked, closed, third],
    });
    expect(result).toEqual({
      transferred: [],
      skipped: [
        { id: acked, reason: 'acked' },
        { id: closed, reason: 'closed' },
        { id: third, reason: 'other_handler' },
      ],
    });
    expect(await Promise.all([acked, closed, third].map(snapshot))).toEqual(
      before,
    );
  });
});

describe.skipIf(!ENABLED)('passagem de pendências — não encontrada', () => {
  it('fora do alcance de quem pede ou inexistente — pulada not_found, sem revelar a pendência', async () => {
    const { manager, otherAdmin, dispatchId } = scenario;
    const { snapshot } = readers(db);
    const elsewhere = await newSector(db);
    const foreign = await newPendency(db, {
      dispatchId,
      sectorId: elsewhere.id,
      ...heldBy(manager.id),
    });
    const before = await snapshot(foreign);
    const result = await handoverAs(manager.id, {
      toUserId: otherAdmin.id,
      pendencyIds: [foreign, 'pendencia-inexistente'],
    });
    expect(result).toEqual({
      transferred: [],
      skipped: [
        { id: foreign, reason: 'not_found' },
        { id: 'pendencia-inexistente', reason: 'not_found' },
      ],
    });
    expect(await snapshot(foreign)).toEqual(before);
  });

  it('repetir o pedido — pulada already_with_target; uma anotação HANDOVER e uma trilha por pendência', async () => {
    const { manager, otherAdmin, seed } = scenario;
    const { notesOf, trailOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    const request = { toUserId: otherAdmin.id, pendencyIds: [id] };
    await handoverAs(manager.id, request);
    const again = await handoverAs(manager.id, request);
    expect(again).toEqual({
      transferred: [],
      skipped: [{ id, reason: 'already_with_target' }],
    });
    expect(await notesOf(id)).toHaveLength(1);
    expect(await trailOf(id)).toHaveLength(1);
  });
});

describe.skipIf(!ENABLED)('passagem de pendências — destino do pedido', () => {
  it('aceite 28: destino sem equipe.enviar, inativo, sem acesso, sem setor, igual a quem sai ou inexistente — 404 user.not_found; nada gravado', async () => {
    const { manager, seed } = scenario;
    const { snapshot } = readers(db);
    const id = await seed(heldBy(manager.id));
    const inactive = await newTeamUser(db, { role: 'ADMIN', isActive: false });
    const noAccess = await newTeamUser(db, { role: 'ADMIN', hasAccess: false });
    const noSector = await newTeamUser(db, { role: 'SUPERVISOR' });
    const noKey = await newTeamUser(db, { role: 'OPERATOR' });
    await newSector(db, { managerId: noKey.id });
    const before = await snapshot(id);
    await revokePermission(db, 'OPERATOR', 'equipe.enviar');
    try {
      const targets = [inactive, noAccess, noSector, noKey, manager];
      for (const { id: toUserId } of [...targets, { id: 'inexistente' }]) {
        await expect(
          handoverAs(manager.id, { toUserId, pendencyIds: [id] }),
        ).rejects.toMatchObject(NOT_FOUND);
      }
    } finally {
      await grantPermission(db, 'OPERATOR', 'equipe.enviar');
    }
    expect(await snapshot(id)).toEqual(before);
  });
});

describe.skipIf(!ENABLED)('passagem de pendências — quem pede', () => {
  it('aceite 28: ADMIN passa as de outro; SUPERVISOR pede as de outro — 403 not_handler, nada gravado', async () => {
    const { manager, otherAdmin, seed } = scenario;
    const { rowOf, snapshot, trailOf } = readers(db);
    const id = await seed(heldBy(manager.id));
    const before = await snapshot(id);
    await expect(
      handoverAs(manager.id, {
        fromUserId: otherAdmin.id,
        toUserId: db.ids.admin,
        pendencyIds: [id],
      }),
    ).rejects.toMatchObject({ code: 'team_whatsapp.not_handler' });
    expect(await snapshot(id)).toEqual(before);
    const result = await handoverAs(db.ids.admin, {
      fromUserId: manager.id,
      toUserId: otherAdmin.id,
      pendencyIds: [id],
    });
    expect(result.transferred).toEqual([{ id }]);
    expect((await rowOf(id)).pendencyHandlerId).toBe(otherAdmin.id);
    expect((await trailOf(id))[0]).toMatchObject({ actorId: db.ids.admin });
  });
});

describe.skipIf(!ENABLED)('passagem de pendências — chave relida', () => {
  it('ator relido sem equipe.enviar (papel mudou, token antigo) — 403 auth.permission_denied antes de not_handler; nada gravado', async () => {
    const { manager, otherAdmin, seed } = scenario;
    const { snapshot } = readers(db);
    const id = await seed(heldBy(manager.id));
    const operator = await newTeamUser(db, { role: 'OPERATOR' });
    await newSector(db, { managerId: operator.id });
    const before = await snapshot(id);
    await revokePermission(db, 'OPERATOR', 'equipe.enviar');
    try {
      for (const fromUserId of [undefined, manager.id]) {
        await expect(
          handoverAs(operator.id, {
            fromUserId,
            toUserId: otherAdmin.id,
            pendencyIds: [id],
          }),
        ).rejects.toMatchObject({ code: 'auth.permission_denied' });
      }
    } finally {
      await grantPermission(db, 'OPERATOR', 'equipe.enviar');
    }
    expect(await snapshot(id)).toEqual(before);
  });

  it('não remetente — 403 forbidden, antes do destino e do not_handler', async () => {
    const { manager, seed } = scenario;
    const id = await seed(heldBy(manager.id));
    const lonely = await newTeamUser(db, { role: 'SUPERVISOR' });
    for (const actorId of [lonely.id, 'ator-inexistente']) {
      await expect(
        handoverAs(actorId, {
          fromUserId: manager.id,
          toUserId: 'inexistente',
          pendencyIds: [id],
        }),
      ).rejects.toMatchObject({ code: 'team_whatsapp.forbidden' });
    }
  });
});
