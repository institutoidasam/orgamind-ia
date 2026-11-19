import { describe, it, expect, vi } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/permissions.guard';
import { RolesGuard } from './modules/auth/roles.guard';
import { UserThrottlerGuard } from './shared/throttler/user-throttler.guard';

// O `ConfigModule` real valida o env no IMPORT (`ConfigModule.forRoot()`), o que
// tornaria este spec refém do ambiente de quem o roda. O spec só lê o metadata
// de providers do AppModule: troca-se o módulo de config por um vazio.
vi.mock('./shared/config/config.module', async () => {
  const { Module } = await import('@nestjs/common');
  @Module({})
  class ConfigModule {}
  return { ConfigModule };
});

type ProviderEntry = { provide?: unknown; useClass?: unknown };

/** Os `APP_GUARD` do AppModule, na ordem em que o Nest os encadeia por requisição. */
function globalGuards(): unknown[] {
  const providers =
    (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) as
      ProviderEntry[] | undefined) ?? [];
  return providers
    .filter((provider) => provider.provide === APP_GUARD)
    .map((provider) => provider.useClass);
}

describe('AppModule — guardas globais', () => {
  it('registra JwtAuthGuard, RolesGuard, PermissionsGuard e UserThrottlerGuard, nessa ordem', () => {
    // PermissionsGuard depende de o JWT já ter posto o usuário na requisição e
    // vem logo depois do RolesGuard: sem ele registrado, `@RequirePermission` nada protege.
    expect(globalGuards()).toEqual([
      JwtAuthGuard,
      RolesGuard,
      PermissionsGuard,
      UserThrottlerGuard,
    ]);
  });
});
