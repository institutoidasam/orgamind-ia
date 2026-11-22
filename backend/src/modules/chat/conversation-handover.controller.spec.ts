import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { RolesGuard } from '../auth/roles.guard';
import { ConversationHandoverController } from './conversation-handover.controller';
import { ConversationHandoverService } from './conversation-handover.service';

const openApps: INestApplication[] = [];

/** O app na ordem real: ator (o header `x-test-role` troca o papel), `RolesGuard` real, pipe Zod e filtro de domínio. */
async function handoverApp() {
  const service = { handover: vi.fn() };
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
    controllers: [ConversationHandoverController],
    providers: [
      { provide: ConversationHandoverService, useValue: service },
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

const HANDOVER = '/chat/handover';
const BODY = {
  toUserId: 'u9',
  note: 'Fim do turno',
  conversationIds: ['c1', 'c2'],
};

describe('ConversationHandoverController — POST chat/handover', () => {
  it('400 sem observação, em branco, lista vazia ou com repetidos', async () => {
    const { server, service } = await handoverApp();
    const bodies = [
      { toUserId: 'u9', conversationIds: ['c1'] },
      { ...BODY, note: '   ' },
      { ...BODY, conversationIds: [] },
      { ...BODY, conversationIds: ['c1', 'c1'] },
    ];
    for (const body of bodies) {
      const res = await request(server)
        .post(HANDOVER)
        .set('x-test-role', 'OPERATOR')
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(service.handover).not.toHaveBeenCalled();
  });

  it('VIEWER e SUPERVISOR — 403 auth.insufficient_role do RolesGuard', async () => {
    const { server, service } = await handoverApp();
    for (const role of ['VIEWER', 'SUPERVISOR']) {
      const res = await request(server)
        .post(HANDOVER)
        .set('x-test-role', role)
        .send(BODY);
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe(
        'auth.insufficient_role',
      );
    }
    expect(service.handover).not.toHaveBeenCalled();
  });
});

describe('ConversationHandoverController — POST chat/handover: resposta', () => {
  it('200 com o resultado; passa o ator do token, o corpo e new Date()', async () => {
    const { server, service } = await handoverApp();
    const result = {
      transferred: [{ id: 'c1' }],
      skipped: [{ id: 'c2', reason: 'resolved' }],
    };
    service.handover.mockResolvedValue(result);
    const before = Date.now();
    const res = await request(server)
      .post(HANDOVER)
      .set('x-test-role', 'ADMIN')
      .send({ ...BODY, note: ' fim do turno ', fromUserId: 'u3' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    const [actor, input, now] = service.handover.mock.calls[0] as [
      object,
      object,
      Date,
    ];
    expect(actor).toEqual({ id: 'user-1', role: 'ADMIN' });
    expect(input).toEqual({ ...BODY, note: 'fim do turno', fromUserId: 'u3' });
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
  });
});
