import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { InternalSectorsRepository } from './internal-sectors.repository';
import { InternalSectorsService } from './internal-sectors.service';

const ACTOR = 'admin-1';
const OTHER_ACTOR = 'admin-2';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let audit: AuditService;
let sectors: InternalSectorsService;

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
  audit = new AuditService(new AuditRepository(prisma as never), {
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

describe('Setores — trilha na transação (A5, GC1; Postgres exclusivo)', () => {
  it('criar e editar grava sector.created e sector.updated com o gestor só { id, name }', async () => {
    const manager = await prisma.user.create({
      data: {
        name: 'Gestora Ana',
        email: 'ana@test.local',
        password: randomUUID(),
        role: 'SUPERVISOR',
      },
    });
    const created = await sectors.create(
      { name: 'Compras', code: 'COM', managerId: manager.id },
      ACTOR,
      'ADMIN',
    );
    await sectors.update(created.id, { managerId: null }, ACTOR, 'ADMIN');

    const events = await prisma.auditEvent.findMany({
      where: { entity: 'Sector', entityId: created.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(events.map((e) => [e.action, e.category, e.actorId])).toEqual([
      ['sector.created', 'STRUCTURE', ACTOR],
      ['sector.updated', 'STRUCTURE', ACTOR],
    ]);
    expect(events[0].changes).toContainEqual({
      field: 'manager',
      before: null,
      after: { id: manager.id, name: 'Gestora Ana' },
    });
    expect(events[1].changes).toEqual([
      {
        field: 'manager',
        before: { id: manager.id, name: 'Gestora Ana' },
        after: null,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('ana@test.local');
  });
});

describe('Setores — falha da trilha desfaz a escrita (GC1)', () => {
  it('se a trilha falhar, a criação e a edição não ficam', async () => {
    const kept = await sectors.create(
      { name: 'Mantido', code: 'MAN' },
      ACTOR,
      'ADMIN',
    );
    const failure = new Error('audit offline');
    const failing = vi.spyOn(audit, 'recordChange').mockRejectedValue(failure);

    try {
      await expect(
        sectors.create({ name: 'Perdido', code: 'PER' }, ACTOR, 'ADMIN'),
      ).rejects.toBe(failure);
      await expect(
        sectors.update(kept.id, { name: 'Renomeado' }, ACTOR, 'ADMIN'),
      ).rejects.toBe(failure);
    } finally {
      failing.mockRestore();
    }

    expect(await prisma.sector.findUnique({ where: { code: 'PER' } })).toBe(
      null,
    );
    expect(
      (await prisma.sector.findUniqueOrThrow({ where: { id: kept.id } })).name,
    ).toBe('Mantido');
  });
});

// A primeira edição para dentro da própria transação, com o setor já travado;
// a chamada interna cai na implementação real (o desvio vale uma vez só).
function stallFirstAuditRecord() {
  const firstInside = deferred();
  const release = deferred();
  const stalled = vi
    .spyOn(audit, 'recordChange')
    .mockImplementationOnce(async (tx, change) => {
      firstInside.resolve();
      await release.promise;
      return audit.recordChange(tx, change);
    });
  return { firstInside, release, stalled };
}

// Espera por condição, com teto: a segunda edição bloqueada no banco.
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

describe('Setores — edições concorrentes do mesmo setor (A5, GC1)', () => {
  it('a trilha da segunda edição parte do valor gravado pela primeira e traz só o que ela mudou', async () => {
    const sector = await sectors.create(
      { name: 'Original', code: 'ORI' },
      ACTOR,
      'ADMIN',
    );
    const { firstInside, release, stalled } = stallFirstAuditRecord();

    try {
      const first = sectors.update(sector.id, { name: 'Alfa' }, ACTOR, 'ADMIN');
      await firstInside.promise;
      const second = sectors.update(
        sector.id,
        { isActive: false },
        OTHER_ACTOR,
        'ADMIN',
      );
      try {
        await waitForBlockedWriter();
      } finally {
        release.resolve();
      }
      await Promise.all([first, second]);
    } finally {
      stalled.mockRestore();
    }

    const events = await prisma.auditEvent.findMany({
      where: {
        entity: 'Sector',
        entityId: sector.id,
        action: 'sector.updated',
      },
    });
    const changesByActor = new Map(
      events.map((e) => [e.actorId, e.changes] as const),
    );
    expect(events).toHaveLength(2);
    expect(changesByActor.get(ACTOR)).toEqual([
      { field: 'name', before: 'Original', after: 'Alfa' },
    ]);
    expect(changesByActor.get(OTHER_ACTOR)).toEqual([
      { field: 'isActive', before: true, after: false },
    ]);
  });
});
