import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { randomUUID, createHash } from 'crypto';
import { AuthRepository } from './auth.repository';
import type { AuthUser } from './auth.repository';
import { InvalidCredentialsError } from './errors/auth.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import type { Env } from '../../shared/config/env.schema';
import type { Role } from '@prisma/client';

const FAMILY_KEY_PREFIX = 'auth:refresh-family:';
// Reverse index: userId -> Set<fid>. Lets us revoke ALL of a user's refresh
// families at once (on password change, admin reset, role change, delete)
// without scanning every family key. Membership is best-effort cleanup: a
// stale fid here is harmless (revokeAllForUser just DELs a key that's already
// gone), and a lost index (e.g. Redis flush) only means the families are gone
// too — never a security hole.
const USER_FAMILIES_KEY_PREFIX = 'auth:user-families:';
const DURATION_FACTORS_MS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
} as const;

const CONSUME_FAMILY_LUA = `
local serialized = redis.call('GET', KEYS[1])
if not serialized then return 0 end
local family = cjson.decode(serialized)
if family.currentTokenHash ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[3])
  return -1
end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

const ADD_FAMILY_TO_INDEX_LUA = `
local currentTtl = redis.call('PTTL', KEYS[1])
redis.call('SADD', KEYS[1], ARGV[1])
if currentTtl ~= -1 and currentTtl < tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

type FamilyState = {
  userId: string;
  currentTokenHash: string; // SHA-256 of the latest refresh token
  rotatedAt: number; // ms epoch (last rotation)
  issuedAt: number; // ms epoch (legacy fallback only)
  expiresAt?: number; // ms epoch, immutable once the family is created
  sessionVersion?: number;
};

type RefreshPayload = {
  sub: string;
  fid: string;
  type: string;
  exp?: number;
};

type RefreshFamily = {
  key: string;
  payload: RefreshPayload;
  state: FamilyState;
};

type TokenPair = {
  accessToken: string;
  refreshToken: string;
  refreshTokenMaxAgeMs: number;
};

function isFamilyState(value: unknown): value is FamilyState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.userId === 'string' &&
    typeof state.currentTokenHash === 'string' &&
    typeof state.rotatedAt === 'number' &&
    (state.expiresAt === undefined || typeof state.expiresAt === 'number') &&
    (state.sessionVersion === undefined ||
      typeof state.sessionVersion === 'number')
  );
}

function durationToMs(value: JwtSignOptions['expiresIn']): number {
  if (typeof value === 'number') return value * 1000;
  if (typeof value !== 'string') {
    throw new Error('JWT_REFRESH_EXPIRES_IN must be a positive duration');
  }
  const match = /^(\d+)\s*(ms|s|m|h|d|w)$/i.exec(value);
  if (!match) {
    throw new Error('JWT_REFRESH_EXPIRES_IN must be a positive duration');
  }
  const unit = match[2].toLowerCase() as keyof typeof DURATION_FACTORS_MS;
  const factor = DURATION_FACTORS_MS[unit];
  const duration = Number(match[1]) * factor;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error('JWT_REFRESH_EXPIRES_IN must be a positive duration');
  }
  return duration;
}

/**
 * Refresh-token rotation with reuse detection.
 *
 * Each login creates a new "family" (UUID `fid`) and stores the SHA-256 of the
 * issued refresh token in Redis under `auth:refresh-family:<fid>` with a 7-day
 * TTL. On rotation we compare the presented token's hash against the stored
 * one — if it doesn't match, an old token is being replayed and the entire
 * family is burned (forcing re-login). Successful rotation overwrites the
 * stored hash with the new one.
 */
