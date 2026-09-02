import { describe, it, expect, beforeEach } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { UserThrottlerGuard } from './user-throttler.guard';

const JWT_SECRET = 'a'.repeat(32);

function makeConfig(secret = JWT_SECRET): ConfigService {
  return {
    get: (key: string) => (key === 'JWT_SECRET' ? secret : undefined),
  } as unknown as ConfigService;
}

/**
 * Build a guard instance. ThrottlerGuard's real constructor expects
 * (options, storage, reflector); the tracker logic under test never touches
 * those, so we pass minimal stand-ins and exercise the protected getTracker
 * via a thin subclass.
 */
class TestableGuard extends UserThrottlerGuard {
  public track(req: Request): Promise<string> {
    return this.getTracker(req);
  }
}

function makeGuard(config: ConfigService): TestableGuard {
  return new TestableGuard(
    { throttlers: [] } as any,
    {} as any,
    {} as any,
    config,
  );
}

describe('UserThrottlerGuard.getTracker', () => {
  let jwt: JwtService;

  beforeEach(() => {
    jwt = new JwtService({ secret: JWT_SECRET });
  });

  it('keys by user when req.user is already populated (guard ran after JWT)', async () => {
    const guard = makeGuard(makeConfig());
    const req = {
      ip: '203.0.113.7',
      headers: {},
      user: { sub: 'user-42' },
    } as unknown as Request;

    await expect(guard.track(req)).resolves.toBe('user:user-42');
  });

  it('keys by user by DECODING the bearer token when req.user is absent (guard ran BEFORE JWT)', async () => {
    const guard = makeGuard(makeConfig());
    const token = jwt.sign(
      { sub: 'user-99', email: 'a@b.c', role: 'ADMIN' },
      { secret: JWT_SECRET },
    );
    const req = {
      ip: '203.0.113.7',
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request;

    await expect(guard.track(req)).resolves.toBe('user:user-99');
  });

  it('two different users behind the same IP get different buckets', async () => {
    const guard = makeGuard(makeConfig());
    const tokenA = jwt.sign({ sub: 'A', email: 'a@b.c', role: 'OPERATOR' });
    const tokenB = jwt.sign({ sub: 'B', email: 'b@b.c', role: 'OPERATOR' });
    const reqA = {
      ip: '198.51.100.1',
      headers: { authorization: `Bearer ${tokenA}` },
    } as unknown as Request;
    const reqB = {
      ip: '198.51.100.1',
      headers: { authorization: `Bearer ${tokenB}` },
    } as unknown as Request;

    const keyA = await guard.track(reqA);
    const keyB = await guard.track(reqB);
    expect(keyA).toBe('user:A');
    expect(keyB).toBe('user:B');
    expect(keyA).not.toBe(keyB);
  });

  it('falls back to IP when no token and no user', async () => {
    const guard = makeGuard(makeConfig());
    const req = { ip: '192.0.2.55', headers: {} } as unknown as Request;
    await expect(guard.track(req)).resolves.toBe('ip:192.0.2.55');
  });

  it('falls back to IP when the bearer token is invalid/unverifiable', async () => {
    const guard = makeGuard(makeConfig());
    const req = {
      ip: '192.0.2.55',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    } as unknown as Request;
    await expect(guard.track(req)).resolves.toBe('ip:192.0.2.55');
  });

  it('falls back to IP when the token is signed with a different secret', async () => {
    const guard = makeGuard(makeConfig());
    const foreign = new JwtService({ secret: 'b'.repeat(32) });
    const token = foreign.sign({ sub: 'evil', email: 'x@y.z', role: 'ADMIN' });
    const req = {
      ip: '192.0.2.55',
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request;
    await expect(guard.track(req)).resolves.toBe('ip:192.0.2.55');
  });

  it('falls back to ip:unknown when neither token, user, nor ip is present', async () => {
    const guard = makeGuard(makeConfig());
    const req = { headers: {} } as unknown as Request;
    await expect(guard.track(req)).resolves.toBe('ip:unknown');
  });
});
