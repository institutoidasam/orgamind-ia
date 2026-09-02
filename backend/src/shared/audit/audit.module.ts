import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditRepository } from './audit.repository';
import { AuditContextInterceptor } from './audit-context.interceptor';

@Global()
@Module({
  providers: [AuditService, AuditRepository, AuditContextInterceptor],
  exports: [AuditService, AuditRepository, AuditContextInterceptor],
})
export class AuditModule {}
