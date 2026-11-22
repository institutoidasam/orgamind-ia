import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import {
  T0,
  at,
  grantPermission,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  revokePermission,
  startPendencyDb,
  stopPendencyDb,
  type NewPendencyInput,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import { TeamPendencyActionsService } from './team-pendency-actions.service';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.assume.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: PendencyDb;
let manager: { id: string; name: string };
let sector: { id: string; name: string };
let dispatchId = '';

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  // Gestor (SUPERVISOR) do setor: vê o que o ADMIN enviou a esse setor.
  manager = await newTeamUser(db, { role: 'SUPERVISOR' });
  sector = await newSector(db, { managerId: manager.id });
  dispatchId = await newAlert(db, { authorId: db.ids.admin, createdAt: T0 });
}, 180_000);

afterAll(() => stopPendencyDb(db));

const actions = () =>
  new TeamPendencyActionsService(
    db.prisma as unknown as PrismaService,
    db.audit,
  );

/** Pendência do setor do gestor, aberta e sem responsável, salvo o que `extra` disser. */
const seed = (extra: Partial<NewPendencyInput> = {}) =>
  newPendency(db, { dispatchId, sectorId: sector.id, ...extra });

/** Assumir em `at(10)`: `expected` é o responsável que a tela mostrava. */
const assumeAs = (
  actorId: string,
  id: string,
  expected: string | null,
  note?: string,
) =>
  actions().assume(actorId, id, { expectedHandlerId: expected, note }, at(10));

const rowOf = (id: string) =>
  db.prisma.teamWhatsappRecipient.findUniqueOrThrow({ where: { id } });
const notesOf = (id: string) =>
  db.prisma.teamPendencyNote.findMany({ where: { recipientId: id } });
const trailOf = (id: string) =>
  db.prisma.auditEvent.findMany({
    where: { entity: 'TeamWhatsappRecipient', entityId: id },
  });

/** Linha, anotações e trilha: uma recusa não muda nenhum dos três. */
const snapshot = async (id: string) => ({
  row: await rowOf(id),
  notes: await notesOf(id),
  trail: await trailOf(id),
});

/** Pendência já assumida por `handlerId` em `at(1)`, com prazo até `at(61)`. */
const heldBy = (handlerId: string) => ({
  handlerId,
  assignedAt: at(1),
  dueAt: at(61),
});
/** Encerrada pelo ADMIN em `at(5)`. */
const closedByAdmin = () => ({
  closedAt: at(5),
  closedById: db.ids.admin,
  closeReason: 'Resolvido',
});

describe.skipIf(!ENABLED)('Assumir — grava responsável e prazo', () => {
  it('aceite 16: assumir sem responsável — responsável, dueAt = now + 60 min, Em tratativa, trilha kind assume', async () => {
    const id = await seed();
    await assumeAs(manager.id, id, null);
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyAssignedAt: at(10),
      pendencyDueAt: at(70),
    });
    const [event, ...rest] = await trailOf(id);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: 'team_whatsapp.pendency_assume',
      actorId: manager.id,
      metadata: { dispatchId, recipientId: id, kind: 'assume' },
      changes: [
        { field: 'handlerId', before: null, after: manager.id },
        { field: 'situation', before: 'UNASSIGNED', after: 'IN_PROGRESS' },
        { field: 'dueAt', before: null, after: at(70).toISOString() },
      ],
    });
    expect(await notesOf(id)).toEqual([]);
  });

  it('aceite 16: responsável inativo ou fora do alcance — quem vê assume com expected = id dele', async () => {
    const gone = await newTeamUser(db, { role: 'SUPERVISOR', isActive: false });
    const away = await newTeamUser(db, { role: 'SUPERVISOR' });
    await newSector(db, { managerId: away.id });
    for (const handler of [gone, away]) {
      const id = await seed(heldBy(handler.id));
      await assumeAs(manager.id, id, handler.id);
      expect(await rowOf(id)).toMatchObject({
        pendencyHandlerId: manager.id,
        pendencyDueAt: at(70),
      });
      const kinds = (await trailOf(id)).map((event) => event.metadata);
      expect(kinds).toEqual([{ dispatchId, recipientId: id, kind: 'assume' }]);
    }
  });
});

describe.skipIf(!ENABLED)('Assumir de outro — prazo e anotação', () => {
  it('aceite 17: assumir de outro com observação — prazo recomeça, anotação ASSUME, trilha kind take_over sem o texto', async () => {
    const id = await seed(heldBy(db.ids.admin));
    const text = 'Peguei porque o responsável saiu';
    await assumeAs(manager.id, id, db.ids.admin, text);
    expect(await rowOf(id)).toMatchObject({
      pendencyHandlerId: manager.id,
      pendencyAssignedAt: at(10),
      pendencyDueAt: at(70),
    });
    expect(await notesOf(id)).toMatchObject([
      { kind: 'ASSUME', authorId: manager.id, text, createdAt: at(10) },
    ]);
    const [event] = await trailOf(id);
    expect(event.metadata).toMatchObject({ kind: 'take_over' });
    expect(JSON.stringify(event)).not.toContain(text);
  });
});

