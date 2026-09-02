import { Global, Module } from '@nestjs/common';
import {
  OrganizationController,
  PublicOrganizationController,
} from './organization.controller';
import { OrganizationService } from './organization.service';

/**
 * @Global: a identidade da organização é um corte transversal — o consentimento
 * (texto, landing, wa.me) a injeta, e qualquer texto novo que fale com o titular
 * vai precisar dela. Global evita que alguém "resolva" o import escrevendo o
 * nome da organização à mão de novo, que é exatamente o bug que isto corrige.
 */
@Global()
@Module({
  controllers: [OrganizationController, PublicOrganizationController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
