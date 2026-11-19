import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { RefreshService } from './refresh.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { PermissionsGuard } from './permissions.guard';
import { PermissionsService } from '../permissions/permissions.service';
import { meResponseSchema } from '../../schemas/contracts/auth.schema';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ROLES_KEY } from './decorators/roles.decorator';

// DB13: `GET /auth/me` roda a pilha real de guardas (JwtAuthGuard, RolesGuard,
// PermissionsGuard) e o JwtStrategy; só o serviço e o repositório são falsos.
const ME_BODY = {
  user: {
    id: 'u1',
    email: 'a@b.com',
    name: null,
    role: 'VIEWER',
    sectorId: null,
    sector: null,
    isActive: true,
    permissions: [],
  },
  mustChangePassword: false,
};
const openApps: INestApplication[] = [];

async function meApp(role: string) {
  const secret = randomUUID();
  const me = vi.fn().mockResolvedValue(ME_BODY);
  const user = {
    id: 'u1',
    email: 'a@b.com',
    role,
    isActive: true,
    hasAccess: true,
    sessionVersion: 0,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule, JwtModule.register({ secret })],
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: { me } },
      { provide: RefreshService, useValue: {} },
      {
        provide: AuthRepository,
        useValue: { findById: vi.fn().mockResolvedValue(user) },
      },
      { provide: ConfigService, useValue: { get: () => secret } },
      { provide: PermissionsService, useValue: { effectiveFor: vi.fn() } },
      JwtStrategy,
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  openApps.push(app);
  const token = moduleRef
    .get(JwtService)
    .sign({ sub: 'u1', email: 'a@b.com', role });
  return { server: app.getHttpServer() as Server, token, me };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('GET /auth/me', () => {
  it.each(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'])(
    '%s com sessão válida recebe { user, mustChangePassword } de me(sub)',
    async (role) => {
      const { server, token, me } = await meApp(role);

      const res = await request(server)
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(me).toHaveBeenCalledWith('u1');
      expect(meResponseSchema.parse(res.body)).toEqual(ME_BODY);
    },
  );

  it('sem token → 401 e o serviço não é chamado', async () => {
    const { server, me } = await meApp('ADMIN');

    const res = await request(server).get('/auth/me');

    expect(res.status).toBe(401);
    expect(me).not.toHaveBeenCalled();
  });
});

describe('AuthController authorization contract', () => {
  function responseDouble() {
    return {
      clearCookie: vi.fn(),
      cookie: vi.fn(),
    };
  }

  function handler(name: keyof AuthController): (...args: never[]) => unknown {
    const descriptor = Object.getOwnPropertyDescriptor(
      AuthController.prototype,
      name,
    );
    const value: unknown = descriptor?.value;
    if (typeof value !== 'function') {
      throw new Error(`Missing ${name}`);
    }
    return value as (...args: never[]) => unknown;
  }

  it('keeps login and refresh public for unauthenticated HTTP requests', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler('login'))).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler('refreshToken'))).toBe(
      true,
    );
  });

  it('explicitly permits a VIEWER to change their own password', () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler('changePassword'))).toContain(
      'VIEWER',
    );
  });

  it('delegates change-password using the current bearer subject', async () => {
    const auth = { changePassword: vi.fn().mockResolvedValue(undefined) };
    const instance = new AuthController(auth as never, {} as never);
    await instance.changePassword({ user: { sub: 'viewer-1' } } as never, {
      currentPassword: `old-${'credential'}`,
      newPassword: `new-${'credential'}`,
    });
    expect(auth.changePassword).toHaveBeenCalledWith(
      'viewer-1',
      expect.any(Object),
    );
  });

  it('uses the configured refresh duration when setting a login cookie', async () => {
    const auth = {
      login: vi.fn().mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        mustChangePassword: false,
        user: { id: 'viewer-1' },
      }),
    };
    const refresh = {
      refreshCookieMaxAgeMs: vi.fn().mockReturnValue(86_400_000),
    };
    const res = responseDouble();
    const instance = new AuthController(auth as never, refresh as never);

    await instance.login({} as never, res as never);

    expect(res.cookie).toHaveBeenCalledWith(
      'picoa_refresh',
      'refresh',
      expect.objectContaining({ maxAge: 86_400_000 }),
    );
  });

  it('uses only the remaining family lifetime for a rotated cookie', async () => {
    const refresh = {
      rotate: vi.fn().mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'rotated-refresh',
        refreshTokenMaxAgeMs: 1_234,
      }),
    };
    const res = responseDouble();
    const instance = new AuthController({} as never, refresh as never);

    await instance.refreshToken(
      { cookies: { picoa_refresh: 'old-refresh' } } as never,
      res as never,
    );

    expect(res.cookie).toHaveBeenCalledWith(
      'picoa_refresh',
      'rotated-refresh',
      expect.objectContaining({ maxAge: 1_234 }),
    );
  });
});
