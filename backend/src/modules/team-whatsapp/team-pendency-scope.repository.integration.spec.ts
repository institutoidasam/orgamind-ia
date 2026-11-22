import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from './team-actor.query';
import {
  findPendencyScopeFacts,
  pendencyScopeWhere,
  requireVisiblePendency,
} from './team-pendency-scope.repository';
import { pendencyScopeOf, type PendencyScope } from './team-pendency.rules';
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
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency-scope.repository.integration.spec.ts
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let db: TestDb;
const service = () => db.prisma as unknown as PrismaService;

beforeAll(async () => {
  if (ENABLED) db = await startPendencyDb();
}, 180_000);

afterAll(async () => {
  if (ENABLED) await stopPendencyDb(db);
});

const sorted = (...ids: string[]): string[] => [...ids].sort();

/** Quais de `ids` o banco entrega ao ator pelo `pendencyScopeWhere` (ator relido do banco). */
async function visibleTo(actorId: string, ids: string[]): Promise<string[]> {
  const scope = pendencyScopeOf(await findTeamActor(service(), actorId));
  return visibleThrough(scope, ids);
}

/** O mesmo, para um alcance dado (a regra do ator não entra). */
async function visibleThrough(
  scope: PendencyScope,
  ids: string[],
): Promise<string[]> {
  const where = pendencyScopeWhere(scope);
  if (where === null) return [];
  const rows = await db.prisma.teamWhatsappRecipient.findMany({
    where: { AND: [where, { id: { in: ids } }] },
    select: { id: true },
  });
  return sorted(...rows.map((row) => row.id));
}

/** Gestor ativo (remetente) de um setor novo e ativo. */
async function managerOf(role: Role = 'SUPERVISOR') {
  const manager = await newTeamUser(db, { role });
  const sector = await newSector(db, { managerId: manager.id });
  return { manager, sector };
}

/** Envio de alerta de `authorId` (ciência em 15 min). */
const alertBy = (authorId: string) => newAlert(db, { authorId, createdAt: T0 });

/** Envio sem prazo de ciência: sozinho ou, com `parentDispatchId`, lembrete. */
async function sendWithoutDeadline(
  authorId: string,
  parentDispatchId?: string,
): Promise<string> {
  const id = await alertBy(authorId);
  await db.prisma.teamWhatsappDispatch.update({
    where: { id },
    data: { ackDeadlineMinutes: null, parentDispatchId },
  });
  return id;
}

async function seedAdminScopeCase(): Promise<{
  author: string;
  alertRows: string[];
  excluded: string[];
}> {
  const { manager, sector } = await managerOf();
  const alert = await alertBy(manager.id);
  const alertRows = [
    await newPendency(db, { dispatchId: alert, sectorId: sector.id }),
    await newPendency(db, { dispatchId: alert }),
  ];
  const reminder = await sendWithoutDeadline(manager.id, alert);
  const plain = await sendWithoutDeadline(manager.id);
  const excluded = [
    await newPendency(db, { dispatchId: reminder, sectorId: sector.id }),
    await newPendency(db, { dispatchId: plain, sectorId: sector.id }),
  ];
  return { author: manager.id, alertRows, excluded };
}

describe.skipIf(!ENABLED)('alcance no banco — quem vê o quê', () => {
  it('K2-1: ADMIN — todas as pendências de alerta; destinatário de lembrete e de envio sem prazo de ciência fora', async () => {
    const { author, alertRows, excluded } = await seedAdminScopeCase();
    const all = [...alertRows, ...excluded];
    expect(await visibleTo(db.ids.admin, all)).toEqual(sorted(...alertRows));
    // O alcance por autoria e por setor também exige o prazo de ciência.
    expect(await visibleTo(author, all)).toEqual(sorted(...alertRows));
  });

  it('aceite 12: SUPERVISOR vê as do setor que gere, inclusive em alerta de outro autor', async () => {
    const mine = await managerOf();
    const other = await managerOf();
    const alert = await alertBy(other.manager.id);
    const own = await newPendency(db, {
      dispatchId: alert,
      sectorId: mine.sector.id,
    });
    const foreign = await newPendency(db, {
      dispatchId: alert,
      sectorId: other.sector.id,
    });
    expect(await visibleTo(mine.manager.id, [own, foreign])).toEqual([own]);
  });

  it('aceite 12: vê as dos alertas que enviou; não vê as demais', async () => {
    const mine = await managerOf();
    const other = await managerOf();
    const sent = await newPendency(db, {
      dispatchId: await alertBy(mine.manager.id),
      sectorId: other.sector.id,
    });
    const notSent = await newPendency(db, {
      dispatchId: await alertBy(other.manager.id),
      sectorId: other.sector.id,
    });
    expect(await visibleTo(mine.manager.id, [sent, notSent])).toEqual([sent]);
  });
});

