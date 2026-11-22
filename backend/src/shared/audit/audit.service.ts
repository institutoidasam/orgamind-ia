import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma, type AuditCategory } from '@prisma/client';
import { AuditRepository } from './audit.repository';
import {
  categoryOfAction,
  maskEmail,
  maskPhone,
  type AuditChange,
  type FieldChange,
} from './audit-change';

export type AuditContext = {
  actorId?: string;
  ip?: string;
  userAgent?: string;
  correlationId?: string;
};

export const AUDIT_CLS_KEY = 'audit';

export type AuditLogOptions = {
  subjectUserId?: string | null;
  /** Omitido: derivada da ação (`categoryOfAction`); `null` força sem categoria. */
  category?: AuditCategory | null;
};

const MASK_BY_FIELD: ReadonlyMap<string, (value: string) => string | null> =
  new Map([
    ['phone', maskPhone],
    ['email', maskEmail],
  ]);

// Entrada sem dígito nem '@': as duas máscaras a tratam como inválida e devolvem
// a máscara vazia ('••••' no telefone, '•••' no e-mail).
const NOT_A_STRING = '?';

/**
 * Segunda barreira de máscara: telefone e e-mail nunca chegam crus à trilha,
 * mesmo que o chamador esqueça de mascarar (`maskPhone`/`maskEmail` são
 * idempotentes sobre valor já mascarado). Valor não nulo que não é string
 * (número, objeto) vira a máscara vazia, nunca passa cru.
 */
function maskSensitive(item: FieldChange): FieldChange {
  const mask = MASK_BY_FIELD.get(item.field);
  if (!mask) return item;
  const apply = (value: FieldChange['before']) => {
    if (value === null) return null;
    return mask(typeof value === 'string' ? value : NOT_A_STRING);
  };
  return { ...item, before: apply(item.before), after: apply(item.after) };
}

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
    // Same call signature as always (entityId?, metadata?, opts?): `opts` is the
    // optional 5th argument. Declared as a rest tuple to stay within max-params.
    ...rest: [
      entityId?: string,
      metadata?: Record<string, unknown>,
      opts?: AuditLogOptions,
    ]
  ): Promise<void> {
    const [entityId, metadata, opts] = rest;
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
        subjectUserId: opts?.subjectUserId,
        category:
          opts?.category === undefined
            ? categoryOfAction(action)
            : opts.category,
      });
    } catch (err: unknown) {
      this.logger.error(
        { err, action, entity, entityId },
        'Failed to write audit event',
      );
    }
  }

  /**
   * Trail of a change, written through the caller's transaction `tx` so the
   * change and its trail commit or roll back together. Unlike `log`, errors
   * PROPAGATE: a change must never be saved without its trail. The actor is
   * `change.actorId` (explicit); CLS only supplies ip and user-agent. `phone`
   * and `email` fields are masked again here before writing.
   */
  async recordChange(
    tx: Prisma.TransactionClient,
    change: AuditChange,
  ): Promise<void> {
    const ctx = this.readContext();
    await this.repo.createIn(tx, {
      actorId: change.actorId,
      action: change.action,
      entity: change.entity,
      entityId: change.entityId,
      category: change.category,
      subjectUserId: change.subjectUserId,
      reason: change.reason,
      changes: change.changes.map(maskSensitive),
      metadata: change.metadata as Prisma.InputJsonValue | undefined,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
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
