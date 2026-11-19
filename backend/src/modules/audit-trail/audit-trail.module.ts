import { Module } from '@nestjs/common';
import { AuditTrailController } from './audit-trail.controller';
import { AuditTrailRepository } from './audit-trail.repository';
import { AuditTrailService } from './audit-trail.service';

/** Consulta da trilha (C7), só leitura. `PrismaService` é global. */
@Module({
  controllers: [AuditTrailController],
  providers: [AuditTrailRepository, AuditTrailService],
})
export class AuditTrailModule {}
