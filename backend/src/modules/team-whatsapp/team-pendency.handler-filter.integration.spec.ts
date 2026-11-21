import type { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pendencyListQuerySchema,
  type TeamPendencyList,
} from '../../schemas/contracts/team-pendency.schema';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TeamPendencyService } from './team-pendency.service';
import {
  T0,
  at,
  newAlert,
  newPendency,
  newSector,
  newTeamUser,
  startPendencyDb,
  stopPendencyDb,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.handler-filter.integration.spec.ts
 * Filtro `handlerId` da lista (K3-4, DT4): vem depois do alcance de quem olha.
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOW = T0;

let db: TestDb;
let service: TeamPendencyService;

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  service = new TeamPendencyService(db.prisma as unknown as PrismaService);
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

type Boss = { id: string; sectorId: string; sectorName: string };

/** Gestor ativo (remetente) de um setor novo. */
async function boss(role: Role): Promise<Boss> {
  const user = await newTeamUser(db, { role });
  const sector = await newSector(db, { managerId: user.id });
  return { id: user.id, sectorId: sector.id, sectorName: sector.name };
}

/** Pendência de um alerta do gestor, no setor dele, enviado há 30 min. */
async function seed(
  b: Boss,
  handlerId?: string,
  dueAt?: Date,
): Promise<string> {
  const dispatchId = await newAlert(db, {
    authorId: b.id,
    createdAt: at(-30),
  });
  return newPendency(db, {
    dispatchId,
    sectorId: b.sectorId,
    sectorName: b.sectorName,
    handlerId,
    assignedAt: handlerId === undefined ? undefined : at(-20),
    dueAt,
  });
}

/** Lista com a consulta já passada pelo schema do contrato (padrões e coerção reais). */
const run = (actorId: string, raw: Record<string, string> = {}) =>
  service.list(actorId, pendencyListQuerySchema.parse(raw), NOW);

const idsOf = (list: TeamPendencyList): string[] =>
  list.items.map((item) => item.id).sort();

describe.skipIf(!ENABLED)(
  'lista com handlerId — responsável no alcance (K3-4, aceite 28)',
  () => {
    it('lista com handlerId — só as daquele responsável, dentro do alcance de quem olha', async () => {
      const carla = await boss('SUPERVISOR');
      const bruno = await boss('OPERATOR');
      const alice = await newTeamUser(db, { role: 'ADMIN' });
      const inProgress = await seed(carla, alice.id, at(30));
      const overdue = await seed(carla, alice.id, at(-5));
      const hidden = await seed(bruno, alice.id, at(30));
      const ofCarla = await seed(carla, carla.id, at(30));
      await seed(carla);
      // Carla só vê o que está no setor dela: a de Alice no setor de Bruno não entra.
      expect(idsOf(await run(carla.id, { handlerId: alice.id }))).toEqual(
        [inProgress, overdue].sort(),
      );
      // O ADMIN vê tudo: a do setor de Bruno entra, a de Carla não (outro responsável).
      expect(idsOf(await run(alice.id, { handlerId: alice.id }))).toEqual(
        [inProgress, overdue, hidden].sort(),
      );
      expect(idsOf(await run(carla.id, { handlerId: carla.id }))).toEqual([
        ofCarla,
      ]);
    });

    it('handlerId combina com situations, sectorId e mine', async () => {
      const carla = await boss('SUPERVISOR');
      const alice = await newTeamUser(db, { role: 'ADMIN' });
      const inProgress = await seed(carla, alice.id, at(30));
      const overdue = await seed(carla, alice.id, at(-5));
      const base = { handlerId: alice.id };
      const overdueOnly = { ...base, situations: 'OVERDUE' };
      expect(idsOf(await run(carla.id, overdueOnly))).toEqual([overdue]);
      const inSector = { ...base, sectorId: carla.sectorId };
      expect(idsOf(await run(carla.id, inSector))).toEqual(
        [inProgress, overdue].sort(),
      );
      expect(
        idsOf(await run(carla.id, { ...base, sectorId: 'outro' })),
      ).toEqual([]);
      expect(idsOf(await run(carla.id, { ...base, mine: 'true' }))).toEqual([]);
      expect(idsOf(await run(alice.id, { ...base, mine: 'true' }))).toEqual(
        [inProgress, overdue].sort(),
      );
    });
  },
);
