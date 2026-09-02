import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable } from 'rxjs';
import type { Request } from 'express';
import { AUDIT_CLS_KEY, type AuditContext } from './audit.service';

type AuthedRequest = Request & {
  user?: { sub?: string };
};

/**
 * Populates CLS with audit/correlation context AFTER guards run, so that
 * `req.user` (set by JwtAuthGuard via passport) is available. Use this
 * interceptor globally; AuditService.log() then reads context implicitly.
 *
 * Non-HTTP execution contexts (e.g., bull jobs) are passed through with
 * no CLS write — the caller is responsible for setting context there.
 */
@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<AuthedRequest>();

    // The CorrelationIdMiddleware already seeded the CLS context (incl. a
    // generated correlationId) before guards ran. Merge into that context
    // instead of replacing it wholesale, so we don't drop the correlationId
    // on requests that arrive without an x-request-id header.
    let existing: AuditContext = {};
    try {
      existing = this.cls.get<AuditContext>(AUDIT_CLS_KEY) ?? {};
    } catch {
      // CLS not active yet — start from an empty context.
    }

    const headerCorrelationId =
      (req.headers?.['x-request-id'] as string | undefined) ?? undefined;
    const ctx: AuditContext = {
      ...existing,
      correlationId: headerCorrelationId ?? existing.correlationId,
      ip: req.ip ?? req.socket?.remoteAddress ?? existing.ip,
      userAgent:
        (req.headers?.['user-agent'] as string | undefined) ??
        existing.userAgent,
      actorId: req.user?.sub ?? existing.actorId,
    };

    try {
      this.cls.set(AUDIT_CLS_KEY, ctx);
    } catch {
      // CLS not active for this request — fall through silently
    }
    return next.handle();
  }
}
