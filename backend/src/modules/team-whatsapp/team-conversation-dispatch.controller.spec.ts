import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Role } from '@prisma/client';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionsWith } from '../../shared/authz/actor.test-fixtures';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionsService } from '../permissions/permissions.service';
import { TeamConversationDispatchController } from './team-conversation-dispatch.controller';
import { TeamConversationDispatchService } from './team-conversation-dispatch.service';

// DT7: "Último envio à equipe nesta conversa" é da caixa (ADMIN e OPERATOR); o
// RolesGuard recusa os demais antes do serviço. O alcance e o link ficam no
// serviço (testados na integração).
const PATH = '/internal/team-whatsapp/conversations/conv-1/last-dispatch';
const openApps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** App só com o controller, com os portões globais reais; o serviço é espião. */
async function appAs(role: Role) {
  const dispatch = {
    lastDispatch: vi.fn().mockResolvedValue({ last: null }),
  };
  const signedIn = (ctx: ExecutionContext) => {
    const user = { sub: 'actor-1', role };
    Object.assign(ctx.switchToHttp().getRequest<object>(), { user });
    return true;
  };
  const effectiveFor = (r: Role) => Promise.resolve(permissionsWith(r));
  const moduleRef = await Test.createTestingModule({
    controllers: [TeamConversationDispatchController],
    providers: [
      { provide: TeamConversationDispatchService, useValue: dispatch },
      { provide: PermissionsService, useValue: { effectiveFor } },
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
  return { get: () => http.get(PATH), dispatch };
}

describe('TeamConversationDispatchController — portões (DT7)', () => {
  it('SUPERVISOR e VIEWER — 403 do RolesGuard, antes do serviço', async () => {
    for (const role of ['SUPERVISOR', 'VIEWER'] as const) {
      const { get, dispatch } = await appAs(role);
      const res = await get();
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'auth.insufficient_role' });
      expect(dispatch.lastDispatch).not.toHaveBeenCalled();
    }
  });

  it('ADMIN e OPERATOR — 200; ator do token, conversa da rota e a hora de agora ao serviço', async () => {
    for (const role of ['ADMIN', 'OPERATOR'] as const) {
      const { get, dispatch } = await appAs(role);
      const res = await get();
      expect([res.status, res.body]).toEqual([200, { last: null }]);
      expect(dispatch.lastDispatch).toHaveBeenCalledWith(
        'actor-1',
        'conv-1',
        expect.any(Date),
      );
    }
  });
});
