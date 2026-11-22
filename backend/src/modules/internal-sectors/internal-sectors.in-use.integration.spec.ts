import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { sectorUsageSchema } from '../../schemas/contracts/sector.schema';
import {
  addDays,
  toDbDate,
  todayIn,
  type CivilDate,
} from '../staff-schedule/civil-date';
import { InternalSectorsRepository } from './internal-sectors.repository';
import { InternalSectorsService } from './internal-sectors.service';

const ACTOR = 'admin-1';
const TODAY: CivilDate = todayIn(new Date());
const YESTERDAY = addDays(TODAY, -1);

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let sectors: InternalSectorsService;
let seq = 0;

beforeAll(async () => {
  const credential = randomUUID().replaceAll('-', '');
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${credential}`)
    .withPassword(randomUUID())
    .start();
  const url = postgres.getConnectionUri();
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      stdio: 'inherit',
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: url },
    },
  );
  prisma = new PrismaClient({ datasources: { db: { url } } });
  const audit = new AuditService(new AuditRepository(prisma as never), {
    get: () => undefined,
  } as never);
  sectors = new InternalSectorsService(
    new InternalSectorsRepository(prisma as never),
    audit,
  );
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

function makeSector(isActive = true) {
  seq += 1;
  return prisma.sector.create({
    data: { name: `Setor ${seq}`, code: `S${seq}`, isActive },
  });
}

function makePerson(
  sectorId: string | null,
  data: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  seq += 1;
  return prisma.user.create({
    data: {
      email: `pessoa${seq}@test.local`,
      password: randomUUID(),
      name: `Pessoa ${seq}`,
      role: 'OPERATOR',
      sectorId,
      ...data,
    },
  });
}

/** Exceção OTHER_SECTOR da pessoa apontando para o setor, de `from` até `to`. */
function makeException(
  userId: string,
  sectorId: string,
  from: CivilDate,
  to: CivilDate,
) {
  return prisma.staffScheduleException.create({
    data: {
      userId,
      sectorId,
      kind: 'OTHER_SECTOR',
      startDate: toDbDate(from),
      endDate: toDbDate(to),
    },
  });
}

/** Envio da equipe; com `sectorId` o setor entra nos setores do envio, sem ele é envio a uma pessoa. */
function makeDispatch(
  state: 'SCHEDULED' | 'CANCELLED' | 'DISPATCHED',
  sectorId: string | null,
) {
  return prisma.teamWhatsappDispatch.create({
    data: {
      targetType: sectorId ? 'SECTOR' : 'USER',
      targetId: sectorId ?? 'pessoa-alvo',
      targetLabel: 'Alvo',
      text: 'Aviso de teste',
      state,
      scheduledFor: state === 'SCHEDULED' ? new Date(Date.now() + 36e5) : null,
      sectors: sectorId
        ? { create: [{ sectorId, sectorName: 'Setor do envio' }] }
        : undefined,
    },
  });
}

const deactivate = (id: string) =>
  sectors.update(id, { isActive: false }, ACTOR, 'ADMIN');
const isActive = async (id: string) =>
  (await prisma.sector.findUniqueOrThrow({ where: { id } })).isActive;
const sectorEvents = (id: string) =>
  prisma.auditEvent.count({ where: { entity: 'Sector', entityId: id } });

/** Recusa 409 `sector.in_use` com o `detail` esperado, sem trilha e com o setor ainda ativo. */
async function expectRefused(id: string, detail: string) {
  await expect(deactivate(id)).rejects.toMatchObject({
    code: 'sector.in_use',
    status: 409,
    detail,
  });
  expect(await isActive(id)).toBe(true);
  expect(await sectorEvents(id)).toBe(0);
}

/** A inativação parada na trava do setor, com limite de tempo. */
async function waitForBlockedWriter() {
  await vi.waitFor(
    async () => {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
      expect(Number(waiting)).toBeGreaterThan(0);
    },
    { timeout: 4000, interval: 20 },
  );
}

describe('Setor em uso — pessoas e exceções de escala (E2, aceite 11)', () => {
  it('aceite 11: pessoa ativa — 409 sector.in_use people=1; setor continua ativo; nenhum AuditEvent novo', async () => {
    const sector = await makeSector();
    await makePerson(sector.id);

    await expectRefused(sector.id, 'people=1');
  });

  it('aceite 11: exceção OTHER_SECTOR de hoje em diante de pessoa ativa — 409 exceptions=1', async () => {
    const sector = await makeSector();
    const away = await makePerson(null);
    await makeException(away.id, sector.id, TODAY, addDays(TODAY, 3));

    await expectRefused(sector.id, 'exceptions=1');
  });

  it('aceite 11: exceção de pessoa inativa e exceção que terminou ontem — não bloqueiam', async () => {
    const sector = await makeSector();
    const inactive = await makePerson(null, { isActive: false });
    const active = await makePerson(null);
    await makeException(inactive.id, sector.id, TODAY, addDays(TODAY, 3));
    await makeException(active.id, sector.id, YESTERDAY, YESTERDAY);

    await deactivate(sector.id);

    expect(await isActive(sector.id)).toBe(false);
  });

  it('aceite 11: detail sem nome, e-mail ou telefone', async () => {
    const sector = await makeSector();
    await makePerson(sector.id, {
      name: 'Fulana Reservada',
      email: 'fulana.reservada@test.local',
      phoneE164: '+5592991110001',
    });

    const error = await deactivate(sector.id).catch((e: unknown) => e);

    expect((error as { detail: string }).detail).toBe('people=1');
    expect(JSON.stringify(error)).not.toMatch(/Fulana|reservada|\+55/i);
  });
});

describe('Setor em uso — envios agendados (E2, aceite 11)', () => {
  it('aceite 11: agendado pendente com o setor — 409 scheduled=1; cancelado, já disparado e agendado a uma pessoa não bloqueiam', async () => {
    const sector = await makeSector();
    await makeDispatch('CANCELLED', sector.id);
    await makeDispatch('DISPATCHED', sector.id);
    await makeDispatch('SCHEDULED', null);
    const pending = await makeDispatch('SCHEDULED', sector.id);

    await expectRefused(sector.id, 'scheduled=1');

    await prisma.teamWhatsappDispatch.update({
      where: { id: pending.id },
      data: { state: 'CANCELLED' },
    });
    await deactivate(sector.id);
    expect(await isActive(sector.id)).toBe(false);
  });
});

describe('Setor em uso — a conferência decide a gravação (E2, aceite 12)', () => {
  it('aceite 12: uso criado depois do GET (tela aberta sem uso) — a gravação recusa com 409', async () => {
    const sector = await makeSector();
    const screen = await sectors.get(sector.id, 'ADMIN');
    expect(screen.usage).toMatchObject({ people: 0 });

    await makePerson(sector.id);

    await expectRefused(sector.id, 'people=1');
  });

  it('aceite 12: inativação bloqueada na trava do setor, pessoa ativa do setor criada e commitada por outra conexão, trava solta — 409 sector.in_use, setor continua ativo, nenhum AuditEvent novo', async () => {
    // Molde A do GJ11: este teste FALHA se a conferência de uso rodar fora da
    // transação travada (antes do `SELECT … FOR NO KEY UPDATE` do repositório):
    // ela veria zero uso, a gravação passaria e o 409 esperado não viria.
    const sector = await makeSector();
    let outcome: Promise<unknown> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Sector" WHERE id = ${sector.id} FOR NO KEY UPDATE`;
        outcome = deactivate(sector.id).then(
          () => null,
          (error: unknown) => error,
        );
        await waitForBlockedWriter();
        await makePerson(sector.id);
      },
      { timeout: 15_000 },
    );

    expect(await outcome).toMatchObject({
      code: 'sector.in_use',
      status: 409,
      detail: 'people=1',
    });
    expect(await isActive(sector.id)).toBe(true);
    expect(await sectorEvents(sector.id)).toBe(0);
  });
});

