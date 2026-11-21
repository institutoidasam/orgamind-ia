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

// DK9: contador e destinos são leituras, só com `@Roles`; o 403 de quem não é
// remetente e o 404 do alcance ficam no serviço (testados na integração).
const BASE = '/internal/team-whatsapp';
const openApps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** App só com o controller de pendências, com os portões globais reais; o serviço é um espião. */
async function appAs(role: Role) {
  const service = {
    list: vi.fn(),
    get: vi.fn().mockResolvedValue({ id: 'p1' }),
    count: vi.fn().mockResolvedValue({ unassignedOverdue: 3 }),
    handlers: vi.fn().mockResolvedValue({ items: [{ id: 'u1', name: 'Ana' }] }),
  };
  const signedIn = (ctx: ExecutionContext) => {
    const user = { sub: 'actor-1', role };
    Object.assign(ctx.switchToHttp().getRequest<object>(), { user });
    return true;
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [TeamPendencyController],
    providers: [
      { provide: TeamPendencyService, useValue: service },
      { provide: TeamPendencyActionsService, useValue: {} },
      {
        provide: PermissionsService,
        useValue: { effectiveFor: (r: Role) => permissionsWith(r) },
      },
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

describe('TeamPendencyController — contador e destinos (DK9)', () => {
  it('VIEWER — 403 auth.insufficient_role em pendency-count e handlers', async () => {
    const { get, service } = await appAs('VIEWER');
    for (const path of ['/pendency-count', '/pendencies/p1/handlers']) {
      const res = await get(path);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'auth.insufficient_role' });
    }
    expect(service.count).not.toHaveBeenCalled();
    expect(service.handlers).not.toHaveBeenCalled();
  });

  it('GET pendency-count não colide com pendencies/:id', async () => {
    const { get, service } = await appAs('OPERATOR');
    const before = Date.now();
    const counted = await get('/pendency-count');
    expect([counted.status, counted.body]).toEqual([
      200,
      { unassignedOverdue: 3 },
    ]);
    const [actorId, now] = service.count.mock.calls[0] as [string, Date];
    expect(actorId).toBe('actor-1');
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(service.get).not.toHaveBeenCalled();
    const handlers = await get('/pendencies/p1/handlers');
    expect([handlers.status, handlers.body]).toEqual([
      200,
      { items: [{ id: 'u1', name: 'Ana' }] },
    ]);
    expect(service.handlers).toHaveBeenCalledWith('actor-1', 'p1');
    expect(service.get).not.toHaveBeenCalled();
    expect((await get('/pendencies/p1')).status).toBe(200);
    expect(service.get.mock.calls[0].slice(0, 2)).toEqual(['actor-1', 'p1']);
  });
});