async function seedNominalAfterMove() {
  const first = await managerOf();
  const second = await managerOf();
  const person = await newTeamUser(db, {
    role: 'OPERATOR',
    sectorId: first.sector.id,
  });
  const alert = await alertBy(db.ids.admin);
  const nominal = await newPendency(db, {
    dispatchId: alert,
    userId: person.id,
  });
  // Envio por setor: o setor gravado vale, mesmo que a pessoa mude depois.
  const snapshot = await newPendency(db, {
    dispatchId: alert,
    userId: person.id,
    sectorId: first.sector.id,
  });
  return { first, second, person, nominal, snapshot };
}

async function seedRemovedPerson() {
  const boss = await managerOf();
  const author = await managerOf();
  const person = await newTeamUser(db, {
    role: 'OPERATOR',
    sectorId: boss.sector.id,
  });
  const row = await newPendency(db, {
    dispatchId: await alertBy(author.manager.id),
    userId: person.id,
  });
  return { boss, author, person, row };
}

describe.skipIf(!ENABLED)('alcance no banco — setor da pessoa', () => {
  it('aceite 13: envio nominal usa o setor principal atual da pessoa (troca de setor depois do envio muda o alcance)', async () => {
    const { first, second, person, nominal, snapshot } =
      await seedNominalAfterMove();
    expect(await visibleTo(first.manager.id, [nominal])).toEqual([nominal]);
    await db.prisma.user.update({
      where: { id: person.id },
      data: { sectorId: second.sector.id },
    });
    const both = [nominal, snapshot];
    expect(await visibleTo(first.manager.id, both)).toEqual([snapshot]);
    expect(await visibleTo(second.manager.id, both)).toEqual([nominal]);
  });

  it('pessoa removida (userId nulo) em envio nominal — só ADMIN e autor', async () => {
    const { boss, author, person, row } = await seedRemovedPerson();
    expect(await visibleTo(boss.manager.id, [row])).toEqual([row]);
    await db.prisma.user.delete({ where: { id: person.id } });
    expect(await visibleTo(boss.manager.id, [row])).toEqual([]);
    expect(await visibleTo(author.manager.id, [row])).toEqual([row]);
    expect(await visibleTo(db.ids.admin, [row])).toEqual([row]);
  });
});

async function seedOrphanSector() {
  const orphan = await newSector(db);
  const author = await managerOf();
  const outsider = await managerOf();
  const row = await newPendency(db, {
    dispatchId: await alertBy(author.manager.id),
    sectorId: orphan.id,
  });
  return { author, outsider, row };
}

async function seedActiveAndInactiveSectors() {
  const supervisor = await newTeamUser(db, { role: 'SUPERVISOR' });
  const active = await newSector(db, { managerId: supervisor.id });
  const inactive = await newSector(db, {
    managerId: supervisor.id,
    isActive: false,
  });
  const alert = await alertBy(db.ids.admin);
  return {
    supervisor,
    inActive: await newPendency(db, { dispatchId: alert, sectorId: active.id }),
    inInactive: await newPendency(db, {
      dispatchId: alert,
      sectorId: inactive.id,
    }),
  };
}

async function seedLoneInactiveManager() {
  const lone = await newTeamUser(db, { role: 'SUPERVISOR' });
  const sector = await newSector(db, { managerId: lone.id, isActive: false });
  const own = await newPendency(db, {
    dispatchId: await alertBy(lone.id),
    sectorId: sector.id,
  });
  return { lone, own };
}

