import { Injectable } from '@nestjs/common';
import { Prisma, type AuditCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditWriteData = {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  ip?: string | null;
  userAgent?: string | null;
  subjectUserId?: string | null;
  category?: AuditCategory | null;
  reason?: string | null;
  changes?: Prisma.InputJsonValue | null;
};

@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  // This repository is the single layer that owns normalization: callers
  // (AuditService) pass values through verbatim — possibly undefined — and we
  // coalesce nullish to DB-friendly null / Prisma.JsonNull here. Keeping this
  // in one place avoids the double-coalescing the service used to duplicate.
  create(data: AuditWriteData) {
    return this.createIn(this.prisma, data);
  }

  // `client` is the PrismaService or a transaction client: the trail of a
  // change is written through the same transaction as the change itself.
  createIn(
    client: Prisma.TransactionClient | PrismaService,
    data: AuditWriteData,
  ) {
    return client.auditEvent.create({
      data: {
        actorId: data.actorId ?? null,
        action: data.action,
        entity: data.entity,
        entityId: data.entityId ?? null,
        metadata: data.metadata ?? Prisma.JsonNull,
        ip: data.ip ?? null,
        userAgent: data.userAgent ?? null,
        subjectUserId: data.subjectUserId ?? null,
        category: data.category ?? null,
        reason: data.reason ?? null,
        changes: data.changes ?? Prisma.JsonNull,
      },
    });
  }
}
