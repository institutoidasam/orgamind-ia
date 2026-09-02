import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '@prisma/client';
import { AuditRepository } from './audit.repository';

export type AuditContext = {
  actorId?: string;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
};

export const AUDIT_CLS_KEY = 'audit';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly repo: AuditRepository,
    private readonly cls: ClsService,
  ) {}

  /**
   * Write an audit event. Reads actor/ip/userAgent from CLS context populated
   * by AuditContextInterceptor. Audit failures MUST never break the main
   * flow — errors are logged and swallowed.
   */
  async log(
    action: string,
    entity: string,
    entityId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const ctx = this.readContext();
      // Normalization (undefined -> null / Prisma.JsonNull) is owned by the
      // repository — pass the context/args through verbatim and let one layer
      // (AuditRepository.create) coalesce.
      await this.repo.create({
        action,
        entity,
        entityId,
        actorId: ctx.actorId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      });
    } catch (err) {
      this.logger.error(
        { err, action, entity, entityId },
        'Failed to write audit event',
      );
    }
  }

  private readContext(): AuditContext {
    try {
      return this.cls.get<AuditContext>(AUDIT_CLS_KEY) ?? {};
    } catch {
      // CLS may not be active outside HTTP/job contexts
      return {};
    }
  }
}