@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly authRepo: AuthRepository,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private userFamiliesKey(userId: string): string {
    return `${USER_FAMILIES_KEY_PREFIX}${userId}`;
  }

  private accessExpiry(): JwtSignOptions['expiresIn'] {
    return this.config.get('JWT_ACCESS_EXPIRES_IN', { infer: true }) ?? '15m';
  }

  private refreshExpiry(): JwtSignOptions['expiresIn'] {
    return this.config.get('JWT_REFRESH_EXPIRES_IN', { infer: true }) ?? '7d';
  }

  refreshCookieMaxAgeMs(): number {
    return durationToMs(this.refreshExpiry());
  }

  /** Issue a brand-new family with a fresh refresh + access pair. Used at login. */
  async issueNew(
    userId: string,
    email: string,
    role: Role,
    sessionVersion = 0,
  ): Promise<TokenPair> {
    const familyId = randomUUID();
    const refreshTokenMaxAgeMs = this.refreshCookieMaxAgeMs();
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, fid: familyId, jti: randomUUID(), type: 'refresh' },
      { expiresIn: this.refreshExpiry() },
    );
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, role, sessionVersion },
      { expiresIn: this.accessExpiry() },
    );

    const issuedAt = Date.now();
    const expiresAt = issuedAt + refreshTokenMaxAgeMs;
    await this.redis.set(
      `${FAMILY_KEY_PREFIX}${familyId}`,
      JSON.stringify({
        userId,
        currentTokenHash: this.hash(refreshToken),
        rotatedAt: issuedAt,
        issuedAt,
        expiresAt,
        sessionVersion,
      } satisfies FamilyState),
      'PX',
      refreshTokenMaxAgeMs,
    );

    // Record the family in the user's reverse index so revokeAllForUser can
    // find and burn it later. Refresh the index TTL on each login.
    const indexKey = this.userFamiliesKey(userId);
    await this.addFamilyToIndex(indexKey, familyId, refreshTokenMaxAgeMs);

    return { accessToken, refreshToken, refreshTokenMaxAgeMs };
  }

  /** Rotate a refresh token. Detects reuse and invalidates the family on detection. */
  async rotate(refreshToken: string): Promise<TokenPair> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const family = await this.loadFamily(payload);
    const expiresAt = await this.familyExpiresAt(family);

    const user = await this.findActiveUser(family.state.userId);
    if (
      payload.sub !== family.state.userId ||
      (family.state.sessionVersion ?? 0) !== (user.sessionVersion ?? 0)
    ) {
      await this.invalidateFamily(family);
      throw new InvalidCredentialsError();
    }
    const tokens = await this.issueRotatedTokens(user, payload.fid, expiresAt);
    const consumed = await this.consumeFamily(
      family,
      refreshToken,
      tokens.refreshToken,
      expiresAt,
    );
    if (consumed === -1) return this.rejectReuse(family);
    if (consumed === 0) {
      await this.redis.srem(this.userFamiliesKey(user.id), payload.fid);
      throw new InvalidCredentialsError();
    }
    await this.audit.log('auth.refresh', 'User', user.id);
    return tokens;
  }

  private async verifyRefreshToken(
    refreshToken: string,
  ): Promise<RefreshPayload> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken);
    } catch {
      throw new InvalidCredentialsError();
    }
    if (
      payload.type !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      typeof payload.fid !== 'string'
    ) {
      throw new InvalidCredentialsError();
    }
    return payload;
  }

  private async loadFamily(payload: RefreshPayload): Promise<RefreshFamily> {
    const key = `${FAMILY_KEY_PREFIX}${payload.fid}`;
    const serialized = await this.redis.get(key);
    if (!serialized) throw new InvalidCredentialsError();

    let parsedState: unknown;
    try {
      parsedState = JSON.parse(serialized);
    } catch {
      throw new InvalidCredentialsError();
    }
    if (!isFamilyState(parsedState)) throw new InvalidCredentialsError();
    return { key, payload, state: parsedState };
  }

  private async rejectReuse(family: RefreshFamily): Promise<never> {
    // The Lua compare-and-consume has already burned the family. Repeat the
    // cleanup defensively so a Redis-compatible client that reports reuse
    // without deleting cannot leave a replayable family behind.
    await this.invalidateFamily(family);
    this.logger.warn(
      { userId: family.state.userId, fid: family.payload.fid },
      'Refresh token reuse detected — family invalidated',
    );
    await this.audit.log(
      'auth.refresh_reuse_detected',
      'User',
      family.state.userId,
      { fid: family.payload.fid },
    );
    throw new InvalidCredentialsError();
  }

  private async findActiveUser(userId: string): Promise<AuthUser> {
    const user = await this.authRepo.findById(userId);
    if (!user || user.isActive === false) throw new InvalidCredentialsError();
    return user;
  }

  private async issueRotatedTokens(
    user: AuthUser,
    fid: string,
    expiresAt: number,
  ): Promise<TokenPair> {
    const refreshTokenMaxAgeMs = this.remainingLifetimeMs(expiresAt);
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, fid, jti: randomUUID(), type: 'refresh' },
      { expiresIn: Math.max(1, Math.floor(refreshTokenMaxAgeMs / 1000)) },
    );
    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        sessionVersion: user.sessionVersion ?? 0,
      },
      { expiresIn: this.accessExpiry() },
    );
    return { accessToken, refreshToken, refreshTokenMaxAgeMs };
  }

  private remainingLifetimeMs(expiresAt: number): number {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw new InvalidCredentialsError();
    return remaining;
  }

  private async familyExpiresAt(family: RefreshFamily): Promise<number> {
    if (family.state.expiresAt !== undefined) return family.state.expiresAt;

    const observedAt = Date.now();
    const ttlMs = await this.redis.pttl(family.key);
    if (ttlMs <= 0) throw new InvalidCredentialsError();
    const redisExpiresAt = observedAt + ttlMs;
    const jwtExpiresAt =
      typeof family.payload.exp === 'number'
        ? family.payload.exp * 1000
        : redisExpiresAt;
    return Math.min(redisExpiresAt, jwtExpiresAt);
  }

  private async consumeFamily(
    family: RefreshFamily,
    presentedToken: string,
    nextToken: string,
    expiresAt: number,
  ): Promise<number> {
    const issuedAt = family.state.issuedAt ?? family.state.rotatedAt;
    const nextState = JSON.stringify({
      userId: family.state.userId,
      currentTokenHash: this.hash(nextToken),
      rotatedAt: Date.now(),
      issuedAt,
      expiresAt,
      sessionVersion: family.state.sessionVersion ?? 0,
    } satisfies FamilyState);
    return this.redis.eval(
      CONSUME_FAMILY_LUA,
      2,
      family.key,
      this.userFamiliesKey(family.state.userId),
      this.hash(presentedToken),
      nextState,
      family.payload.fid,
    ) as Promise<number>;
  }

  private async addFamilyToIndex(
    indexKey: string,
    familyId: string,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.eval(
      ADD_FAMILY_TO_INDEX_LUA,
      1,
      indexKey,
      familyId,
      String(ttlMs),
    );
  }

  private async invalidateFamily(family: RefreshFamily): Promise<void> {
    await this.redis.del(family.key);
    await this.redis.srem(
      this.userFamiliesKey(family.state.userId),
      family.payload.fid,
    );
  }

  /** Revoke a family. Called on logout. Silent no-op for invalid/expired tokens. */
  async revoke(refreshToken: string): Promise<void> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken);
      if (payload.type === 'refresh') {
        await this.redis.del(`${FAMILY_KEY_PREFIX}${payload.fid}`);
        await this.redis.srem(this.userFamiliesKey(payload.sub), payload.fid);
        await this.audit.log('auth.logout', 'User', payload.sub);
      }
    } catch {
      // Invalid/expired token — nothing to revoke
    }
  }

  /**
   * Revoke EVERY refresh family belonging to a user, forcing re-login on all
   * devices. Called on credential or privilege changes: self-service password
   * change, admin password reset, role change/demotion, and account deletion.
   * Idempotent and safe to call for a user with no active sessions.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    const indexKey = this.userFamiliesKey(userId);
    const familyIds = await this.redis.smembers(indexKey);
    if (familyIds.length > 0) {
      await this.redis.del(
        ...familyIds.map((fid) => `${FAMILY_KEY_PREFIX}${fid}`),
      );
    }
    await this.redis.del(indexKey);
  }
}
