import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deployMigrations } from '../../../test/migrations';
import type { AuditService } from '../../shared/audit/audit.service';
import type { RefreshService } from '../auth/refresh.service';
import { ContactsRepository } from '../contacts/contacts.repository';
import type { ContactsService } from '../contacts/contacts.service';
import type { LevelsRepository } from '../levels/levels.repository';
import type { ShiftsRepository } from '../shifts/shifts.repository';
import { StaffScheduleRepository } from '../staff-schedule/staff-schedule.repository';
import { TeamWhatsappRepository } from '../team-whatsapp/team-whatsapp.repository';
import { UserPhoneService } from '../users/user-phone.service';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { SectorPeopleRepository } from './sector-people.repository';
import { SectorPeopleService } from './sector-people.service';
import { SectorPeopleWriteService } from './sector-people-write.service';

const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';

let postgres: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let service: SectorPeopleWriteService;
const ids = { admin: '', operation: '', hr: '', night: '' };

// Contatos já existentes (como os da tela "Dos contatos"); nenhum ligado a pessoa.
async function contact(name: string | null, phoneE164: string) {
  return (await prisma.contact.create({ data: { name, phoneE164 } })).id;
}

function buildService(): SectorPeopleWriteService {
  const db = prisma as never;
  const repo = new SectorPeopleRepository(db);
  const usersRepo = new UsersRepository(db);
  // Os contatos já existem: o UserPhoneService só lê e, sem nome, preenche.
  const contacts = {
    update: (id: string, data: { name: string }) =>
      prisma.contact.update({ where: { id }, data }),
  } as unknown as ContactsService;
  const audit = { log: vi.fn() } as unknown as AuditService;
  const users = new UsersService(
    usersRepo,
    audit,
    { revokeAllForUser: vi.fn() } as unknown as RefreshService,
    new UserPhoneService(usersRepo, contacts, new ContactsRepository(db)),
  );
  const people = new SectorPeopleService(
    repo,
    {} as LevelsRepository,
    {} as ShiftsRepository,
  );
  return new SectorPeopleWriteService(people, repo, users, audit);
}

/** Banco real (testcontainers) com migrações, ADMIN, dois setores e o turno Noite. */
async function startDatabase(): Promise<void> {
  postgres = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('database_test')
    .withUsername(`user_${randomUUID().replaceAll('-', '')}`)
    .withPassword(randomUUID())
    .start();
  const databaseUrl = postgres.getConnectionUri();
  deployMigrations({ databaseUrl });
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  ids.admin = (
    await prisma.user.create({
      data: {
        name: 'Adm',
        email: 'adm@test.local',
        password: 'x',
        role: 'ADMIN',
      },
    })
  ).id;
  ids.operation = (
    await prisma.sector.create({ data: { name: 'Operação', code: 'OPE' } })
  ).id;
  ids.hr = (
    await prisma.sector.create({ data: { name: 'RH', code: 'RH' } })
  ).id;
  ids.night = (
    await prisma.shift.create({
      data: {
        name: 'Noite',
        startTime: '19:00',
        endTime: '07:00',
        sortOrder: 99,
      },
    })
  ).id;
  service = buildService();
}

// Sem TESTCONTAINERS_ENABLED=1 os describes são pulados e o banco não sobe.
beforeAll(async () => {
  if (TESTCONTAINERS_ENABLED) await startDatabase();
}, 240_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await postgres?.stop();
});

/** Outra pessoa (sem acesso) já tem o número, sem ligação ao contato dele. */
async function personWithPhone(phoneE164: string): Promise<void> {
  await prisma.user.create({
    data: { name: 'Paula', hasAccess: false, role: 'VIEWER', phoneE164 },
  });
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'SectorPeopleWriteService — lote real (D10)',
  () => {
    it('dois criados e o terceiro com telefone repetido fica em failed sem desfazer os dois', async () => {
      const first = await contact('Rita', '+5592991110001');
      const second = await contact('Sara', '+5592991110002');
      const taken = await contact('Paula', '+5592991110003');
      await personWithPhone('+5592991110003');

      const result = await service.addFromContacts(ids.admin, ids.operation, {
        contactIds: [first, second, taken],
        levelId: 'level_employee',
        shiftId: ids.night,
      });

      expect(result.failed).toEqual([
        { contactId: taken, reason: 'phone_taken' },
      ]);
      const saved = await prisma.user.findMany({
        where: { sectorId: ids.operation },
        orderBy: { name: 'asc' },
        select: { id: true, contactId: true, levelId: true, shiftId: true },
      });
      const row = (index: number, contactId: string) => ({
        id: result.created[index].id,
        contactId,
        levelId: 'level_employee',
        shiftId: ids.night,
      });
      expect(saved).toEqual([row(0, first), row(1, second)]);
      expect(await prisma.user.count({ where: { contactId: taken } })).toBe(0);
    });
  },
);

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'SectorPeopleWriteService — lote aparece no envio (aceite 1)',
  () => {
    it('depois do lote de 3 contatos com turno Noite no RH, loadDayPeople do RH na data traz os 3 com o turno', async () => {
      const contactIds = [
        await contact('Téo', '+5592991110004'),
        await contact(null, '+5592991110005'),
        await contact('Vera', '+5592991110006'),
      ];

      const result = await service.addFromContacts(ids.admin, ids.hr, {
        contactIds,
        shiftId: ids.night,
      });

      expect(result.failed).toEqual([]);
      expect(result.created.map((p) => p.name)).toEqual([
        'Téo',
        '+5592991110005',
        'Vera',
      ]);
      const team = new TeamWhatsappRepository(
        prisma as never,
        new StaffScheduleRepository(prisma as never),
      );
      const day = await team.loadDayPeople(ids.hr, '2026-10-22');
      expect(
        day.map((p) => [p.id, p.shiftId, p.workShift?.name]).sort(),
      ).toEqual(result.created.map((p) => [p.id, ids.night, 'Noite']).sort());
    });
  },
);
