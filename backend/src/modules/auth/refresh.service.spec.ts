import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { createHash } from 'crypto';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { RefreshService } from './refresh.service';
import { AuthRepository, type AuthUser } from './auth.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { InvalidCredentialsError } from './errors/auth.errors';
import type { Env } from '../../shared/config/env.schema';

// In-memory Redis mock — supports the subset RefreshService uses.
const store = new Map<string, string>();
// Per-user family index (Redis Set semantics).
const sets = new Map<string, Set<string>>();
const redisGet = vi.fn((key: string) =>
  Promise.resolve(store.get(key) ?? null),
);
const redisSet = vi.fn((key: string, value: string) => {
  store.set(key, value);
  return Promise.resolve('OK');
});
const redisEval = vi.fn(
  async (script: string, _keyCount: number, ...args: string[]) => {
    if (script.includes("redis.call('SADD'")) {
      const [indexKey, familyId] = args;
      await redisSadd(indexKey, familyId);
      return 1;
    }
    const [familyKey, indexKey, expectedHash, nextState, familyId] = args;
    const current = store.get(familyKey);
    if (!current) return 0;
    if (parseFamily(current).currentTokenHash !== expectedHash) {
      store.delete(familyKey);
      await redisSrem(indexKey, familyId);
      return -1;
    }
    store.set(familyKey, nextState);
    return 1;
  },
);
const redisDel = vi.fn((...keys: string[]) => {
  let n = 0;
  for (const key of keys) {
    if (store.delete(key)) n++;
    if (sets.delete(key)) n++;
  }
  return Promise.resolve(n);
});
const redisSadd = vi.fn((key: string, ...members: string[]) => {
  const set = sets.get(key) ?? new Set<string>();
  let added = 0;
  for (const m of members) {
    if (!set.has(m)) {
      set.add(m);
      added++;
    }
  }
  sets.set(key, set);
  return Promise.resolve(added);
});
const redisSrem = vi.fn((key: string, ...members: string[]) => {
  const set = sets.get(key);
  if (!set) return Promise.resolve(0);
  let removed = 0;
  for (const m of members) if (set.delete(m)) removed++;
  return Promise.resolve(removed);
});
const redisSmembers = vi.fn((key: string) =>
  Promise.resolve([...(sets.get(key) ?? [])]),
);
const redisPttl = vi.fn((key: string) =>
  Promise.resolve(
    store.has(key) || sets.has(key) ? 7 * 24 * 60 * 60 * 1000 : -2,
  ),
);
// TTL is irrelevant to the in-memory mock; just acknowledge the call.
const redisExpire = vi.fn(() => Promise.resolve(1));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function parseFamily(serialized: string): {
  userId: string;
  currentTokenHash: string;
  sessionVersion?: number;
} {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object') throw new Error('Invalid family');
  return value as {
    userId: string;
    currentTokenHash: string;
    sessionVersion?: number;
  };
}

