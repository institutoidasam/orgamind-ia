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
import { TeamPendencyHandoverController } from './team-pendency-handover.controller';
import { TeamPendencyHandoverService } from './team-pendency-handover.service';

// DT4: as rotas da passagem só têm `@RequirePermission('equipe.enviar')`; o
// guard recusa antes do serviço. O 403 `forbidden`/`not_handler` e o alcance
// ficam no serviço (testados na integração).
const BASE = '/internal/team-whatsapp/pendency-handover';
const TARGETS = `${BASE}/targets`;
const openApps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** App só com o controller da passagem, com os portões globais reais; o serviço é espião. */
async function appAs(role: Role, opts: { withKey: boolean }) {
  const handover = {
    targets: vi.fn().mockResolvedValue({ items: [] }),
    handover: vi.fn().mockResolvedValue({ transferred: [], skipped: [] }),
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
    controllers: [TeamPendencyHandoverController],
    providers: [
      { provide: TeamPendencyHandoverService, useValue: handover },
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
    get: (query = '') => http.get(TARGETS + query),
    post: (body: object) => http.post(BASE).send(body),
    handover,
  };
}

describe('TeamPendencyHandoverController — destinos (DT4, K2-7)', () => {
  it('sem equipe.enviar — 403 do guard, antes do serviço', async () => {
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      const { get, handover } = await appAs(role, { withKey: false });
      const res = await get();
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'auth.permission_denied' });
      expect(handover.targets).not.toHaveBeenCalled();
    }
  });

  it('com equipe.enviar — 200; ator do token e fromUserId da consulta ao serviço', async () => {
    const { get, handover } = await appAs('SUPERVISOR', { withKey: true });
    const own = await get();
    const other = await get('?fromUserId=u-9');
    expect([own.status, own.body]).toEqual([200, { items: [] }]);
    expect(other.status).toBe(200);
    expect(handover.targets.mock.calls).toEqual([
      ['actor-1', undefined],
      ['actor-1', 'u-9'],
    ]);
  });
});

const VALID = {
  toUserId: 'u-2',
  note: ' Passei o turno ',
  pendencyIds: ['p1'],
};

describe('TeamPendencyHandoverController — passar (DT4, K3-4)', () => {
  it('sem equipe.enviar — 403 do guard, antes do serviço', async () => {
    for (const role of ['OPERATOR', 'VIEWER'] as const) {
      const { post, handover } = await appAs(role, { withKey: false });
      const res = await post(VALID);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'auth.permission_denied' });
      expect(handover.handover).not.toHaveBeenCalled();
    }
  });

  it('com equipe.enviar — 200 com o resultado; ator do token, corpo aparado e agora ao serviço', async () => {
    const { post, handover } = await appAs('SUPERVISOR', { withKey: true });
    const res = await post({ ...VALID, fromUserId: 'u-9' });
    expect([res.status, res.body]).toEqual([
      200,
      { transferred: [], skipped: [] },
    ]);
    expect(handover.handover).toHaveBeenCalledTimes(1);
    const [actorId, input, now] = handover.handover.mock.calls[0] as [
      string,
      object,
      Date,
    ];
    expect([actorId, input, now instanceof Date]).toEqual([
      'actor-1',
      {
        toUserId: 'u-2',
        fromUserId: 'u-9',
        note: 'Passei o turno',
        pendencyIds: ['p1'],
      },
      true,
    ]);
  });

  it.each([
    ['observação vazia', { ...VALID, note: '   ' }],
    ['observação acima de 200', { ...VALID, note: 'x'.repeat(201) }],
    ['lista vazia', { ...VALID, pendencyIds: [] }],
    ['ids repetidos', { ...VALID, pendencyIds: ['p1', 'p1'] }],
    ['acima do teto', { ...VALID, pendencyIds: manyIds(51) }],
    ['sem destino', { note: 'x', pendencyIds: ['p1'] }],
  ])('corpo inválido (%s) — 400, antes do serviço', async (_, body) => {
    const { post, handover } = await appAs('ADMIN', { withKey: true });
    expect((await post(body)).status).toBe(400);
    expect(handover.handover).not.toHaveBeenCalled();
  });
});

function manyIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `p${i}`);
}