describe.skipIf(!ENABLED)('Assumir — estado que mudou, 409', () => {
  it('assumir com outro já responsável — 409 pendency_taken com id e nome', async () => {
    const id = await seed(heldBy(db.ids.admin));
    const before = await snapshot(id);
    await expect(assumeAs(manager.id, id, null)).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.pendency_taken',
      detail: JSON.stringify({
        handler: { id: db.ids.admin, name: 'Zé Admin' },
      }),
    });
    expect(await snapshot(id)).toEqual(before);
  });

  it('assumir de outro com responsável trocado — 409 pendency_changed', async () => {
    const id = await seed(heldBy(db.ids.ana));
    const before = await snapshot(id);
    await expect(assumeAs(manager.id, id, db.ids.admin)).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.pendency_changed',
      detail: JSON.stringify({
        handler: { id: db.ids.ana, name: 'Ana Atendente' },
      }),
    });
    expect(await snapshot(id)).toEqual(before);
  });

  it('ciente ou encerrada — 409 pendency_changed, nada gravado', async () => {
    const acked = await seed({ ackAt: at(5) });
    const closed = await seed(closedByAdmin());
    for (const id of [acked, closed]) {
      const before = await snapshot(id);
      await expect(assumeAs(manager.id, id, null)).rejects.toMatchObject({
        status: 409,
        code: 'team_whatsapp.pendency_changed',
        detail: JSON.stringify({ handler: null }),
      });
      expect(await snapshot(id)).toEqual(before);
    }
  });
});

describe.skipIf(!ENABLED)('Assumir — responsável sem nome no 409', () => {
  it('responsável sem nome — 409 pendency_taken com detail handler null (front mostra "Outra pessoa")', async () => {
    const unnamed = await newTeamUser(db, { role: 'OPERATOR' });
    await db.prisma.user.update({
      where: { id: unnamed.id },
      data: { name: null },
    });
    const id = await seed(heldBy(unnamed.id));
    await expect(assumeAs(manager.id, id, null)).rejects.toMatchObject({
      status: 409,
      code: 'team_whatsapp.pendency_taken',
      detail: JSON.stringify({ handler: null }),
    });
  });
});

describe.skipIf(!ENABLED)('Assumir — "nada a fazer" (DK11)', () => {
  it('expected = eu, ainda meu e aberta — 204 sem gravar nem AuditEvent', async () => {
    const id = await seed(heldBy(manager.id));
    const before = await snapshot(id);
    await expect(
      assumeAs(manager.id, id, manager.id, 'observação ignorada'),
    ).resolves.toBeUndefined();
    const after = await snapshot(id);
    expect(after).toEqual(before);
    expect([after.notes, after.trail]).toEqual([[], []]);
  });

  it('expected = eu, mas ficou ciente, foi encerrada ou transferida — 409 pendency_changed (conferido na linha travada)', async () => {
    const mine = heldBy(manager.id);
    const rows = [
      await seed({ ...mine, ackAt: at(5) }),
      await seed({ ...mine, ...closedByAdmin() }),
      await seed(heldBy(db.ids.admin)),
    ];
    for (const id of rows) {
      await expect(assumeAs(manager.id, id, manager.id)).rejects.toMatchObject({
        status: 409,
        code: 'team_whatsapp.pendency_changed',
      });
      expect(await trailOf(id)).toEqual([]);
    }
  });
});

describe.skipIf(!ENABLED)('Assumir — autorização', () => {
  it('fora do alcance — 404 pendency_not_found antes de olhar o estado; não remetente — 403 forbidden', async () => {
    const away = await newSector(db);
    const hidden = await newPendency(db, {
      dispatchId,
      sectorId: away.id,
      ackAt: at(5),
    });
    await expect(assumeAs(manager.id, hidden, null)).rejects.toMatchObject({
      status: 404,
      code: 'team_whatsapp.pendency_not_found',
    });
    const visible = await seed();
    await expect(assumeAs(db.ids.ana, visible, null)).rejects.toMatchObject({
      status: 403,
      code: 'team_whatsapp.forbidden',
    });
    expect((await rowOf(visible)).pendencyHandlerId).toBeNull();
  });

  it('sem equipe.enviar no banco — 403 auth.permission_denied mesmo vendo a pendência (o guard já barra pelo token)', async () => {
    const id = await seed();
    await revokePermission(db, 'SUPERVISOR', 'equipe.enviar');
    try {
      await expect(assumeAs(manager.id, id, null)).rejects.toMatchObject({
        status: 403,
        code: 'auth.permission_denied',
      });
    } finally {
      await grantPermission(db, 'SUPERVISOR', 'equipe.enviar');
    }
    expect((await rowOf(id)).pendencyHandlerId).toBeNull();
  });
});

describe.skipIf(!ENABLED)('Assumir — nome do responsável no 409', () => {
  it('nome do responsável no 409 sai por nameView: nome-telefone mascarado sem telefone.ver_completo', async () => {
    const named = await newTeamUser(db, {
      role: 'SUPERVISOR',
      name: '+55 92 99111-0001',
    });
    const id = await seed(heldBy(named.id));
    await revokePermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    try {
      await expect(assumeAs(manager.id, id, null)).rejects.toMatchObject({
        code: 'team_whatsapp.pendency_taken',
        detail: JSON.stringify({
          handler: { id: named.id, name: '•••• 0001' },
        }),
      });
    } finally {
      await grantPermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    }
  });
});
