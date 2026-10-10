import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Env } from '../../shared/config/env.schema';
import { AuthRepository } from './auth.repository';
import type { Role } from '@prisma/client';

export type JwtPayload = {
  sub: string;
  email: string;
  role: Role;
  sessionVersion?: number;
  sectorId?: string | null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Env>,
    private readonly authRepo: AuthRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true })!,
    });
  }

  async validate(payload: JwtPayload & { type?: string }) {
    // Reject refresh tokens replayed as bearer access tokens. Refresh tokens are
    // signed with the same JWT_SECRET but carry `type: 'refresh'` (and no role);
    // only access tokens (which have no `type` claim) may satisfy the bearer guard.
    if (payload.type === 'refresh') {
      throw new UnauthorizedException();
    }
    const user = await this.authRepo.findById(payload.sub);
    // Old tokens without a version remain valid only for an untouched
    // version-zero identity. This closes reactivation and role-change token
    // resurrection without forcing all existing users to log in at migration.
    if (
      !user ||
      !user.isActive ||
      (payload.sessionVersion ?? 0) !== user.sessionVersion
    ) {
      throw new UnauthorizedException();
    }
    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      sectorId: user.sectorId,
      sessionVersion: user.sessionVersion,
    } satisfies JwtPayload;
  }
}
