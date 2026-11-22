import { Global, Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { PermissionsRepository } from './permissions.repository';
import { PermissionsService } from './permissions.service';

/**
 * Permissões por ação: a leitura (guard e login) e a API da matriz (só ADMIN,
 * com trilha). `@Global` porque o `PermissionsGuard` (`APP_GUARD` do
 * `AppModule`) e os serviços de cada módulo a consomem. `PrismaService` e
 * `AuditService` vêm dos módulos globais.
 */
@Global()
@Module({
  controllers: [PermissionsController],
  providers: [PermissionsRepository, PermissionsService],
  exports: [PermissionsService],
})
export class PermissionsModule {}
