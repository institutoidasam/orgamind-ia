import type { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type NewPendencyInput,
  type PendencyDb as TestDb,
} from './team-pendency.test-fixtures';

/**
 * Opt-in (Testcontainers exige Docker):
 *   TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-pendency.count.integration.spec.ts
 * `now` fixo (T0); alertas gravados com `createdAt` explícito. Prazo de ciência
 * de 15 min: alerta de há 30 min está vencido, o de há 5 min não.
 */
const ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const NOW = T0;
const ago = (minutes: number) => at(-minutes);
const FORBIDDEN = { code: 'team_whatsapp.forbidden' };

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
async function boss(role: Role = 'SUPERVISOR'): Promise<Boss> {
  const user = await newTeamUser(db, { role });
  const sector = await newSector(db, { managerId: user.id });
  return { id: user.id, sectorId: sector.id, sectorName: sector.name };
}

type Seed = Partial<Omit<NewPendencyInput, 'dispatchId'>> & { alertAt?: Date };

/** Pendência de um alerta do gestor, no setor dele, enviado há 30 min (prazo de ciência vencido). */
async function seed(b: Boss, over: Seed = {}): Promise<string> {
  const { alertAt = ago(30), ...rest } = over;
  const dispatchId = await newAlert(db, { authorId: b.id, createdAt: alertAt });
  return newPendency(db, {
    dispatchId,
    sectorId: b.sectorId,
    sectorName: b.sectorName,
    ...rest,
  });
}

const count = (actorId: string, batchSize?: number) =>
  service.count(actorId, NOW, batchSize);

describe.skipIf(!ENABLED)(
  'contador — Sem responsável vencida (K2-6, aceite 15)',
  () => {
    it('aceite 15: conta só Sem responsável com prazo de ciência vencido no alcance, sem limite de data', async () => {
      const b = await boss();
      await seed(b, { alertAt: ago(90 * 1440) });
      await seed(b);
      expect(await count(b.id)).toEqual({ unassignedOverdue: 2 });
    });

    it('não conta prazo de ciência em dia, responsável ativo, ciente, encerrada, fora do alcance', async () => {
      const b = await boss();
      const other = await boss();
      await seed(b);
      await seed(b, { alertAt: ago(5) });
      await seed(b, { handlerId: b.id, dueAt: at(30) });
      await seed(b, { handlerId: b.id, dueAt: ago(5) });
      await seed(b, { ackAt: ago(5) });
      await seed(b, { closedAt: ago(5), closedById: b.id, closeReason: 'x' });
      await seed(other);
      expect(await count(b.id)).toEqual({ unassignedOverdue: 1 });
    });

    it('responsável inativo ou fora do alcance conta como Sem responsável', async () => {
      const b = await boss();
      const outsider = await boss();
      const gone = await newTeamUser(db, {
        role: 'SUPERVISOR',
        isActive: false,
      });
      await seed(b, { handlerId: gone.id, dueAt: at(30) });
      await seed(b, { handlerId: outsider.id, dueAt: at(30) });
      await seed(b, { handlerId: b.id, dueAt: at(30) });
      expect(await count(b.id)).toEqual({ unassignedOverdue: 2 });
    });
  },
);

describe.skipIf(!ENABLED)('contador — alcance e lotes (K2-4, DK7)', () => {
  it('DK7: contador acima do teto — conta todas (lotes por cursor), sem truncated', async () => {
    // Pega contador que usa o teto da lista ou só o primeiro lote: com lote de
    // 3 e 5 pendências que contam entre 10 abertas, ele não chega a 5. Lote 5 e
    // 10 passam por lote cheio seguido de lote vazio.
    const b = await boss();
    for (let i = 0; i < 5; i += 1) {
      await seed(b);
      await seed(b, { handlerId: b.id, dueAt: at(30) });
    }
    for (const size of [3, 5, 10]) {
      expect(await count(b.id, size)).toEqual({ unassignedOverdue: 5 });
    }
  });

  it('autor e gestor do setor contam o que veem; o ADMIN conta de todos os setores', async () => {
    const manager = await boss();
    const author = await boss('OPERATOR');
    const admin = await newTeamUser(db, { role: 'ADMIN' });
    const before = (await count(admin.id)).unassignedOverdue;
    const dispatchId = await newAlert(db, {
      authorId: author.id,
      createdAt: ago(30),
    });
    await newPendency(db, {
      dispatchId,
      sectorId: manager.sectorId,
      sectorName: manager.sectorName,
    });
    await seed(author);
    expect(await count(manager.id)).toEqual({ unassignedOverdue: 1 });
    expect(await count(author.id)).toEqual({ unassignedOverdue: 2 });
    expect((await count(admin.id)).unassignedOverdue - before).toBe(2);
  });

  it('aceite 12: não remetente — 403 team_whatsapp.forbidden', async () => {
    const viewer = await newTeamUser(db, { role: 'VIEWER' });
    await newSector(db, { managerId: viewer.id });
    const lonely = await newTeamUser(db, { role: 'SUPERVISOR' });
    for (const author of [viewer, lonely]) {
      const createdAt = ago(30);
      const dispatchId = await newAlert(db, { authorId: author.id, createdAt });
      await newPendency(db, { dispatchId });
      await expect(count(author.id)).rejects.toMatchObject(FORBIDDEN);
    }
    await expect(count('inexistente')).rejects.toMatchObject(FORBIDDEN);
  });
});
