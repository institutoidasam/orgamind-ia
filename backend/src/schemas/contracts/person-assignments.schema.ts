import { z } from 'zod';
import { civilDateSchema } from './civil-date.schema';

/**
 * Vínculos da pessoa (Lote C, CV6): o histórico de setor, turno e nível, com a
 * linha aberta primeiro e depois por fim decrescente. Nomes de setor, turno e
 * nível saem como estão (não são nome de pessoa, GV7).
 */
export const assignmentRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const personAssignmentSchema = z.object({
  id: z.string(),
  sector: assignmentRefSchema.nullable(),
  shift: assignmentRefSchema.nullable(),
  level: assignmentRefSchema.nullable(),
  /** `null` = anterior ao histórico. */
  from: civilDateSchema.nullable(),
  /** `null` = vínculo atual. */
  to: civilDateSchema.nullable(),
});

export const personAssignmentsSchema = z.object({
  items: personAssignmentSchema.array(),
});

export type PersonAssignment = z.infer<typeof personAssignmentSchema>;
export type PersonAssignments = z.infer<typeof personAssignmentsSchema>;
