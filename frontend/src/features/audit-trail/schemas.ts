import { z } from 'zod';

/** Espelha o contrato da trilha do backend (`audit-trail.schema.ts`, C7). */

export const AUDIT_CATEGORIES = ['PERSON', 'ASSIGNMENT', 'SCHEDULE', 'STRUCTURE', 'PERMISSIONS'] as const;
export const auditCategorySchema = z.enum(AUDIT_CATEGORIES);
export type AuditCategory = z.infer<typeof auditCategorySchema>;

export const auditRefSchema = z.object({ id: z.string(), name: z.string() });
export type AuditRef = z.infer<typeof auditRefSchema>;

export const auditValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), auditRefSchema]);
export type AuditValue = z.infer<typeof auditValueSchema>;

export const fieldChangeSchema = z.object({
  field: z.string(),
  before: auditValueSchema,
  after: auditValueSchema,
});
export type FieldChange = z.infer<typeof fieldChangeSchema>;

export const auditTrailEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  action: z.string(),
  category: auditCategorySchema.nullable(),
  actor: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  subject: z
    .object({ id: z.string(), name: z.string().nullable(), registration: z.string().nullable() })
    .nullable(),
  reason: z.string().nullable(),
  /** `null` = registro anterior à trilha com antes e depois. */
  changes: fieldChangeSchema.array().nullable(),
});
export type AuditTrailEntry = z.infer<typeof auditTrailEntrySchema>;

export const auditTrailPageSchema = z.object({
  items: auditTrailEntrySchema.array(),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AuditTrailPage = z.infer<typeof auditTrailPageSchema>;

/** Espelha o contrato "Vínculos" do backend (`person-assignments.schema.ts`, CV6). */

const civilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const personAssignmentSchema = z.object({
  id: z.string(),
  sector: auditRefSchema.nullable(),
  shift: auditRefSchema.nullable(),
  level: auditRefSchema.nullable(),
  /** `null` = anterior ao histórico. */
  from: civilDateSchema.nullable(),
  /** `null` = vínculo atual. */
  to: civilDateSchema.nullable(),
});
export type PersonAssignment = z.infer<typeof personAssignmentSchema>;

export const personAssignmentsSchema = z.object({ items: personAssignmentSchema.array() });
export type PersonAssignments = z.infer<typeof personAssignmentsSchema>;
