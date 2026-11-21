import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nameView } from '../../shared/authz/phone-visibility';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamAlertPanelService } from './team-alert-panel.service';
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
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

/**
 * Aceite 20 (K2-2, DK18): painel do alerta com `closure`, `getPanel` real contra
 * o Postgres. Opt-in (Testcontainers):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-alert-panel.closure.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const REASON = 'Contato feito por ligação';

let db: TestDb;
let panel: TeamAlertPanelService;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  const prisma = db.prisma as unknown as PrismaService;
  const repo = new TeamWhatsappRepository(
    prisma,
    new StaffScheduleRepository(prisma),
  );
  panel = new TeamAlertPanelService(repo, prisma);
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

type Closed = { closedAt?: Date; closedById?: string; ackAt?: Date };

/** Alerta do ADMIN com duas pessoas sem resposta: `Pessoa A` (encerrada ou não) e `Pessoa B` (aberta). */
async function alertWith(over: Closed) {
  const dispatchId = await newAlert(db, {
    authorId: db.ids.admin,
    createdAt: T0,
  });
  const a = await newPendency(db, {
    dispatchId,
    userName: 'Pessoa A',
    closeReason: over.closedAt ? REASON : undefined,
    ...over,
  });
  await newPendency(db, { dispatchId, userName: 'Pessoa B' });
  return { dispatchId, a };
}

const personOf = async (actorId: string, dispatchId: string, id: string) => {
  const result = await panel.getPanel(actorId, dispatchId);
  return { result, person: result.people.find((p) => p.recipientId === id) };
};

describe.skipIf(!ENABLED)(
  'painel do alerta — closure e grupo (aceite 20)',
  () => {
    it('aceite 20: encerrada continua no mesmo grupo e traz closure com nome e motivo', async () => {
      const closer = await newTeamUser(db, {
        role: 'SUPERVISOR',
        name: 'Gestor S1',
      });
      const { dispatchId, a } = await alertWith({
        closedAt: at(30),
        closedById: closer.id,
      });
      const { result, person } = await personOf(db.ids.admin, dispatchId, a);
      expect(person).toMatchObject({
        group: 'no_reply',
        ack: null,
        closure: {
          at: at(30).toISOString(),
          byName: 'Gestor S1',
          reason: REASON,
        },
      });
      expect(result.counts).toMatchObject({ noReply: 2, acked: 0 });
      expect(result.people.map((p) => p.group)).toEqual([
        'no_reply',
        'no_reply',
      ]);
    });

    it('ciente depois do encerramento — grupo Ciente e closure mantido', async () => {
      const { dispatchId, a } = await alertWith({
        closedAt: at(30),
        closedById: db.ids.bia,
        ackAt: at(40),
      });
      const { result, person } = await personOf(db.ids.admin, dispatchId, a);
      expect(person?.group).toBe('acked');
      expect(person?.ack).toMatchObject({ at: at(40).toISOString() });
      expect(person?.closure).toMatchObject({ byName: 'bia atendente' });
      expect(result.counts).toMatchObject({ noReply: 1, acked: 1 });
    });
  },
);

describe.skipIf(!ENABLED)(
  'painel do alerta — sem encerramento ou sem autor',
  () => {
    it('sem encerramento — closure null', async () => {
      const { dispatchId, a } = await alertWith({});
      const { result, person } = await personOf(db.ids.admin, dispatchId, a);
      expect(person?.closure).toBeNull();
      expect(result.people.map((p) => p.closure)).toEqual([null, null]);
    });

    it('quem encerrou removido — byName null', async () => {
      const { dispatchId, a } = await alertWith({
        closedAt: at(30),
        closedById: 'usuario-removido',
      });
      const { person } = await personOf(db.ids.admin, dispatchId, a);
      expect(person?.closure).toEqual({
        at: at(30).toISOString(),
        byName: null,
        reason: REASON,
      });
    });
  },
);

const PHONE_NAME = '+5592991110001';

/** Alerta de um SUPERVISOR (gestor de setor), encerrado por quem tem nome de telefone. */
async function phoneNamedCloser() {
  const viewer = await newTeamUser(db, { role: 'SUPERVISOR' });
  await newSector(db, { managerId: viewer.id });
  const closer = await newTeamUser(db, { role: 'OPERATOR', name: PHONE_NAME });
  const dispatchId = await newAlert(db, { authorId: viewer.id, createdAt: T0 });
  const a = await newPendency(db, {
    dispatchId,
    closedAt: at(30),
    closedById: closer.id,
    closeReason: REASON,
  });
  return { viewerId: viewer.id, dispatchId, a };
}

describe.skipIf(!ENABLED)('painel do alerta — nome que parece telefone', () => {
  it('nome que parece telefone sai mascarado sem a chave e inteiro com ela', async () => {
    const { viewerId, dispatchId, a } = await phoneNamedCloser();
    const withKey = await personOf(viewerId, dispatchId, a);
    expect(withKey.person?.closure?.byName).toBe(PHONE_NAME);
    await revokePermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    try {
      const masked = (await personOf(viewerId, dispatchId, a)).person;
      expect(masked?.closure?.byName).toBe(
        nameView(PHONE_NAME, { full: false }),
      );
      expect(masked?.closure?.byName).not.toBe(PHONE_NAME);
    } finally {
      await grantPermission(db, 'SUPERVISOR', 'telefone.ver_completo');
    }
  });
});
