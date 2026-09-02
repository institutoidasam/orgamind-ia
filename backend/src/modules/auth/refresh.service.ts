import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { randomUUID, createHash } from 'crypto';
import { AuthRepository } from './auth.repository';
import { InvalidCredentialsError } from './errors/auth.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import type { Env } from '../../shared/config/env.schema';

const FAMILY_KEY_PREFIX = 'auth:refresh-family:';
// Reverse index: userId -> Set<fid>. Lets us revoke ALL of a user's refresh
// families at once (on password change, admin reset, role change, delete)
// without scanning every family key. Membership is best-effort cleanup: a
// stale fid here is harmless (revokeAllForUser just DELs a key that's already
// gone), and a lost index (e.g. Redis flush) only means the families are gone
// too — never a security hole.
const USER_FAMILIES_KEY_PREFIX = 'auth:user-families:';
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600;

type FamilyState = {
  userId: string;
  currentTokenHash: string; // SHA-256 of the latest refresh token
  rotatedAt: number; // ms epoch (last rotation)
  issuedAt: number; // ms epoch (initial login that started this family)
};

type RefreshPayload = {
  sub: string;
  fid: string;
  type: string;
};

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
    return (this.config.get('JWT_ACCESS_EXPIRES_IN', { infer: true }) ??
      '15m') as JwtSignOptions['expiresIn'];
  }

  private refreshExpiry(): JwtSignOptions['expiresIn'] {
    return (this.config.get('JWT_REFRESH_EXPIRES_IN', { infer: true }) ??
      '7d') as JwtSignOptions['expiresIn'];
  }

  /** Issue a brand-new family with a fresh refresh + access pair. Used at login. */
  async issueNew(
    userId: string,
    email: string,
    role: 'ADMIN' | 'OPERATOR',
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const familyId = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, fid: familyId, type: 'refresh' },
      { expiresIn: this.refreshExpiry() },
    );
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email, role },
      { expiresIn: this.accessExpiry() },
    );

    const issuedAt = Date.now();
    await this.redis.set(
      `${FAMILY_KEY_PREFIX}${familyId}`,
      JSON.stringify({
        userId,
        currentTokenHash: this.hash(refreshToken),
        rotatedAt: issuedAt,
        issuedAt,
      } satisfies FamilyState),
      'EX',
      REFRESH_TOKEN_TTL_SECONDS,
    );

    // Record the family in the user's reverse index so revokeAllForUser can
    // find and burn it later. Refresh the index TTL on each login.
    const indexKey = this.userFamiliesKey(userId);
    await this.redis.sadd(indexKey, familyId);
    await this.redis.expire(indexKey, REFRESH_TOKEN_TTL_SECONDS);

    return { accessToken, refreshToken };
  }

  /** Rotate a refresh token. Detects reuse and invalidates the family on detection. */
  async rotate(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshToken);
    } catch {
      throw new InvalidCredentialsError();
    }
    if (payload.type !== 'refresh') throw new InvalidCredentialsError();

    const familyKey = `${FAMILY_KEY_PREFIX}${payload.fid}`;
    const stateJson = await this.redis.get(familyKey);
    if (!stateJson) {
      // Family expired or invalidated
      throw new InvalidCredentialsError();
    }

    const state: FamilyState = JSON.parse(stateJson);
    const presentedHash = this.hash(refreshToken);

    if (state.currentTokenHash !== presentedHash) {
      // REUSE DETECTED: old token presented after rotation. Burn the family.
      await this.redis.del(familyKey);
      await this.redis.srem(this.userFamiliesKey(state.userId), payload.fid);
      this.logger.warn(
        { userId: state.userId, fid: payload.fid },
        'Refresh token reuse detected — family invalidated',
      );
      await this.audit.log(
        'auth.refresh_reuse_detected',
        'User',
        state.userId,
        { fid: payload.fid },
      );
      throw new InvalidCredentialsError();
    }

    // Look up user (role may have changed)
    const user = await this.authRepo.findById(state.userId);
    if (!user) throw new InvalidCredentialsError();

    // Issue new tokens (preserving family id)
    const newRefresh = await this.jwt.signAsync(
      { sub: user.id, fid: payload.fid, type: 'refresh' },
      { expiresIn: this.refreshExpiry() },
    );
    const newAccess = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: this.accessExpiry() },
    );

    // Preserve the family's original TTL across rotations. Resetting EX to 7d
    // on every rotation effectively made any active session immortal —
    // a user refreshing once a week never had their family expire. Anchor TTL
    // to `issuedAt` (kept across rotations) so the absolute 7-day cap holds.
    // Older entries written before `issuedAt` existed fall back to `rotatedAt`.
    const issuedAt = state.issuedAt ?? state.rotatedAt;
    const elapsedSec = Math.floor((Date.now() - issuedAt) / 1000);
    const remainingSec = REFRESH_TOKEN_TTL_SECONDS - elapsedSec;
    if (remainingSec <= 0) {
      await this.redis.del(familyKey);
      await this.redis.srem(this.userFamiliesKey(state.userId), payload.fid);
      throw new InvalidCredentialsError();
    }
    // Conditional write (XX = only if the key still exists). If a concurrent
    // revokeAllForUser DELeted the family between our GET above and this SET,
    // XX makes this a no-op so we don't resurrect a revoked session — and we
    // deny the rotation. Closes the revoke/rotate race without a lock.
    const written = await this.redis.set(
      familyKey,
      JSON.stringify({
        userId: state.userId,
        currentTokenHash: this.hash(newRefresh),
        rotatedAt: Date.now(),
        issuedAt,
      } satisfies FamilyState),
      'EX',
      remainingSec,
      'XX',
    );
    if (written === null) {
      await this.redis.srem(this.userFamiliesKey(state.userId), payload.fid);
      throw new InvalidCredentialsError();
    }

    await this.audit.log('auth.refresh', 'User', user.id);

    return { accessToken: newAccess, refreshToken: newRefresh };
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
