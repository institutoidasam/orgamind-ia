import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { RolesGuard } from '../auth/roles.guard';
import { ChatController } from './chat.controller';
import { ConversationOwnershipController } from './conversation-ownership.controller';
import { ConversationOwnershipService } from './conversation-ownership.service';

const openApps: INestApplication[] = [];

/** O app na ordem real: ator (o header `x-test-role` troca o papel), `RolesGuard` real, pipe Zod e filtro de domínio. */
async function assignApp() {
  const service = { assign: vi.fn() };
  const authenticate = {
    canActivate: (ctx: {
      switchToHttp(): {
        getRequest(): { user?: unknown; headers: Record<string, string> };
      };
    }) => {
      const req = ctx.switchToHttp().getRequest();
      req.user = { sub: 'user-1', role: req.headers['x-test-role'] };
      return true;
    },
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ConversationOwnershipController],
    providers: [
      { provide: ConversationOwnershipService, useValue: service },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
      { provide: APP_GUARD, useValue: authenticate },
      { provide: APP_GUARD, useClass: RolesGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  openApps.push(app);
  return { server: app.getHttpServer() as never, service };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const ASSIGN = '/chat/conversations/c1/assign';

describe('ConversationOwnershipController — assign', () => {
  it('aceite 8: assign sem expectedAssigneeId — 400', async () => {
    const { server, service } = await assignApp();
    const bodies = [
      { userId: 'user-1' },
      { userId: null, note: 'x'.repeat(201) },
    ];
    for (const body of bodies) {
      const res = await request(server)
        .post(ASSIGN)
        .set('x-test-role', 'OPERATOR')
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(service.assign).not.toHaveBeenCalled();
  });

  it('aceite 8: SUPERVISOR e VIEWER — 403 auth.insufficient_role em assign', async () => {
    const { server, service } = await assignApp();
    for (const role of ['SUPERVISOR', 'VIEWER']) {
      const res = await request(server)
        .post(ASSIGN)
        .set('x-test-role', role)
        .send({ userId: 'user-1', expectedAssigneeId: null });
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe(
        'auth.insufficient_role',
      );
    }
    expect(service.assign).not.toHaveBeenCalled();
  });
});

describe('ConversationOwnershipController — assign: resposta e rota', () => {
  it('assign responde 200 com o resumo; o ator vem de req.user (sub e role)', async () => {
    const { server, service } = await assignApp();
    service.assign.mockResolvedValue({ id: 'c1', status: 'IN_PROGRESS' });
    const res = await request(server)
      .post(ASSIGN)
      .set('x-test-role', 'ADMIN')
      .send({ userId: 'u9', expectedAssigneeId: null, note: ' passei ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'c1', status: 'IN_PROGRESS' });
    expect(service.assign).toHaveBeenCalledWith(
      'c1',
      { id: 'user-1', role: 'ADMIN' },
      { userId: 'u9', expectedAssigneeId: null, note: 'passei' },
    );
  });

  it('a rota assign não está mais em ChatController', () => {
    const handlers = Object.getOwnPropertyNames(ChatController.prototype);
    const paths = handlers.map(
      (name) =>
        Reflect.getMetadata(
          PATH_METADATA,
          ChatController.prototype[name as keyof ChatController],
        ) as string | undefined,
    );
    expect(handlers).not.toContain('assign');
    expect(paths).not.toContain('conversations/:id/assign');
  });
});
