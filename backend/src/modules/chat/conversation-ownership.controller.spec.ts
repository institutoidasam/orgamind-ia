import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { NotFoundError } from '../../shared/errors/domain.error';
import { RolesGuard } from '../auth/roles.guard';
import { ConversationOwnershipController } from './conversation-ownership.controller';
import { ConversationOwnershipService } from './conversation-ownership.service';

const openApps: INestApplication[] = [];

/** O app na ordem real: ator (o header `x-test-role` troca o papel), `RolesGuard` real, pipe Zod e filtro de domínio. */
async function ownershipApp() {
  const service = { history: vi.fn(), assignees: vi.fn() };
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

describe('ConversationOwnershipController — leituras', () => {
  it('aceite 8: SUPERVISOR e VIEWER — 403 auth.insufficient_role em GET history e GET assignees', async () => {
    const { server, service } = await ownershipApp();
    for (const role of ['SUPERVISOR', 'VIEWER']) {
      for (const url of ['/chat/conversations/c1/history', '/chat/assignees']) {
        const res = await request(server).get(url).set('x-test-role', role);
        expect(res.status).toBe(403);
        expect((res.body as { code: string }).code).toBe(
          'auth.insufficient_role',
        );
      }
    }
    expect(service.history).not.toHaveBeenCalled();
    expect(service.assignees).not.toHaveBeenCalled();
  });

  it('OPERATOR e ADMIN — 200', async () => {
    const { server, service } = await ownershipApp();
    service.history.mockResolvedValue({ items: [], hasMore: false });
    service.assignees.mockResolvedValue({
      items: [{ id: 'u1', name: 'Atendente A' }],
    });
    for (const role of ['OPERATOR', 'ADMIN']) {
      const history = await request(server)
        .get('/chat/conversations/c1/history')
        .set('x-test-role', role);
      expect(history.status).toBe(200);
      expect(history.body).toEqual({ items: [], hasMore: false });
      const assignees = await request(server)
        .get('/chat/assignees')
        .set('x-test-role', role);
      expect(assignees.status).toBe(200);
      expect(assignees.body).toEqual({
        items: [{ id: 'u1', name: 'Atendente A' }],
      });
    }
    expect(service.history).toHaveBeenCalledWith('c1');
  });

  it('history de conversa inexistente — 404', async () => {
    const { server, service } = await ownershipApp();
    service.history.mockRejectedValue(new NotFoundError('Conversation', 'c9'));
    const res = await request(server)
      .get('/chat/conversations/c9/history')
      .set('x-test-role', 'OPERATOR');
    expect(res.status).toBe(404);
    expect((res.body as { code: string }).code).toBe('conversation.not_found');
  });
});
