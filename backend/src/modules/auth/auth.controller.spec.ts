import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { ROLES_KEY } from './decorators/roles.decorator';

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
