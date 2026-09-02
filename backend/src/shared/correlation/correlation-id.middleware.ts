import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import { AUDIT_CLS_KEY, type AuditContext } from '../audit/audit.service';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers['x-request-id'] as string) || randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);

    // Seed CLS with what we know now. AuditContextInterceptor will refresh
    // this after JwtAuthGuard so `actorId` is populated.
    try {
      const ctx: AuditContext = {
        correlationId: id,
        ip: req.ip ?? req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'] as string | undefined,
      };
      this.cls.set(AUDIT_CLS_KEY, ctx);
    } catch {
      // CLS context not yet active; interceptor will populate later
    }
    next();
  }
}
