import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from './team-actor.query';
import {
  findPendencyScopeFacts,
  pendencyScopeWhere,
} from './team-pendency-scope.repository';
import { pendencyScopeOf, scopeAllows } from './team-pendency.rules';
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

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-scope.equivalence.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

type Mass = {
  actors: Record<string, string>;
  recipients: string[];
  dispatches: string[];
};

let db: TestDb;
let mass: Mass;
const service = () => db.prisma as unknown as PrismaService;

/** Pessoas e setores: S1 do supervisor, S2 do operador, S3 sem gestor e S5 de um VIEWER. */
async function seedPeople() {
  const sup = await newTeamUser(db, { role: 'SUPERVISOR' });
  const op = await newTeamUser(db, { role: 'OPERATOR' });
  const viewer = await newTeamUser(db, { role: 'VIEWER' });
  const authorX = await newTeamUser(db, { role: 'OPERATOR' });
  const s1 = await newSector(db, { managerId: sup.id });
  const s2 = await newSector(db, { managerId: op.id });
  const s3 = await newSector(db);
  const s5 = await newSector(db, { managerId: viewer.id });
  const person = (sectorId: string) =>
    newTeamUser(db, { role: 'OPERATOR', sectorId }).then((u) => u.id);
  const people = [
    await person(s1.id),
    await person(s2.id),
    await person(s3.id),
  ];
  return { sup, op, viewer, authorX, s1, s2, s3, s5, people };
}

/** Envio sem prazo de ciência (lembrete de `parent`, ou envio comum). */
async function sendWithoutDeadline(authorId: string, parent?: string) {
  const id = await newAlert(db, { authorId, createdAt: T0 });
  await db.prisma.teamWhatsappDispatch.update({
    where: { id },
    data: { ackDeadlineMinutes: null, parentDispatchId: parent },
  });
  return id;
}

type People = Awaited<ReturnType<typeof seedPeople>>;

/**
 * Setor gravado no envio vence o setor atual da pessoa: S3 (sem gestor) com
 * pessoa de S1 não é de ninguém; S1 com pessoa de S2 é do gestor de S1.
 */
function seedSnapshotOverrides(w: People, dispatchId: string) {
  return Promise.all([
    newPendency(db, { dispatchId, sectorId: w.s3.id, userId: w.people[0] }),
    newPendency(db, { dispatchId, sectorId: w.s1.id, userId: w.people[1] }),
  ]);
}

async function seedMass(): Promise<Mass> {
  const w = await seedPeople();
  const admin = db.ids.admin;
  const alert = (authorId: string) => newAlert(db, { authorId, createdAt: T0 });
  const row = (
    dispatchId: string,
    rest: { sectorId?: string; userId?: string },
  ) => newPendency(db, { dispatchId, ...rest });
  const d1 = await alert(admin);
  const d2 = await alert(w.sup.id);
  const d3 = await alert(w.authorX.id);
  const d4 = await alert(admin);
  const d5 = await sendWithoutDeadline(admin, d1);
  const d6 = await sendWithoutDeadline(admin);
  const recipients = [
    // Por setor gravado: S1, S2, S3 (sem gestor) e S5 (gestor VIEWER).
    ...(await Promise.all(
      [w.s1, w.s2, w.s3, w.s5].map((s) => row(d1, { sectorId: s.id })),
    )),
    // Do supervisor, em S2 e em S3 (alcance por autoria).
    await row(d2, { sectorId: w.s2.id }),
    await row(d2, { sectorId: w.s3.id }),
    // De autor que não é remetente.
    await row(d3, { sectorId: w.s1.id }),
    // Nominais: pessoa em S1, S2, S3 e pessoa removida (sem userId).
    ...(await Promise.all(w.people.map((userId) => row(d4, { userId })))),
    await row(d4, {}),
    // Setor gravado × setor atual da pessoa (ver `seedSnapshotOverrides`).
    ...(await seedSnapshotOverrides(w, d4)),
    // Lembrete e envio que não é alerta, ambos em S1.
    await row(d5, { sectorId: w.s1.id }),
    await row(d6, { sectorId: w.s1.id }),
  ];
  const actors = {
    ADMIN: admin,
    'SUPERVISOR de S1': w.sup.id,
    'OPERATOR de S2': w.op.id,
    'autor sem setor gerido': w.authorX.id,
    VIEWER: w.viewer.id,
  };
  return { actors, recipients, dispatches: [d1, d2, d3, d4, d5, d6] };
}

beforeAll(async () => {
  if (!ENABLED) return;
  db = await startPendencyDb();
  mass = await seedMass();
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

async function scopeOfActor(actorId: string) {
  return pendencyScopeOf(await findTeamActor(service(), actorId));
}

/** O que a consulta do banco entrega ao ator dentro da massa. */
async function viaDatabase(actorId: string): Promise<string[]> {
  const where = pendencyScopeWhere(await scopeOfActor(actorId));
  if (where === null) return [];
  const rows = await db.prisma.teamWhatsappRecipient.findMany({
    where: { AND: [where, { dispatchId: { in: mass.dispatches } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id).sort();
}

/** O que a regra em memória (T2) deixa passar, sobre os fatos de cada linha da massa. */
async function viaMemory(actorId: string): Promise<string[]> {
  const scope = await scopeOfActor(actorId);
  const allowed: string[] = [];
  for (const id of mass.recipients) {
    const facts = await findPendencyScopeFacts(db.prisma, id);
    if (facts !== null && scopeAllows(scope, facts)) allowed.push(id);
  }
  return allowed.sort();
}

// Alcance esperado em linhas (o total da massa é 15; lembrete e envio sem prazo
// de ciência nunca entram), para a igualdade não valer por vazio nos dois lados.
const ACTORS: Array<[string, number]> = [
  ['ADMIN', 13],
  ['SUPERVISOR de S1', 6],
  ['OPERATOR de S2', 3],
  ['autor sem setor gerido', 0],
  ['VIEWER', 0],
];

describe.skipIf(!ENABLED)('alcance — consulta × regra em memória', () => {
  // Pega a consulta e a regra em memória divergindo (ex.: um dos dois esquece
  // `isAlert`, o setor atual da pessoa no envio nominal ou o autor do alerta).
  it.each(ACTORS)(
    'DK3: pendencyScopeWhere e scopeAllows concordam para %s em toda a massa',
    async (label, expected) => {
      const actorId = mass.actors[label];
      const fromDatabase = await viaDatabase(actorId);
      expect(fromDatabase).toEqual(await viaMemory(actorId));
      expect(fromDatabase).toHaveLength(expected);
    },
  );
});
