import { describe, it, expect, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import type { Env } from '../../shared/config/env.schema';

function makeConfig(): ConfigService<Env> {
  return {
    get: () => 'test-secret',
  } as unknown as ConfigService<Env>;
}

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;

  beforeEach(() => {
    strategy = new JwtStrategy(makeConfig());
  });

  it('returns the payload for a valid access token', () => {
    const payload = { sub: 'u1', email: 'a@b.com', role: 'OPERATOR' as const };
    const result = strategy.validate(payload);
    expect(result).toEqual(payload);
  });

  it('rejects a refresh token replayed as a bearer access token', () => {
    // Refresh tokens are signed with the same secret and carry type:'refresh'.
    const refreshPayload = { sub: 'u1', fid: 'fam1', type: 'refresh' } as never;
    const call = () => strategy.validate(refreshPayload);
    expect(call).toThrow(UnauthorizedException);
  });
});
