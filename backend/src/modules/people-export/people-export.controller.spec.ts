import type { INestApplication } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Role } from '@prisma/client';
import type { Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionsWith } from '../../shared/authz/actor.test-fixtures';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { UserThrottlerGuard } from '../../shared/throttler/user-throttler.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsService } from '../permissions/permissions.service';
import { StaffScheduleModule } from '../staff-schedule/staff-schedule.module';
import { StaffScheduleService } from '../staff-schedule/staff-schedule.service';
import { PeopleExportController } from './people-export.controller';
import type { PeopleExportQueryDto } from './dto/people-export-query.dto';
import { peopleTooLarge } from './people-export.errors';
import { PeopleExportModule } from './people-export.module';
import { PeopleExportService } from './people-export.service';
import { ScheduleExportService } from './schedule-export.service';

const ACTOR = 'user_1';
const PEOPLE = '/internal/people-export/people';
const SCHEDULE = '/internal/people-export/schedule';
const WINDOW = 'sectorId=sector_1&from=2026-11-01&to=2026-11-30';

const openApps: INestApplication[] = [];

/**
 * O app na ordem real: ator (JWT; o header `x-test-user` troca o usuário),
 * `RolesGuard`, `PermissionsGuard`, `UserThrottlerGuard` (armazenamento em
 * memória, teto global como no `AppModule`), pipe Zod e filtro globais.
 */
async function exportApp(role: Role = 'ADMIN') {
  const people = { exportPeople: vi.fn() };
  const schedule = { exportSchedule: vi.fn() };
  const authenticate = {
    canActivate: (ctx: {
      switchToHttp(): {
        getRequest(): { user?: unknown; headers: Record<string, string> };
      };
    }) => {
      const req = ctx.switchToHttp().getRequest();
      req.user = { sub: req.headers['x-test-user'] ?? ACTOR, role };
      return true;
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 100 }] }),
    ],
    controllers: [PeopleExportController],
    providers: [
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: PeopleExportService, useValue: people },
      { provide: ScheduleExportService, useValue: schedule },
      {
        provide: PermissionsService,
        useValue: {
          effectiveFor: (r: Role) => Promise.resolve(permissionsWith(r)),
        },
      },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
      { provide: APP_GUARD, useValue: authenticate },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_GUARD, useClass: UserThrottlerGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  openApps.push(app);
  return { server: app.getHttpServer() as never, people, schedule };
}

/** O serviço entrega o arquivo escrevendo na resposta que recebeu. */
function sendFile(...args: unknown[]): void {
  const res = args[2] as Response;
  res.setHeader('X-Test', 'recebida');
  res.end('arquivo');
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('PeopleExportController — rotas de download', () => {
  it('people repassa o id do usuário, a query e a resposta ao serviço', async () => {
    const { server, people } = await exportApp();
    people.exportPeople.mockImplementation(sendFile);

    const res = await request(server).get(
      `${PEOPLE}?format=csv&sectorId=sector_1&actorId=outro_usuario`,
    );

    expect(res.status).toBe(200);
    expect(res.headers['x-test']).toBe('recebida');
    expect(res.text).toBe('arquivo');
    expect(people.exportPeople).toHaveBeenCalledWith(
      ACTOR,
      { format: 'csv', sectorId: 'sector_1', status: 'active' },
      expect.anything(),
    );
  });

  it('schedule repassa o id do usuário, a query e a resposta ao serviço', async () => {
    const { server, schedule } = await exportApp();
    schedule.exportSchedule.mockImplementation(sendFile);

    const res = await request(server).get(
      `${SCHEDULE}?format=xlsx&${WINDOW}&actorId=outro_usuario`,
    );

    expect(res.status).toBe(200);
    expect(res.headers['x-test']).toBe('recebida');
    expect(res.text).toBe('arquivo');
    expect(schedule.exportSchedule).toHaveBeenCalledWith(
      ACTOR,
      {
        format: 'xlsx',
        sectorId: 'sector_1',
        from: '2026-11-01',
        to: '2026-11-30',
      },
      expect.anything(),
    );
  });
});

describe('PeopleExportController — limite de 20 downloads por minuto por usuário', () => {
  /** Status de `count` downloads seguidos da rota, feitos pelo usuário `user`. */
  async function statuses(
    server: never,
    path: string,
    user: string,
    count: number,
  ) {
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const res = await request(server).get(path).set('x-test-user', user);
      out.push(res.status);
    }
    return out;
  }

  it.each([
    ['people', PEOPLE, '?format=csv'],
    ['schedule', SCHEDULE, `?format=csv&${WINDOW}`],
  ])(
    '%s: o 21º do mesmo usuário recebe 429 e outro usuário ainda passa',
    async (_route, path, query) => {
      const { server, people, schedule } = await exportApp();
      people.exportPeople.mockImplementation(sendFile);
      schedule.exportSchedule.mockImplementation(sendFile);

      const first = await statuses(server, `${path}${query}`, 'user_a', 21);
      const other = await statuses(server, `${path}${query}`, 'user_b', 1);

      expect(first.slice(0, 20)).toEqual(Array(20).fill(200));
      expect(first[20]).toBe(429);
      expect(other).toEqual([200]);
    },
  );
});

