import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Env } from '../../shared/config/env.schema';

export type JwtPayload = {
  sub: string;
  email: string;
  role: 'ADMIN' | 'OPERATOR';
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true })!,
    });
  }

  validate(payload: JwtPayload & { type?: string }) {
    // Reject refresh tokens replayed as bearer access tokens. Refresh tokens are
    // signed with the same JWT_SECRET but carry `type: 'refresh'` (and no role);
    // only access tokens (which have no `type` claim) may satisfy the bearer guard.
    if (payload.type === 'refresh') {
      throw new UnauthorizedException();
    }
    return payload;
  }
}
