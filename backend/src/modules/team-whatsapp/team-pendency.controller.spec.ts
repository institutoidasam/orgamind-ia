import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Role } from '@prisma/client';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionsWith } from '../../shared/authz/actor.test-fixtures';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsService } from '../permissions/permissions.service';
import { TeamPendencyActionsService } from './team-pendency-actions.service';
import { TeamPendencyController } from './team-pendency.controller';
import { TeamPendencyService } from './team-pendency.service';

// DK9: as leituras ficam com os mesmos portões globais, na ordem real: papel
// (RolesGuard) e validação da consulta antes do serviço, que decide o resto.
const BASE = '/internal/team-whatsapp';
const openApps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** App só com o controller de pendências; o serviço é um espião. */
async function appAs(role: Role) {
  const service = {
    list: vi.fn().mockResolvedValue({ items: [] }),
    get: vi.fn().mockResolvedValue({ id: 'p1' }),
  };
  const signedIn = (ctx: ExecutionContext) => {
    const user = { sub: 'actor-1', role };
    Object.assign(ctx.switchToHttp().getRequest<object>(), { user });
    return true;
  };
  const effectiveFor = (r: Role) => Promise.resolve(permissionsWith(r));
  const moduleRef = await Test.createTestingModule({
    controllers: [TeamPendencyController],
    providers: [
      { provide: TeamPendencyService, useValue: service },
      { provide: TeamPendencyActionsService, useValue: {} },
      { provide: PermissionsService, useValue: { effectiveFor } },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
      { provide: APP_GUARD, useValue: { canActivate: signedIn } },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  openApps.push(app);
  await app.init();
  const http = request(app.getHttpServer() as Parameters<typeof request>[0]);
  return { get: (path: string) => http.get(`${BASE}${path}`), service };
}

describe('TeamPendencyController — leituras (DK9)', () => {
  it('VIEWER — 403 auth.insufficient_role nas duas leituras', async () => {
    const { get, service } = await appAs('VIEWER');
    for (const path of ['/pendencies', '/pendencies/p1']) {
      const res = await get(path);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'auth.insufficient_role' });
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
  });

  it('query inválida (days=14) — 400; situação desconhecida e página zero também', async () => {
    const { get, service } = await appAs('ADMIN');
    for (const query of [
      'days=14',
      'situations=FOO',
      'situations=ACKED,ACKED',
      'page=0',
    ]) {
      const res = await get(`/pendencies?${query}`);
      expect(res.status).toBe(400);
    }
    expect(service.list).not.toHaveBeenCalled();
  });

  it('com papel de remetente repassa o ator, a consulta com os padrões e a hora do pedido', async () => {
    const { get, service } = await appAs('OPERATOR');
    const before = Date.now();
    expect((await get('/pendencies?mine=true&days=30')).status).toBe(200);
    const [actorId, query, now] = service.list.mock.calls[0] as [
      string,
      object,
      Date,
    ];
    expect([actorId, query]).toEqual([
      'actor-1',
      {
        situations: ['UNASSIGNED', 'IN_PROGRESS', 'OVERDUE'],
        mine: 'true',
        days: 30,
        page: 1,
        pageSize: 20,
      },
    ]);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect((await get('/pendencies/p1')).status).toBe(200);
    expect(service.get.mock.calls[0].slice(0, 2)).toEqual(['actor-1', 'p1']);
  });
});
