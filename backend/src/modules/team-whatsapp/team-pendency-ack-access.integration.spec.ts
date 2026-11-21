import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { findTeamActor } from './team-actor.query';
import { requireAckVisible } from './team-pendency-ack-access';
import {
  T0,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';
import { TeamWhatsappRepository } from './team-whatsapp.repository';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-ack-access.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: TestDb;
let repo: TeamWhatsappRepository;
const service = () => db.prisma as unknown as PrismaService;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  repo = new TeamWhatsappRepository(
    service(),
    new StaffScheduleRepository(service()),
  );
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

/** `requireAckVisible` com o ator relido do banco, como o serviço faz. */
async function checkAccess(
  actorId: string,
  ref: { dispatchId: string; recipientId: string },
): Promise<void> {
  const actor = await findTeamActor(service(), actorId);
  if (actor === null) throw new Error('ator de teste inexistente');
  await requireAckVisible({ prisma: service(), repo }, actor, ref);
}

/** Gestor (SUPERVISOR) de um setor novo. */
async function managerOf() {
  const manager = await newTeamUser(db, { role: 'SUPERVISOR' });
  const sector = await newSector(db, { managerId: manager.id });
  return { manager, sector };
}

/** Alerta (ciência em 15 min) enviado pelo ADMIN: o gestor dos testes não o vê. */
const adminAlert = () =>
  newAlert(db, { authorId: db.ids.admin, createdAt: T0 });

const NOT_FOUND = {
  status: 404,
  code: 'team_whatsapp.dispatch_not_found',
};

async function authorAndAdminPass(): Promise<void> {
  const author = await newTeamUser(db, { role: 'SUPERVISOR' });
  const elsewhere = await newSector(db);
  const dispatchId = await newAlert(db, { authorId: author.id, createdAt: T0 });
  const recipientId = await newPendency(db, {
    dispatchId,
    sectorId: elsewhere.id,
  });
  const ref = { dispatchId, recipientId };
  await expect(checkAccess(author.id, ref)).resolves.toBeUndefined();
  await expect(checkAccess(db.ids.admin, ref)).resolves.toBeUndefined();
}

async function managerOfPersonSectorPasses(): Promise<void> {
  const { manager, sector } = await managerOf();
  const person = await newTeamUser(db, {
    role: 'OPERATOR',
    sectorId: sector.id,
  });
  const dispatchId = await adminAlert();
  const stored = await newPendency(db, { dispatchId, sectorId: sector.id });
  // Envio nominal: sem setor gravado, vale o setor principal atual da pessoa.
  const nominal = await newPendency(db, { dispatchId, userId: person.id });
  for (const recipientId of [stored, nominal]) {
    await expect(
      checkAccess(manager.id, { dispatchId, recipientId }),
    ).resolves.toBeUndefined();
  }
}

async function managerOfOtherSectorGets404(): Promise<void> {
  const mine = await managerOf();
  const other = await managerOf();
  const dispatchId = await adminAlert();
  const recipientId = await newPendency(db, {
    dispatchId,
    sectorId: other.sector.id,
  });
  await expect(
    checkAccess(mine.manager.id, { dispatchId, recipientId }),
  ).rejects.toMatchObject(NOT_FOUND);
}

async function nonAlertGets404NotUnprocessable(): Promise<void> {
  const { manager, sector } = await managerOf();
  const dispatchId = await adminAlert();
  await db.prisma.teamWhatsappDispatch.update({
    where: { id: dispatchId },
    data: { ackDeadlineMinutes: null },
  });
  const recipientId = await newPendency(db, {
    dispatchId,
    sectorId: sector.id,
  });
  await expect(
    checkAccess(manager.id, { dispatchId, recipientId }),
  ).rejects.toMatchObject(NOT_FOUND);
}

async function recipientOfOtherDispatchGets404(): Promise<void> {
  const { manager, sector } = await managerOf();
  const asked = await adminAlert();
  const inOther = await newPendency(db, {
    dispatchId: await adminAlert(),
    sectorId: sector.id,
  });
  const missing = { dispatchId: asked, recipientId: 'inexistente' };
  await expect(
    checkAccess(manager.id, { dispatchId: asked, recipientId: inOther }),
  ).rejects.toMatchObject(NOT_FOUND);
  await expect(checkAccess(manager.id, missing)).rejects.toMatchObject(
    NOT_FOUND,
  );
}

describe.skipIf(!ENABLED)('ciência manual — quem vê o envio passa', () => {
  it(
    'autor ou ADMIN (vê o envio) — passa, mesmo com a pessoa em outro setor',
    authorAndAdminPass,
  );
});

describe.skipIf(!ENABLED)('ciência manual — pendência no alcance', () => {
  it(
    'gestor do setor da pessoa, sem ver o envio — passa (setor gravado e envio nominal)',
    managerOfPersonSectorPasses,
  );
  it(
    'gestor de outro setor, sem ver o envio — 404 dispatchNotFound',
    managerOfOtherSectorGets404,
  );
});

describe.skipIf(!ENABLED)('ciência manual — fora do alcance', () => {
  it(
    'envio que não é alerta, pessoa do setor gerido, sem ver o envio — 404, não 422',
    nonAlertGets404NotUnprocessable,
  );
  it(
    'destinatário de outro envio (ou inexistente) — 404, mesmo no setor gerido',
    recipientOfOtherDispatchGets404,
  );
});
