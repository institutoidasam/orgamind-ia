import { z } from 'zod';
import { civilDateSchema } from './civil-date.schema';

/**
 * Consulta da trilha (C7). Só estes campos saem da API: `metadata`, ip,
 * user-agent e valores sem máscara nunca fazem parte da resposta (GC2).
 */
export const auditCategorySchema = z.enum([
  'PERSON',
  'ASSIGNMENT',
  'SCHEDULE',
  'STRUCTURE',
  'PERMISSIONS',
]);

export const auditValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ id: z.string(), name: z.string() }),
]);

export const fieldChangeSchema = z.object({
  field: z.string(),
  before: auditValueSchema,
  after: auditValueSchema,
});

export const auditTrailEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  action: z.string(),
  category: auditCategorySchema.nullable(),
  actor: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  subject: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      registration: z.string().nullable(),
    })
    .nullable(),
  reason: z.string().nullable(),
  /** `null` = registro anterior à trilha com antes e depois. */
  changes: fieldChangeSchema.array().nullable(),
});

/** Teto de `pageSize`: a tela geral usa 50, o histórico da pessoa 20. */
export const AUDIT_TRAIL_MAX_PAGE_SIZE = 100;

export const auditTrailQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  from: civilDateSchema.optional(),
  to: civilDateSchema.optional(),
  category: auditCategorySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_TRAIL_MAX_PAGE_SIZE)
    .default(50),
});

export const personHistoryQuerySchema = auditTrailQuerySchema.pick({
  page: true,
  pageSize: true,
});

export const auditTrailPageSchema = z.object({
  items: auditTrailEntrySchema.array(),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

export type AuditTrailEntry = z.infer<typeof auditTrailEntrySchema>;
export type AuditTrailQuery = z.infer<typeof auditTrailQuerySchema>;
export type PersonHistoryQuery = z.infer<typeof personHistoryQuerySchema>;
export type AuditTrailPage = z.infer<typeof auditTrailPageSchema>;