describe.skipIf(!ENABLED)('alcance no banco — setor do gestor', () => {
  it('K2-9: setor sem gestor — só ADMIN e autor', async () => {
    const { author, outsider, row } = await seedOrphanSector();
    expect(await visibleTo(db.ids.admin, [row])).toEqual([row]);
    expect(await visibleTo(author.manager.id, [row])).toEqual([row]);
    expect(await visibleTo(outsider.manager.id, [row])).toEqual([]);
  });

  it('setor gerido inativo não dá alcance', async () => {
    const { supervisor, inActive, inInactive } =
      await seedActiveAndInactiveSectors();
    const visible = await visibleTo(supervisor.id, [inActive, inInactive]);
    expect(visible).toEqual([inActive]);
  });

  it('alcance limitado sem nenhum setor — só o que o ator enviou (lista vazia não vale tudo)', async () => {
    const { author, outsider, row } = await seedOrphanSector();
    const scope = (actorId: string): PendencyScope => ({
      kind: 'limited',
      actorId,
      sectorIds: [],
    });
    expect(await visibleThrough(scope(author.manager.id), [row])).toEqual([
      row,
    ]);
    expect(await visibleThrough(scope(outsider.manager.id), [row])).toEqual([]);
  });

  it('só setor gerido inativo — deixa de ser remetente: nenhuma consulta e nada visível, nem o que enviou', async () => {
    const { lone, own } = await seedLoneInactiveManager();
    const scope = pendencyScopeOf(await findTeamActor(service(), lone.id));
    expect(pendencyScopeWhere(scope)).toBeNull();
    expect(await visibleTo(lone.id, [own])).toEqual([]);
  });
});

async function seedFactsCase() {
  const { manager, sector } = await managerOf();
  const person = await newTeamUser(db, {
    role: 'OPERATOR',
    sectorId: sector.id,
  });
  const alert = await alertBy(manager.id);
  const nominal = await newPendency(db, {
    dispatchId: alert,
    userId: person.id,
  });
  const plain = await sendWithoutDeadline(manager.id);
  const noDeadline = await newPendency(db, {
    dispatchId: plain,
    sectorId: 'setor-gravado',
  });
  return { manager, sector, alert, nominal, noDeadline };
}

describe.skipIf(!ENABLED)('alcance no banco — fatos', () => {
  it('findPendencyScopeFacts — inexistente null; isAlert, authorId, sectorId e personSectorId', async () => {
    expect(await findPendencyScopeFacts(db.prisma, 'inexistente')).toBeNull();
    const { manager, sector, alert, nominal, noDeadline } =
      await seedFactsCase();
    expect(await findPendencyScopeFacts(db.prisma, nominal)).toEqual({
      dispatchId: alert,
      isAlert: true,
      authorId: manager.id,
      sectorId: null,
      personSectorId: sector.id,
    });
    expect(await findPendencyScopeFacts(db.prisma, noDeadline)).toMatchObject({
      isAlert: false,
      sectorId: 'setor-gravado',
      personSectorId: null,
    });
  });
});

async function seedGateCase() {
  const viewer = await newTeamUser(db, { role: 'VIEWER' });
  const mine = await managerOf();
  const other = await managerOf();
  const alert = await alertBy(mine.manager.id);
  const inScope = await newPendency(db, {
    dispatchId: alert,
    sectorId: mine.sector.id,
  });
  const outOfScope = await newPendency(db, {
    dispatchId: await alertBy(other.manager.id),
    sectorId: other.sector.id,
  });
  return { viewer, manager: mine.manager, alert, inScope, outOfScope };
}

const FORBIDDEN = { code: 'team_whatsapp.forbidden', status: 403 };
const NOT_FOUND = { code: 'team_whatsapp.pendency_not_found', status: 404 };
const requireAs = (actorId: string, recipientId: string) =>
  requireVisiblePendency(service(), actorId, recipientId);

describe.skipIf(!ENABLED)('alcance no banco — porta das rotas', () => {
  it('requireVisiblePendency — não remetente 403 team_whatsapp.forbidden; fora do alcance e inexistente 404 pendency_not_found; no alcance devolve ator e fatos', async () => {
    const { viewer, manager, alert, inScope, outOfScope } =
      await seedGateCase();
    // 403 vem antes do 404: o não remetente não descobre se a pendência existe.
    await expect(requireAs(viewer.id, inScope)).rejects.toMatchObject(
      FORBIDDEN,
    );
    await expect(requireAs(viewer.id, 'inexistente')).rejects.toMatchObject(
      FORBIDDEN,
    );
    await expect(requireAs(manager.id, outOfScope)).rejects.toMatchObject(
      NOT_FOUND,
    );
    await expect(requireAs(manager.id, 'inexistente')).rejects.toMatchObject(
      NOT_FOUND,
    );
    const found = await requireAs(manager.id, inScope);
    expect(found.actor).toMatchObject({ id: manager.id, role: 'SUPERVISOR' });
    expect(found.facts).toMatchObject({ dispatchId: alert, isAlert: true });
  });
});