describe('RefreshService', () => {
  let service: RefreshService;
  let jwt: MockProxy<JwtService>;
  let repo: MockProxy<AuthRepository>;
  let audit: MockProxy<AuditService>;
  let auditLog: Mock;
  let config: MockProxy<ConfigService<Env>>;

  const user: AuthUser = {
    id: 'u1',
    email: 'a@b.c',
    password: 'hashed',
    name: null,
    role: 'ADMIN',
    sectorId: null,
    sector: null,
    isActive: true,
    sessionVersion: 0,
    mustChangePassword: false,
    lastLoginAt: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    store.clear();
    sets.clear();
    redisGet.mockClear();
    redisSet.mockClear();
    redisEval.mockClear();
    redisDel.mockClear();
    redisSadd.mockClear();
    redisSrem.mockClear();
    redisSmembers.mockClear();
    redisPttl.mockClear();
    redisExpire.mockClear();

    jwt = mockDeep<JwtService>();
    repo = mockDeep<AuthRepository>();
    audit = mockDeep<AuditService>();
    auditLog = vi.fn();
    audit.log = auditLog;
    config = mockDeep<ConfigService<Env>>();
    config.get.mockImplementation((key: unknown) => {
      if (key === 'JWT_ACCESS_EXPIRES_IN') return '15m';
      if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
      return undefined;
    });

    const redisStub = {
      get: redisGet,
      set: redisSet,
      eval: redisEval,
      del: redisDel,
      sadd: redisSadd,
      srem: redisSrem,
      smembers: redisSmembers,
      pttl: redisPttl,
      expire: redisExpire,
    } as never;
    service = new RefreshService(jwt, repo, audit, config, redisStub);
  });

  afterEach(() => {
    // Service no longer owns the Redis client.
  });

  it('issueNew creates a family in Redis and returns access + refresh tokens', async () => {
    (jwt.signAsync as unknown as Mock)
      .mockResolvedValueOnce('refresh-tok-1') // refresh
      .mockResolvedValueOnce('access-tok-1'); // access

    const result = await service.issueNew('u1', 'a@b.c', 'ADMIN');

    expect(result).toMatchObject({
      accessToken: 'access-tok-1',
      refreshToken: 'refresh-tok-1',
    });
    // exactly one family written
    expect(redisSet).toHaveBeenCalledTimes(1);
    const stored = parseFamily([...store.values()][0]);
    expect(stored.userId).toBe('u1');
    expect(stored.currentTokenHash).toBe(sha256('refresh-tok-1'));
    expect(stored.sessionVersion).toBe(0);
  });

  it.each([
    ['1d', 24 * 60 * 60],
    ['30d', 30 * 24 * 60 * 60],
  ])(
    'uses %s as the single lifetime for a new family',
    async (expiry, seconds) => {
      config.get.mockImplementation((key: unknown) =>
        key === 'JWT_REFRESH_EXPIRES_IN' ? expiry : '15m',
      );
      (jwt.signAsync as unknown as Mock)
        .mockResolvedValueOnce('refresh-tok-1')
        .mockResolvedValueOnce('access-tok-1');

      const result = await service.issueNew('u1', 'a@b.c', 'ADMIN');

      expect(result.refreshTokenMaxAgeMs).toBe(seconds * 1000);
      expect(redisSet).toHaveBeenCalledWith(
        expect.stringContaining('auth:refresh-family:'),
        expect.any(String),
        'PX',
        seconds * 1000,
      );
    },
  );

  it('rotate returns new tokens and updates the family hash', async () => {
    // Seed family
    const fid = 'fam-1';
    store.set(
      `auth:refresh-family:${fid}`,
      JSON.stringify({
        userId: 'u1',
        currentTokenHash: sha256('old-refresh'),
        rotatedAt: Date.now(),
      }),
    );

    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', fid, type: 'refresh' });
    repo.findById.mockResolvedValue(user);
    (jwt.signAsync as unknown as Mock)
      .mockResolvedValueOnce('refresh-tok-2') // new refresh
      .mockResolvedValueOnce('access-tok-2'); // new access

    const result = await service.rotate('old-refresh');

    expect(result).toMatchObject({
      accessToken: 'access-tok-2',
      refreshToken: 'refresh-tok-2',
    });
    // Family updated, not deleted
    expect(redisDel).not.toHaveBeenCalled();
    const stored = parseFamily(store.get(`auth:refresh-family:${fid}`)!);
    expect(stored.currentTokenHash).toBe(sha256('refresh-tok-2'));
    expect(auditLog).toHaveBeenCalledWith('auth.refresh', 'User', 'u1');
  });

  it('rotate denies (does not resurrect the family) when revokeAllForUser wins the race mid-rotation', async () => {
    // Family read OK, but a concurrent revokeAllForUser DELetes it before our
    // conditional write. The write must use SET ... XX so it no-ops, and rotate
    // must then deny instead of re-creating the family.
    const fid = 'fam-race';
    store.set(
      `auth:refresh-family:${fid}`,
      JSON.stringify({
        userId: 'u1',
        currentTokenHash: sha256('old-refresh'),
        rotatedAt: Date.now(),
        issuedAt: Date.now(),
      }),
    );
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', fid, type: 'refresh' });
    repo.findById.mockResolvedValue(user);
    (jwt.signAsync as unknown as Mock)
      .mockResolvedValueOnce('refresh-tok-2')
      .mockResolvedValueOnce('access-tok-2');
    // Simulate the atomic Redis script observing a revoked family.
    redisEval.mockImplementationOnce(() => Promise.resolve(0));

    await expect(service.rotate('old-refresh')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rotate throws InvalidCredentialsError when JWT verify fails', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    await expect(service.rotate('bad-token')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rotate throws when payload type is not refresh', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'u1',
      fid: 'fam-1',
      type: 'access',
    });
    await expect(service.rotate('mistyped-token')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rotate throws when family is missing (expired/revoked)', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'u1',
      fid: 'no-such-fam',
      type: 'refresh',
    });
    // store is empty
    await expect(service.rotate('orphan-token')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rotate detects reuse: presenting an old token after rotation deletes the family', async () => {
    const fid = 'fam-burn';
    // Family currently expects "current-refresh" — but caller presents "old-refresh"
    store.set(
      `auth:refresh-family:${fid}`,
      JSON.stringify({
        userId: 'u1',
        currentTokenHash: sha256('current-refresh'),
        rotatedAt: Date.now(),
      }),
    );
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', fid, type: 'refresh' });
    repo.findById.mockResolvedValue(user);
    (jwt.signAsync as unknown as Mock)
      .mockResolvedValueOnce('unused-refresh')
      .mockResolvedValueOnce('unused-access');

    await expect(service.rotate('old-refresh')).rejects.toThrow(
      InvalidCredentialsError,
    );
    // Family should be burned
    expect(store.has(`auth:refresh-family:${fid}`)).toBe(false);
    expect(auditLog).toHaveBeenCalledWith(
      'auth.refresh_reuse_detected',
      'User',
      'u1',
      { fid },
    );
  });

  it('rotate throws when the user no longer exists', async () => {
    const fid = 'fam-missing-user';
    store.set(
      `auth:refresh-family:${fid}`,
      JSON.stringify({
        userId: 'u-gone',
        currentTokenHash: sha256('cur'),
        rotatedAt: Date.now(),
      }),
    );
    jwt.verifyAsync.mockResolvedValue({ sub: 'u-gone', fid, type: 'refresh' });
    repo.findById.mockResolvedValue(null);

    await expect(service.rotate('cur')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('burns a version-zero family instead of issuing under a newer identity version', async () => {
    const fid = 'fam-version-race';
    store.set(
      `auth:refresh-family:${fid}`,
      JSON.stringify({
        userId: 'u1',
        currentTokenHash: sha256('current-refresh'),
        rotatedAt: Date.now(),
        issuedAt: Date.now(),
      }),
    );
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', fid, type: 'refresh' });
    repo.findById.mockResolvedValue({ ...user, sessionVersion: 1 });

    await expect(service.rotate('current-refresh')).rejects.toThrow(
      InvalidCredentialsError,
    );

    expect(store.has(`auth:refresh-family:${fid}`)).toBe(false);
    expect((jwt.signAsync as unknown as Mock).mock.calls).toHaveLength(0);
  });

  it('revoke deletes the family and audits logout', async () => {
    const fid = 'fam-logout';
    store.set(
      `auth:refresh-family:${fid}`,
      JSON.stringify({
        userId: 'u1',
        currentTokenHash: sha256('tok'),
        rotatedAt: Date.now(),
      }),
    );
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', fid, type: 'refresh' });

    await service.revoke('tok');

    expect(store.has(`auth:refresh-family:${fid}`)).toBe(false);
    expect(auditLog).toHaveBeenCalledWith('auth.logout', 'User', 'u1');
  });

  it('revoke is silent on invalid tokens', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('bad'));
    await expect(service.revoke('garbage')).resolves.toBeUndefined();
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('issueNew indexes the new family under the user', async () => {
    (jwt.signAsync as unknown as Mock)
      .mockResolvedValueOnce('refresh-tok-1')
      .mockResolvedValueOnce('access-tok-1');

    await service.issueNew('u1', 'a@b.c', 'ADMIN');

    // The family fid was recorded in the user's index set.
    const indexed = [...(sets.get('auth:user-families:u1') ?? [])];
    expect(indexed).toHaveLength(1);
    // ...and it points at a real family key.
    expect(store.has(`auth:refresh-family:${indexed[0]}`)).toBe(true);
  });

  it('revokeAllForUser burns every refresh family belonging to the user', async () => {
    // Two families for u1, one for a different user.
    store.set(
      'auth:refresh-family:famA',
      JSON.stringify({
        userId: 'u1',
        currentTokenHash: sha256('a'),
        rotatedAt: Date.now(),
      }),
    );
    store.set(
      'auth:refresh-family:famB',
      JSON.stringify({
        userId: 'u1',
        currentTokenHash: sha256('b'),
        rotatedAt: Date.now(),
      }),
    );
    store.set(
      'auth:refresh-family:famC',
      JSON.stringify({
        userId: 'u2',
        currentTokenHash: sha256('c'),
        rotatedAt: Date.now(),
      }),
    );
    sets.set('auth:user-families:u1', new Set(['famA', 'famB']));
    sets.set('auth:user-families:u2', new Set(['famC']));

    await service.revokeAllForUser('u1');

    // u1's families are gone, the index set is cleared.
    expect(store.has('auth:refresh-family:famA')).toBe(false);
    expect(store.has('auth:refresh-family:famB')).toBe(false);
    expect(sets.has('auth:user-families:u1')).toBe(false);
    // u2 is untouched.
    expect(store.has('auth:refresh-family:famC')).toBe(true);
  });

  it('revokeAllForUser is a no-op (no throw) when the user has no families', async () => {
    await expect(service.revokeAllForUser('nobody')).resolves.toBeUndefined();
  });
});
