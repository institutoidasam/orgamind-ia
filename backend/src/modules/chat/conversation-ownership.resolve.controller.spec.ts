import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainExceptionFilter } from '../../shared/errors/domain-exception.filter';
import { RolesGuard } from '../auth/roles.guard';
import { ConversationOwnershipController } from './conversation-ownership.controller';
import { ConversationOwnershipService } from './conversation-ownership.service';

const openApps: INestApplication[] = [];

/** O app na ordem real: ator (o header `x-test-role` troca o papel), `RolesGuard` real, pipe Zod e filtro de domínio. */
async function commandApp() {
  const service = { resolve: vi.fn(), reopen: vi.fn() };
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

const RESOLVE = '/chat/conversations/c1/resolve';
const REOPEN = '/chat/conversations/c1/reopen';
const VALID = {
  expectedAssigneeId: 'user-1',
  expectedLastInboundAt: '2026-11-21T12:00:00.000Z',
};

describe('ConversationOwnershipController — resolver', () => {
  it('resolve sem expectedAssigneeId ou sem expectedLastInboundAt — 400', async () => {
    const { server, service } = await commandApp();
    const bodies = [
      { expectedLastInboundAt: VALID.expectedLastInboundAt },
      { expectedAssigneeId: VALID.expectedAssigneeId },
      { ...VALID, note: 'x'.repeat(201) },
    ];
    for (const body of bodies) {
      const res = await request(server)
        .post(RESOLVE)
        .set('x-test-role', 'OPERATOR')
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it('resolve responde 200 com o resumo; o ator vem de req.user (sub e role)', async () => {
    const { server, service } = await commandApp();
    service.resolve.mockResolvedValue({ id: 'c1', status: 'RESOLVED' });
    const res = await request(server)
      .post(RESOLVE)
      .set('x-test-role', 'ADMIN')
      .send({ ...VALID, expectedAssigneeId: null, note: ' feito ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'c1', status: 'RESOLVED' });
    expect(service.resolve).toHaveBeenCalledWith(
      'c1',
      { id: 'user-1', role: 'ADMIN' },
      { ...VALID, expectedAssigneeId: null, note: 'feito' },
    );
  });
});

describe('ConversationOwnershipController — papéis e reabrir', () => {
  it('aceite 8: SUPERVISOR e VIEWER — 403 auth.insufficient_role em resolve e reopen', async () => {
    const { server, service } = await commandApp();
    for (const role of ['SUPERVISOR', 'VIEWER']) {
      for (const url of [RESOLVE, REOPEN]) {
        const res = await request(server)
          .post(url)
          .set('x-test-role', role)
          .send(VALID);
        expect(res.status).toBe(403);
        expect((res.body as { code: string }).code).toBe(
          'auth.insufficient_role',
        );
      }
    }
    expect(service.resolve).not.toHaveBeenCalled();
    expect(service.reopen).not.toHaveBeenCalled();
  });

  it('reopen responde 200 com o resumo; corpo `{}` ou com observação', async () => {
    const { server, service } = await commandApp();
    service.reopen.mockResolvedValue({ id: 'c1', status: 'PENDING' });
    const send = (body: object) =>
      request(server).post(REOPEN).set('x-test-role', 'OPERATOR').send(body);
    const bare = await send({});
    const noted = await send({ note: 'voltou' });
    expect([bare.status, noted.status]).toEqual([200, 200]);
    expect(bare.body).toEqual({ id: 'c1', status: 'PENDING' });
    expect(service.reopen).toHaveBeenLastCalledWith(
      'c1',
      { id: 'user-1', role: 'OPERATOR' },
      { note: 'voltou' },
    );
  });
});
