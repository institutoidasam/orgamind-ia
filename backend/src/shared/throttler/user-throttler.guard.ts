import { Injectable } from '@nestjs/common';
import {
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { Env } from '../config/env.schema';
import type { JwtPayload } from '../../modules/auth/jwt.strategy';

/**
 * ThrottlerGuard variant that keys the rate-limit bucket by the authenticated
 * user when one is present, falling back to the request IP otherwise. The
 * default tracker is IP-only, which lets two users behind a NAT share a budget
 * and gives an attacker a fresh budget per IP — wrong for endpoints like
 * /auth/change-password where the limit is per-user.
 *
 * `req.user` is only populated once JwtAuthGuard (passport) has run. Global
 * guard ordering is NOT guaranteed, so if this guard happens to run BEFORE the
 * JWT guard `req.user` is still undefined and the per-user limit silently
 * degrades to per-IP. To be robust regardless of ordering, when `req.user` is
 * absent we decode+verify the bearer token ourselves and key by its `sub`.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly jwt: JwtService;
  private readonly jwtSecret: string | undefined;

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService<Env>,
  ) {
    super(options, storageService, reflector);
    this.jwtSecret = config.get('JWT_SECRET', { infer: true });
    this.jwt = new JwtService();
  }

  protected getTracker(req: Request): Promise<string> {
    const sub = this.resolveUserId(req);
    if (sub) return Promise.resolve(`user:${sub}`);
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }

  /** Resolve the authenticated user id from `req.user` or, failing that, by
   * verifying the bearer token directly. Returns undefined for anonymous /
   * unverifiable requests so the caller can fall back to IP keying. */
  private resolveUserId(req: Request): string | undefined {
    const user = (req as Request & { user?: JwtPayload }).user;
    if (user?.sub) return user.sub;

    const token = this.extractBearerToken(req);
    if (!token || !this.jwtSecret) return undefined;
    try {
      const payload = this.jwt.verify<JwtPayload>(token, {
        secret: this.jwtSecret,
      });
      return payload?.sub;
    } catch {
      // Invalid/expired/foreign-signed token — fall back to IP keying.
      return undefined;
    }
  }

  private extractBearerToken(req: Request): string | undefined {
    const header = req.headers?.authorization;
    if (typeof header !== 'string') return undefined;
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
    return value;
  }
}