describe('Setor sem uso — inativa sem perder vínculos (E2, aceite 13)', () => {
  it('aceite 13: sem uso — inativa; pessoas inativas continuam com sectorId; UserAssignment e exceções antigas intactos', async () => {
    const sector = await makeSector();
    const former = await makePerson(sector.id, { isActive: false });
    const old = await makeException(former.id, sector.id, YESTERDAY, YESTERDAY);
    const line = await prisma.userAssignment.create({
      data: { userId: former.id, sectorId: sector.id },
    });

    await deactivate(sector.id);

    expect(await isActive(sector.id)).toBe(false);
    const kept = await prisma.user.findUniqueOrThrow({
      where: { id: former.id },
    });
    expect(kept.sectorId).toBe(sector.id);
    expect(
      await prisma.userAssignment.findUnique({ where: { id: line.id } }),
    ).not.toBeNull();
    expect(
      await prisma.staffScheduleException.findUnique({ where: { id: old.id } }),
    ).not.toBeNull();
  });
});

describe('Setor em uso ou inativo — edições livres (E7, aceite 17)', () => {
  it('aceite 17: setor em uso — renomear e trocar o gestor 200 com AuditEvent sector.updated', async () => {
    const sector = await makeSector();
    await makePerson(sector.id);
    const manager = await makePerson(null, { role: 'SUPERVISOR' });

    const updated = await sectors.update(
      sector.id,
      { name: 'Renomeado em uso', managerId: manager.id },
      ACTOR,
      'ADMIN',
    );

    expect(updated).toMatchObject({ name: 'Renomeado em uso', isActive: true });
    const events = await prisma.auditEvent.findMany({
      where: { entity: 'Sector', entityId: sector.id },
    });
    expect(events.map((e) => e.action)).toEqual(['sector.updated']);
  });

  it('aceite 17: setor inativo com dependência legada — reativar 200 com trilha', async () => {
    const sector = await makeSector(false);
    await makePerson(sector.id);

    const reactivated = await sectors.update(
      sector.id,
      { isActive: true },
      ACTOR,
      'ADMIN',
    );

    expect(reactivated.isActive).toBe(true);
    expect(await sectorEvents(sector.id)).toBe(1);
  });
});

describe('Setor — uso na tela (E4)', () => {
  it('GET :id devolve usage com inactivePeople', async () => {
    const sector = await makeSector();
    await makePerson(sector.id);
    await makePerson(sector.id, { isActive: false });
    await makePerson(sector.id, { isActive: false });

    const detail = await sectors.get(sector.id, 'ADMIN');

    expect(sectorUsageSchema.parse(detail.usage)).toEqual({
      people: 1,
      exceptions: 0,
      scheduled: 0,
      inactivePeople: 2,
    });
  });
});
