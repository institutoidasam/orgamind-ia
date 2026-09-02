import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { ClsService } from 'nestjs-cls';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { AUDIT_CLS_KEY } from '../audit/audit.service';

describe('CorrelationIdMiddleware', () => {
  let middleware: CorrelationIdMiddleware;
  let cls: MockProxy<ClsService>;

  beforeEach(() => {
    cls = mockDeep<ClsService>();
    middleware = new CorrelationIdMiddleware(cls);
  });

  function buildReq(overrides: Partial<any> = {}) {
    return {
      headers: {} as Record<string, string | undefined>,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      ...overrides,
    };
  }

  it('generates a UUID when x-request-id is missing', () => {
    const req: any = buildReq();
    const res: any = { setHeader: vi.fn() };
    const next = vi.fn();

    middleware.use(req, res, next);

    const id = req.headers['x-request-id'];
    expect(typeof id).toBe('string');
    // RFC4122 v4-ish UUID shape
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('preserves an existing x-request-id header', () => {
    const existing = 'existing-correlation-id';
    const req: any = buildReq({ headers: { 'x-request-id': existing } });
    const res: any = { setHeader: vi.fn() };
    const next = vi.fn();

    middleware.use(req, res, next);

    expect(req.headers['x-request-id']).toBe(existing);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', existing);
  });

  it('seeds CLS with correlationId, ip, userAgent', () => {
    const req: any = buildReq({
      headers: {
        'x-request-id': 'abc',
        'user-agent': 'Mozilla/5.0',
      },
      ip: '10.0.0.1',
    });
    const res: any = { setHeader: vi.fn() };
    const next = vi.fn();

    middleware.use(req, res, next);

    expect(cls.set).toHaveBeenCalledWith(AUDIT_CLS_KEY, {
      correlationId: 'abc',
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('falls back to socket.remoteAddress when req.ip is missing', () => {
    const req: any = buildReq({
      headers: { 'x-request-id': 'r1' },
      ip: undefined,
      socket: { remoteAddress: '192.168.1.1' },
    });
    const res: any = { setHeader: vi.fn() };
    const next = vi.fn();

    middleware.use(req, res, next);

    expect(cls.set).toHaveBeenCalledWith(
      AUDIT_CLS_KEY,
      expect.objectContaining({ ip: '192.168.1.1' }),
    );
  });

  it('still calls next() when CLS.set throws', () => {
    cls.set.mockImplementation(() => {
      throw new Error('CLS not active');
    });
    const req: any = buildReq();
    const res: any = { setHeader: vi.fn() };
    const next = vi.fn();

    expect(() => middleware.use(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
