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

// DK9/DK11: a escrita só tem `@RequirePermission('equipe.enviar')`; o guard
// recusa antes do serviço, e a validação do corpo também. O 403 de quem não é
// remetente, o 404 e os 409 ficam no serviço (testados na integração).
const URL = '/internal/team-whatsapp/pendencies/p1/assume';
const openApps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** App só com o controller de pendências, com os portões globais reais; os serviços são espiões. */
async function appAs(role: Role, opts: { withKey: boolean }) {
  const actions = { assume: vi.fn().mockResolvedValue(undefined) };
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
  return { post: (body: object) => http.post(URL).send(body), actions };
}

describe('TeamPendencyController — Assumir (DK9, DK11)', () => {
  it('sem equipe.enviar — 403 do guard antes do serviço', async () => {
    const { post, actions } = await appAs('OPERATOR', { withKey: false });
    const res = await post({ expectedHandlerId: null });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'auth.permission_denied' });
    expect(actions.assume).not.toHaveBeenCalled();
  });

  it('sem expectedHandlerId — 400, o serviço não roda', async () => {
    const { post, actions } = await appAs('OPERATOR', { withKey: true });
    expect((await post({ note: 'a' })).status).toBe(400);
    expect(actions.assume).not.toHaveBeenCalled();
  });

  it('sucesso — 204 sem corpo; ator do token, id da rota, corpo e relógio do controller', async () => {
    const { post, actions } = await appAs('SUPERVISOR', { withKey: true });
    const before = Date.now();
    const res = await post({ expectedHandlerId: 'u-9', note: ' liguei ' });
    expect([res.status, res.text]).toEqual([204, '']);
    const [actorId, id, input, now] = actions.assume.mock.calls[0] as [
      string,
      string,
      unknown,
      Date,
    ];
    expect([actorId, id]).toEqual(['actor-1', 'p1']);
    expect(input).toEqual({ expectedHandlerId: 'u-9', note: 'liguei' });
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });
});
