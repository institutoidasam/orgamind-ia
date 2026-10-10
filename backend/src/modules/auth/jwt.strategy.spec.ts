import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import type { Env } from '../../shared/config/env.schema';
import { AuthRepository } from './auth.repository';

function makeConfig(): ConfigService<Env> {
  return {
    get: () => 'test-secret',
  } as unknown as ConfigService<Env>;
}

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  const repo = { findById: vi.fn() };

  beforeEach(() => {
    repo.findById.mockReset();
    strategy = new JwtStrategy(makeConfig(), repo as unknown as AuthRepository);
  });

  it('returns the current user identity for a valid access token', async () => {
    const payload = { sub: 'u1', email: 'a@b.com', role: 'OPERATOR' as const };
    const user = {
      id: 'u1',
      email: 'a@b.com',
      role: 'OPERATOR',
      isActive: true,
      sessionVersion: 0,
      sectorId: 'sector-1',
      name: null,
    };
    repo.findById.mockResolvedValue(user);
    await expect(strategy.validate(payload)).resolves.toMatchObject({
      sub: user.id,
      email: user.email,
      role: user.role,
      sectorId: user.sectorId,
      sessionVersion: user.sessionVersion,
    });
  });

  it('rejects a refresh token replayed as a bearer access token', async () => {
    // Refresh tokens are signed with the same secret and carry type:'refresh'.
    const refreshPayload = { sub: 'u1', fid: 'fam1', type: 'refresh' } as never;
    await expect(strategy.validate(refreshPayload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token after its user is deactivated or its session is revoked', async () => {
    repo.findById.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      role: 'OPERATOR',
      isActive: false,
      sessionVersion: 1,
      sectorId: null,
      name: null,
    });
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'a@b.com',
        role: 'OPERATOR',
        sessionVersion: 0,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses role and sector currently stored for a matching bearer version', async () => {
    repo.findById.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      role: 'SUPERVISOR',
      isActive: true,
      sessionVersion: 2,
      sectorId: 'sector-b',
      name: null,
    });
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'a@b.com',
        role: 'OPERATOR',
        sectorId: 'sector-a',
        sessionVersion: 2,
      }),
    ).resolves.toMatchObject({ role: 'SUPERVISOR', sectorId: 'sector-b' });
  });

  it('rejects an otherwise active user when role or sector mutation increments the version', async () => {
    repo.findById.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      role: 'OPERATOR',
      isActive: true,
      sessionVersion: 3,
      sectorId: 'sector-b',
      name: null,
    });
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'a@b.com',
        role: 'OPERATOR',
        sessionVersion: 2,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
