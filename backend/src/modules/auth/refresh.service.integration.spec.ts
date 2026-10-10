import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import Redis from 'ioredis';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { RefreshService } from './refresh.service';
import { InvalidCredentialsError } from './errors/auth.errors';

const TESTCONTAINERS_ENABLED = process.env.TESTCONTAINERS_ENABLED === '1';
const FAMILY_PREFIX = 'auth:refresh-family:';

type TestUser = {
  id: string;
  email: string;
  role: 'ADMIN';
  isActive: boolean;
  sessionVersion: number;
};

type StoredFamily = {
  userId: string;
  currentTokenHash: string;
  rotatedAt: number;
  issuedAt: number;
  sessionVersion: number;
  expiresAt?: number;
};

function parseFamily(serialized: string): StoredFamily {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object')
    throw new Error('Invalid test family');
  return value as StoredFamily;
}

describe.skipIf(!TESTCONTAINERS_ENABLED)(
  'RefreshService CAS integration',
  () => {
    let container: StartedRedisContainer;
    let redis: Redis;
    let jwt: JwtService;
    let user: TestUser;
    let service: RefreshService;
    let findById: Mock<() => Promise<TestUser>>;
    let refreshExpiry: string;

    beforeAll(async () => {
      container = await new RedisContainer('redis:7-alpine').start();
      redis = new Redis({
        host: container.getHost(),
        port: container.getMappedPort(6379),
      });
      jwt = new JwtService({
        secret: 'refresh-service-test-secret-at-least-32',
      });
    }, 120_000);

    afterAll(async () => {
      await redis?.quit();
      await container?.stop();
    }, 60_000);

    async function makeService(expiry = '1d'): Promise<RefreshService> {
      await redis.flushdb();
      refreshExpiry = expiry;
      user = {
        id: 'user-1',
        email: 'user@example.test',
        role: 'ADMIN',
        isActive: true,
        sessionVersion: 0,
      };
      findById = vi.fn(() => Promise.resolve(user));
      return new RefreshService(
        jwt,
        { findById } as never,
        { log: vi.fn() } as never,
        {
          get: (key: string) =>
            key === 'JWT_REFRESH_EXPIRES_IN' ? refreshExpiry : '15m',
        } as never,
        redis,
      );
    }

    async function familyKey(token: string): Promise<string> {
      const payload = await jwt.verifyAsync<{ fid: string }>(token);
      return `${FAMILY_PREFIX}${payload.fid}`;
    }

    it.each([
      ['1d', 24 * 60 * 60],
      ['30d', 30 * 24 * 60 * 60],
    ])(
      'aligns JWT, Redis and cookie duration for %s',
      async (expiry, seconds) => {
        service = await makeService(expiry);
        const issued = await service.issueNew(
          'user-1',
          user.email,
          user.role,
          0,
        );
        const payload = await jwt.verifyAsync<{
          exp: number;
          iat: number;
          jti: string;
        }>(issued.refreshToken);
        const key = await familyKey(issued.refreshToken);

        expect(payload.exp - payload.iat).toBe(seconds);
        expect(payload.jti).toEqual(expect.any(String));
        expect(issued.refreshTokenMaxAgeMs).toBe(seconds * 1000);
        expect(await redis.ttl(key)).toBeGreaterThan(seconds - 2);
      },
    );

    it('allows one simultaneous rotation, then burns the family on reuse', async () => {
      service = await makeService();
      const issued = await service.issueNew('user-1', user.email, user.role, 0);
      let arrived = 0;
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      findById.mockImplementation(() => {
        arrived += 1;
        if (arrived === 2) releaseBarrier();
        return barrier.then(() => user);
      });

      const results = await Promise.allSettled([
        service.rotate(issued.refreshToken),
        service.rotate(issued.refreshToken),
      ]);
      const successes = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof service.rotate>>
        > => result.status === 'fulfilled',
      );
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toBeInstanceOf(InvalidCredentialsError);
      await expect(
        service.rotate(successes[0].value.refreshToken),
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('shortens a rotated JWT and cookie to the family lifetime remaining', async () => {
      service = await makeService('1d');
      const issued = await service.issueNew('user-1', user.email, user.role, 0);
      const key = await familyKey(issued.refreshToken);
      const state = parseFamily((await redis.get(key))!);
      state.expiresAt = Date.now() + 3_000;
      await redis.set(key, JSON.stringify(state), 'PX', 3_000);

      const rotated = await service.rotate(issued.refreshToken);
      const payload = await jwt.verifyAsync<{ exp: number; iat: number }>(
        rotated.refreshToken,
      );

      expect(payload.exp - payload.iat).toBeLessThan(24 * 60 * 60);
      expect(rotated.refreshTokenMaxAgeMs).toBeLessThan(24 * 60 * 60 * 1000);
      expect(await redis.pttl(key)).toBeLessThan(3_000);
    });

    it('does not extend a one-day family after config changes to thirty days', async () => {
      service = await makeService('1d');
      const issued = await service.issueNew('user-1', user.email, user.role, 0);
      refreshExpiry = '30d';

      const rotated = await service.rotate(issued.refreshToken);
      const payload = await jwt.verifyAsync<{ exp: number; iat: number }>(
        rotated.refreshToken,
      );

      expect(payload.exp - payload.iat).toBeLessThan(2 * 24 * 60 * 60);
      expect(rotated.refreshTokenMaxAgeMs).toBeLessThan(
        2 * 24 * 60 * 60 * 1000,
      );
    });

    it('does not shorten a thirty-day family after config changes to one day', async () => {
      service = await makeService('30d');
      const issued = await service.issueNew('user-1', user.email, user.role, 0);
      refreshExpiry = '1d';

      const rotated = await service.rotate(issued.refreshToken);
      const payload = await jwt.verifyAsync<{ exp: number; iat: number }>(
        rotated.refreshToken,
      );

      expect(payload.exp - payload.iat).toBeGreaterThan(29 * 24 * 60 * 60);
      expect(rotated.refreshTokenMaxAgeMs).toBeGreaterThan(
        29 * 24 * 60 * 60 * 1000,
      );
    });

    it('keeps the longest user index TTL and revokes families from both configs', async () => {
      service = await makeService('30d');
      const longFamily = await service.issueNew(
        'user-1',
        user.email,
        user.role,
        0,
      );
      refreshExpiry = '1d';
      const shortFamily = await service.issueNew(
        'user-1',
        user.email,
        user.role,
        0,
      );
      const longKey = await familyKey(longFamily.refreshToken);
      const shortKey = await familyKey(shortFamily.refreshToken);

      expect(await redis.ttl('auth:user-families:user-1')).toBeGreaterThan(
        29 * 24 * 60 * 60,
      );
      await service.revokeAllForUser('user-1');

      expect(await redis.get(longKey)).toBeNull();
      expect(await redis.get(shortKey)).toBeNull();
    });

    it('derives a conservative expiry for a legacy family without expiresAt', async () => {
      service = await makeService('1d');
      const issued = await service.issueNew('user-1', user.email, user.role, 0);
      const key = await familyKey(issued.refreshToken);
      const legacy = parseFamily((await redis.get(key))!);
      delete legacy.expiresAt;
      await redis.set(key, JSON.stringify(legacy), 'PX', 15_000);
      refreshExpiry = '30d';

      const rotated = await service.rotate(issued.refreshToken);

      expect(rotated.refreshTokenMaxAgeMs).toBeLessThanOrEqual(15_000);
      expect(await redis.pttl(key)).toBeLessThanOrEqual(15_000);
    });

    it('does not recreate a family revoked while a rotation is preparing', async () => {
      service = await makeService();
      const issued = await service.issueNew('user-1', user.email, user.role, 0);
      const key = await familyKey(issued.refreshToken);
      let releaseSigning!: () => void;
      const signingBlocked = new Promise<void>((resolve) => {
        releaseSigning = resolve;
      });
      let entered!: () => void;
      const signingEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const controlledJwt = {
        verifyAsync: async <T extends object>(token: string): Promise<T> =>
          jwt.verifyAsync<T>(token),
        signAsync: async (
          payload: object,
          options: JwtSignOptions,
        ): Promise<string> => {
          entered();
          await signingBlocked;
          return jwt.signAsync(payload, options);
        },
      };
      service = new RefreshService(
        controlledJwt as never,
        { findById } as never,
        { log: vi.fn() } as never,
        {
          get: (key: string) =>
            key === 'JWT_REFRESH_EXPIRES_IN' ? '1d' : '15m',
        } as never,
        redis,
      );

      const rotation = service.rotate(issued.refreshToken);
      await signingEntered;
      await service.revokeAllForUser(user.id);
      releaseSigning();

      await expect(rotation).rejects.toThrow(InvalidCredentialsError);
      expect(await redis.get(key)).toBeNull();
    });

    it('rejects a legacy version-zero family after the identity version changes', async () => {
      service = await makeService();
      const issued = await service.issueNew('user-1', user.email, user.role, 0);
      const key = await familyKey(issued.refreshToken);
      const signSpy = vi.spyOn(jwt, 'signAsync');
      signSpy.mockClear();
      user.sessionVersion = 1;

      await expect(service.rotate(issued.refreshToken)).rejects.toThrow(
        InvalidCredentialsError,
      );

      expect(signSpy).not.toHaveBeenCalled();
      expect(await redis.get(key)).toBeNull();
      signSpy.mockRestore();
    });
  },
);
