import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PendencySituation } from '../../schemas/contracts/team-pendency.schema';
import {
  at,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb,
} from './team-pendency.test-fixtures';
import { readers, setupHandling } from './team-pendency.handling.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.audit.integration.spec.ts
 *
 * Aceite 23 (DK16): a trilha das cinco ações de tratativa, num caminho só:
 * assumir, registrar contato, transferir, encerrar e reabrir.
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const TEXTS = {
  assume: 'OBS-ASSUMIR-K2',
  contact: 'TEXTO-CONTATO-K2',
  close: 'MOTIVO-ENCERRAR-K2',
};
const PERSON = 'Fulana Teste';
const PHONE = '+5592991110001';

let db: PendencyDb;
let scenario: Awaited<ReturnType<typeof setupHandling>>;
let walkedId = '';

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  scenario = await setupHandling(db);
  walkedId = await walk();
}, 240_000);

afterAll(() => stopPendencyDb(db));

/**
 * O gestor assume (10), registra contato (20) e transfere ao ADMIN (30); o ADMIN
 * encerra (40) e reabre (50). A pessoa tem nome e telefone gravados no destinatário.
 */
async function walk(): Promise<string> {
  const { manager, seed, actions } = scenario;
  const id = await seed({ userName: PERSON });
  await db.prisma.teamWhatsappRecipient.update({
    where: { id },
    data: { phoneE164: PHONE },
  });
  const svc = actions();
  const admin = db.ids.admin;
  await svc.assume(
    manager.id,
    id,
    { expectedHandlerId: null, note: TEXTS.assume },
    at(10),
  );
  await svc.addNote(
    manager.id,
    id,
    { expectedHandlerId: manager.id, text: TEXTS.contact },
    at(20),
  );
  await svc.transfer(
    manager.id,
    id,
    { toUserId: admin, expectedHandlerId: manager.id },
    at(30),
  );
  await svc.close(
    admin,
    id,
    { expectedHandlerId: admin, reason: TEXTS.close },
    at(40),
  );
  await svc.reopen(admin, id, { expectedHandlerId: admin }, at(50));
  return id;
}

type Pair<T> = [before: T, after: T];

/** Os três campos da trilha (DK16), sempre, com antes e depois. */
const fields = (
  handler: Pair<string | null>,
  situation: Pair<PendencySituation>,
  due: Pair<Date | null>,
) => [
  { field: 'handlerId', before: handler[0], after: handler[1] },
  { field: 'situation', before: situation[0], after: situation[1] },
  {
    field: 'dueAt',
    before: due[0]?.toISOString() ?? null,
    after: due[1]?.toISOString() ?? null,
  },
];

/** O que a trilha de cada ação registra no `walk`: ator e os três campos, antes e depois. */
function expectedTrail(managerId: string, adminId: string) {
  const active = ['IN_PROGRESS', 'IN_PROGRESS'] as Pair<PendencySituation>;
  return {
    'team_whatsapp.pendency_assume': {
      actorId: managerId,
      changes: fields(
        [null, managerId],
        ['UNASSIGNED', 'IN_PROGRESS'],
        [null, at(70)],
      ),
    },
    'team_whatsapp.pendency_note': {
      actorId: managerId,
      changes: fields([managerId, managerId], active, [at(70), at(70)]),
    },
    'team_whatsapp.pendency_transfer': {
      actorId: managerId,
      changes: fields([managerId, adminId], active, [at(70), at(90)]),
    },
    'team_whatsapp.pendency_close': {
      actorId: adminId,
      changes: fields(
        [adminId, adminId],
        ['IN_PROGRESS', 'CLOSED'],
        [at(90), at(90)],
      ),
    },
    'team_whatsapp.pendency_reopen': {
      actorId: adminId,
      changes: fields(
        [adminId, adminId],
        ['CLOSED', 'IN_PROGRESS'],
        [at(90), at(110)],
      ),
    },
  };
}

describe.skipIf(!ENABLED)('Trilha — antes e depois', () => {
  it('aceite 23: trilha de assumir, transferir, registrar contato, encerrar e reabrir com antes/depois de handlerId, situation e dueAt', async () => {
    const events = await readers(db).trailOf(walkedId);
    const byAction = new Map(events.map((e) => [e.action, e]));
    expect(events).toHaveLength(5);
    const expected = expectedTrail(scenario.manager.id, db.ids.admin);
    for (const [action, want] of Object.entries(expected)) {
      expect(byAction.get(action)).toMatchObject({
        ...want,
        entity: 'TeamWhatsappRecipient',
        entityId: walkedId,
        metadata: { recipientId: walkedId },
      });
    }
  });
});

describe.skipIf(!ENABLED)('Trilha — sem texto, nome nem telefone', () => {
  it('aceite 23: nenhum AuditEvent contém o texto da anotação, o motivo, nome ou telefone', async () => {
    const admin = await db.prisma.user.findUniqueOrThrow({
      where: { id: db.ids.admin },
      select: { name: true },
    });
    // Os textos existem (nas anotações), então a ausência na trilha é medida de verdade.
    const saved = (await readers(db).notesOf(walkedId)).map((n) => n.text);
    expect(saved.sort()).toEqual(Object.values(TEXTS).sort());
    const events = await db.prisma.auditEvent.findMany({
      where: { entity: 'TeamWhatsappRecipient' },
    });
    const dump = JSON.stringify(events);
    const secrets = [
      ...saved,
      PERSON,
      PHONE,
      scenario.manager.name,
      admin.name,
    ];
    for (const secret of secrets) expect(dump).not.toContain(secret);
  });
});
