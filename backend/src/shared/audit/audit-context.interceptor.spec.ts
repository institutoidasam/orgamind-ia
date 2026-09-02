import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { AuditContextInterceptor } from './audit-context.interceptor';
import { AUDIT_CLS_KEY } from './audit.service';

describe('AuditContextInterceptor', () => {
  let interceptor: AuditContextInterceptor;
  let cls: MockProxy<ClsService>;

  beforeEach(() => {
    cls = mockDeep<ClsService>();
    interceptor = new AuditContextInterceptor(cls);
  });

  function buildContext(opts: {
    type?: 'http' | 'rpc' | 'ws';
    request?: Partial<any>;
  }): ExecutionContext {
    const type = opts.type ?? 'http';
    const req = {
      headers: {},
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      ...opts.request,
    };
    return {
      getType: () => type,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  function buildHandler(): CallHandler {
    return { handle: () => of('result') };
  }

  it('sets CLS context with correlationId/ip/userAgent/actorId from request', async () => {
    const ctx = buildContext({
      request: {
        headers: {
          'x-request-id': 'req-9',
          'user-agent': 'Chrome/100',
        },
        ip: '10.0.0.5',
        user: { sub: 'user-77' },
      },
    });
    const handler = buildHandler();

    const observable = interceptor.intercept(ctx, handler);
    // exhaust observable so the handler is invoked
    await new Promise<void>((resolve) =>
      observable.subscribe({ complete: () => resolve() }),
    );

    expect(cls.set).toHaveBeenCalledWith(AUDIT_CLS_KEY, {
      correlationId: 'req-9',
      ip: '10.0.0.5',
      userAgent: 'Chrome/100',
      actorId: 'user-77',
    });
  });

  it('passes through non-HTTP contexts without writing CLS', async () => {
    const ctx = buildContext({ type: 'rpc' });
    const handler = buildHandler();

    const observable = interceptor.intercept(ctx, handler);
    await new Promise<void>((resolve) =>
      observable.subscribe({ complete: () => resolve() }),
    );

    expect(cls.set).not.toHaveBeenCalled();
  });

  it('uses socket.remoteAddress when req.ip is missing', async () => {
    const ctx = buildContext({
      request: {
        headers: { 'x-request-id': 'r1' },
        ip: undefined,
        socket: { remoteAddress: '192.168.10.1' },
      },
    });
    await new Promise<void>((resolve) =>
      interceptor
        .intercept(ctx, buildHandler())
        .subscribe({ complete: () => resolve() }),
    );
    expect(cls.set).toHaveBeenCalledWith(
      AUDIT_CLS_KEY,
      expect.objectContaining({ ip: '192.168.10.1', actorId: undefined }),
    );
  });

  it('handles missing user / undefined headers gracefully', async () => {
    const ctx = buildContext({
      request: {
        headers: {},
        ip: '127.0.0.1',
      },
    });
    await new Promise<void>((resolve) =>
      interceptor
        .intercept(ctx, buildHandler())
        .subscribe({ complete: () => resolve() }),
    );
    expect(cls.set).toHaveBeenCalledWith(
      AUDIT_CLS_KEY,
      expect.objectContaining({
        correlationId: undefined,
        ip: '127.0.0.1',
        userAgent: undefined,
        actorId: undefined,
      }),
    );
  });

  it('merges into the existing CLS context, preserving correlationId set by the middleware', async () => {
    // Middleware seeded the context with a generated correlationId; this
    // request carries no x-request-id header. The interceptor must NOT blow
    // that away — it should keep the existing correlationId and only add what
    // it now knows (actorId from req.user).
    cls.get.mockReturnValue({
      correlationId: 'mw-generated-uuid',
      ip: '10.0.0.5',
      userAgent: 'Chrome/100',
    });
    const ctx = buildContext({
      request: {
        headers: {},
        ip: '10.0.0.5',
        user: { sub: 'user-77' },
      },
    });

    await new Promise<void>((resolve) =>
      interceptor
        .intercept(ctx, buildHandler())
        .subscribe({ complete: () => resolve() }),
    );

    expect(cls.set).toHaveBeenCalledWith(
      AUDIT_CLS_KEY,
      expect.objectContaining({
        correlationId: 'mw-generated-uuid',
        actorId: 'user-77',
      }),
    );
  });

  it('lets a real x-request-id header win over the previously-seeded value', async () => {
    cls.get.mockReturnValue({ correlationId: 'old-id', ip: '10.0.0.5' });
    const ctx = buildContext({
      request: {
        headers: { 'x-request-id': 'new-header-id' },
        ip: '10.0.0.5',
        user: { sub: 'u1' },
      },
    });

    await new Promise<void>((resolve) =>
      interceptor
        .intercept(ctx, buildHandler())
        .subscribe({ complete: () => resolve() }),
    );

    expect(cls.set).toHaveBeenCalledWith(
      AUDIT_CLS_KEY,
      expect.objectContaining({
        correlationId: 'new-header-id',
        actorId: 'u1',
      }),
    );
  });

  it('still invokes the downstream handler when CLS.set throws', async () => {
    cls.set.mockImplementation(() => {
      throw new Error('cls not active');
    });
    const handler = buildHandler();
    const handleSpy = vi.spyOn(handler, 'handle');

    const ctx = buildContext({
      request: { headers: { 'x-request-id': 'r' } },
    });

    const observable = interceptor.intercept(ctx, handler);
    await new Promise<void>((resolve, reject) =>
      observable.subscribe({
        complete: () => resolve(),
        error: reject,
      }),
    );

    expect(handleSpy).toHaveBeenCalledTimes(1);
  });
});
