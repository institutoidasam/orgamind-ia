import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import { AuditRepository } from '../../shared/audit/audit.repository';
import { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { ContactsRepository } from '../contacts/contacts.repository';
import type { ContactsService } from '../contacts/contacts.service';
import type { LevelsRepository } from '../levels/levels.repository';
import { SectorPeopleRepository } from '../sector-people/sector-people.repository';
import { SectorPeopleService } from '../sector-people/sector-people.service';
import { SectorPeopleWriteService } from '../sector-people/sector-people-write.service';
import type { ShiftsRepository } from '../shifts/shifts.repository';
import { UserPhoneService } from './user-phone.service';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const SECTOR_TEXT =
  'O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa.';
const LEVEL_TEXT =
  'O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa.';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let users: UsersService;
let sectorPeople: SectorPeopleWriteService;
const ids = {
  admin: '',
  offSector: '',
  onSector: '',
  offLevel: '',
  onLevel: '',
};

function buildServices(): void {
  const db = prisma as never;
  const usersRepo = new UsersRepository(db);
  const audit = new AuditService(new AuditRepository(db), {
    get: () => undefined,
  } as never);
  users = new UsersService(
    usersRepo,
    audit,
    { revokeAllForUser: vi.fn() } as unknown as RefreshService,
    new UserPhoneService(
      usersRepo,
      {} as ContactsService,
      new ContactsRepository(db),
    ),
  );
  const repo = new SectorPeopleRepository(db);
  const people = new SectorPeopleService(
    repo,
    {} as LevelsRepository,
    {} as ShiftsRepository,
  );
  sectorPeople = new SectorPeopleWriteService(people, repo, users, audit);
}

/** Banco real com migrações, um ADMIN, setor ativo e inativo, nível ativo e desativado. */
async function startDatabase(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const admin = { name: 'Adm', email: 'adm@test.local', password: 'x' };
  ids.admin = (
    await prisma.user.create({ data: { ...admin, role: 'ADMIN' } })
  ).id;
  const sector = (name: string, code: string, isActive: boolean) =>
    prisma.sector.create({ data: { name, code, isActive } });
  ids.onSector = (await sector('Setor ativo', 'ATV', true)).id;
  ids.offSector = (await sector('Setor inativo', 'INA', false)).id;
  const level = (name: string, sortOrder: number, isActive: boolean) =>
    prisma.staffLevel.create({ data: { name, sortOrder, isActive } });
  ids.onLevel = (await level('Nível ativo', 1, true)).id;
  ids.offLevel = (await level('Nível desativado', 2, false)).id;
  buildServices();
}

beforeAll(async () => {
  if (TESTCONTAINERS_ENABLED) await startDatabase();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

/** Pessoa sem login, inativa, com o setor e o nível dados. */
async function inactivePerson(sectorId: string | null, levelId: string | null) {
  const { id } = await prisma.user.create({
    data: {
      name: 'Pessoa A',
      hasAccess: false,
      role: 'VIEWER',
      isActive: false,
      sectorId,
      levelId,
    },
  });
  return id;
}

/** Estado gravado e quantidade de eventos de trilha da pessoa. */
async function stateOf(id: string) {
  const row = await prisma.user.findUniqueOrThrow({ where: { id } });
  const events = await prisma.auditEvent.findMany({
    where: { subjectUserId: id },
    select: { action: true },
  });
  return { isActive: row.isActive, sectorId: row.sectorId, events };
}

const reactivate = (userId: string, sectorId: string) =>
  sectorPeople.setStatus(ids.admin, sectorId, userId, {
    isActive: true,
    reason: 'Voltou',
  });

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'Reativação em setor inativo (banco real)',
  () => {
    it('aceite 18: ficha (UsersService.updateUser) — 409 user.sector_inactive; pessoa continua inativa; nenhum evento', async () => {
      const id = await inactivePerson(ids.offSector, null);

      await expect(
        users.updateUser(id, { isActive: true }, ids.admin, {
          reason: 'Volta',
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'user.sector_inactive',
        message: SECTOR_TEXT,
      });

      const state = await stateOf(id);
      expect(state.isActive).toBe(false);
      expect(state.events).toEqual([]);
    });

    it('aceite 18: tela de pessoas do setor (setStatus) — 409 user.sector_inactive com a mesma mensagem', async () => {
      const id = await inactivePerson(ids.offSector, null);

      await expect(reactivate(id, ids.offSector)).rejects.toMatchObject({
        status: 409,
        code: 'user.sector_inactive',
        message: SECTOR_TEXT,
      });

      const state = await stateOf(id);
      expect(state.isActive).toBe(false);
      expect(state.events).toEqual([]);
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'Reativação em nível desativado (banco real)',
  () => {
    it('aceite 18: nível desativado — 409 user.level_inactive nas duas telas', async () => {
      const id = await inactivePerson(ids.onSector, ids.offLevel);
      const expected = {
        status: 409,
        code: 'user.level_inactive',
        message: LEVEL_TEXT,
      };

      await expect(
        users.updateUser(id, { isActive: true }, ids.admin, {
          reason: 'Volta',
        }),
      ).rejects.toMatchObject(expected);
      await expect(reactivate(id, ids.onSector)).rejects.toMatchObject(
        expected,
      );

      const state = await stateOf(id);
      expect(state.isActive).toBe(false);
      expect(state.events).toEqual([]);
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'Reativação trocando setor e nível (banco real)',
  () => {
    it('aceite 18: trocar setor e reativar na mesma gravação — 200 com trilha user.reactivated', async () => {
      const id = await inactivePerson(ids.offSector, ids.offLevel);

      await users.updateUser(
        id,
        { isActive: true, sectorId: ids.onSector, levelId: ids.onLevel },
        ids.admin,
        { reason: 'Voltou em outro setor' },
      );

      const state = await stateOf(id);
      expect(state.isActive).toBe(true);
      expect(state.sectorId).toBe(ids.onSector);
      expect(state.events.map((e) => e.action)).toContain('user.reactivated');
    });

    it('setor informado inativo continua user.sector_invalid', async () => {
      const id = await inactivePerson(ids.onSector, null);

      await expect(
        users.updateUser(
          id,
          { isActive: true, sectorId: ids.offSector },
          ids.admin,
          { reason: 'Volta' },
        ),
      ).rejects.toMatchObject({ status: 409, code: 'user.sector_invalid' });

      expect((await stateOf(id)).isActive).toBe(false);
    });
  },
);
