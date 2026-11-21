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

// DK9/DK14: Encerrar e Reabrir só têm `@RequirePermission('equipe.enviar')`; o
// guard e a validação do corpo recusam antes do serviço. O 403 `not_handler`, o
// 404, o 409 e o 422 `ack_exists` ficam no serviço (testados na integração).
const BASE = '/internal/team-whatsapp/pendencies/p1';
const openApps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** App só com o controller de pendências, com os portões globais reais; os serviços são espiões. */
async function appAs(role: Role, opts: { withKey: boolean }) {
  const actions = {
    close: vi.fn().mockResolvedValue(undefined),
    reopen: vi.fn().mockResolvedValue(undefined),
  };
  const signedIn = (ctx: ExecutionContext) => {
    const user = { sub: 'actor-1', role };
    Object.assign(ctx.switchToHttp().getRequest<object>(), { user });
    return true;
  };
  const effectiveFor = (r: Role) =>
    Promise.resolve(
      permissionsWith(r, opts.withKey ? {} : { revoke: ['equipe.enviar'] }),
    );
  const moduleRef = await Test.createTestingModule({
    controllers: [TeamPendencyController],
    providers: [
      { provide: TeamPendencyService, useValue: {} },
      { provide: TeamPendencyActionsService, useValue: actions },
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
  return {
    post: (path: string, body: object) => http.post(BASE + path).send(body),
    actions,
  };
}

const ROUTES = [
  {
    path: '/close',
    method: 'close',
    valid: { reason: ' sem retorno ', expectedHandlerId: 'u-1' },
    parsed: { reason: 'sem retorno', expectedHandlerId: 'u-1' },
    invalids: [
      { reason: '   ', expectedHandlerId: 'u-1' },
      { reason: 'x'.repeat(201), expectedHandlerId: 'u-1' },
      { reason: 'sem retorno' },
    ],
  },
  {
    path: '/reopen',
    method: 'reopen',
    valid: { expectedHandlerId: 'u-1' },
    parsed: { expectedHandlerId: 'u-1' },
    invalids: [{}],
  },
] as const;

describe('TeamPendencyController — Encerrar e Reabrir (DK9, DK14)', () => {
  it.each(ROUTES)(
    'sem equipe.enviar — 403 do guard em $path, antes do serviço',
    async ({ path, method, valid }) => {
      const { post, actions } = await appAs('OPERATOR', { withKey: false });
      const res = await post(path, valid);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'auth.permission_denied' });
      expect(actions[method]).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    'corpo inválido — 400 em $path (motivo vazio ou acima de 200, ou sem expectedHandlerId), o serviço não roda',
    async ({ path, method, invalids }) => {
      const { post, actions } = await appAs('OPERATOR', { withKey: true });
      for (const body of invalids) {
        expect((await post(path, body)).status).toBe(400);
      }
      expect(actions[method]).not.toHaveBeenCalled();
    },
  );

  it.each(ROUTES)(
    'sucesso — 204 sem corpo em $path; ator do token, id da rota, corpo aparado e relógio do controller',
    async ({ path, method, valid, parsed }) => {
      const { post, actions } = await appAs('SUPERVISOR', { withKey: true });
      const before = Date.now();
      const res = await post(path, valid);
      expect([res.status, res.text]).toEqual([204, '']);
      const [actorId, id, input, now] = actions[method].mock.calls[0] as [
        string,
        string,
        unknown,
        Date,
      ];
      expect([actorId, id]).toEqual(['actor-1', 'p1']);
      expect(input).toEqual(parsed);
      expect(now.getTime()).toBeGreaterThanOrEqual(before);
    },
  );
});