describe('PeopleExportController — query inválida (pipe Zod global)', () => {
  it.each([
    [PEOPLE, 'sem format', ''],
    [PEOPLE, 'format fora de csv/xlsx', '?format=pdf'],
    [PEOPLE, 'date inexistente', '?format=csv&date=2026-02-30'],
    [SCHEDULE, 'sem format', `?${WINDOW}`],
    [SCHEDULE, 'sem sectorId', '?format=csv&from=2026-11-01&to=2026-11-30'],
    [SCHEDULE, 'from fora do formato', '?format=csv&sectorId=s&from=1/11&to=x'],
  ])('%s %s → 400 e nenhum serviço é chamado', async (path, _case, query) => {
    const { server, people, schedule } = await exportApp();

    const res = await request(server).get(`${path}${query}`);

    expect(res.status).toBe(400);
    expect(people.exportPeople).not.toHaveBeenCalled();
    expect(schedule.exportSchedule).not.toHaveBeenCalled();
  });
});

describe('PeopleExportController — erros e permissão', () => {
  it('erro do serviço antes do envio sobe para o filtro global (problem+json)', async () => {
    const { server, people } = await exportApp();
    people.exportPeople.mockRejectedValue(peopleTooLarge());

    const res = await request(server).get(`${PEOPLE}?format=csv`);

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'export.too_large' });
  });

  it('o handler rejeita com o mesmo erro do serviço, sem engolir', async () => {
    const error = peopleTooLarge();
    const people = { exportPeople: vi.fn().mockRejectedValue(error) };
    const controller = new PeopleExportController(
      people as unknown as PeopleExportService,
      {} as ScheduleExportService,
    );
    const query = { format: 'csv', status: 'active' } as PeopleExportQueryDto;

    await expect(
      controller.exportPeople(
        query,
        { user: { sub: ACTOR } } as never,
        {} as never,
      ),
    ).rejects.toBe(error);
  });

  it('VIEWER recebe 403 auth.permission_denied e nenhum serviço é chamado', async () => {
    const { server, people, schedule } = await exportApp('VIEWER');

    const [a, b] = await Promise.all([
      request(server).get(`${PEOPLE}?format=csv`),
      request(server).get(`${SCHEDULE}?format=csv&${WINDOW}`),
    ]);

    for (const res of [a, b]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'auth.permission_denied',
        detail: 'Você não tem permissão para exportar pessoas e escala.',
      });
    }
    expect(people.exportPeople).not.toHaveBeenCalled();
    expect(schedule.exportSchedule).not.toHaveBeenCalled();
  });
});

describe('PeopleExportModule — injeção de dependências', () => {
  it('compila com os providers reais e resolve o controller', async () => {
    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: {} },
      ],
      exports: [PrismaService, AuditService],
    })
    class FakeGlobals {}
    @Module({
      providers: [{ provide: StaffScheduleService, useValue: {} }],
      exports: [StaffScheduleService],
    })
    class FakeStaffSchedule {}

    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobals, PeopleExportModule],
    })
      .overrideModule(StaffScheduleModule)
      .useModule(FakeStaffSchedule)
      .compile();

    expect(moduleRef.get(PeopleExportController)).toBeInstanceOf(
      PeopleExportController,
    );
    await moduleRef.close();
  });
});
